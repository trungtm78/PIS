import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { BidResultStore, DoaMatrixStore, TenantDatabase, projectScope } from '@machvon/db';
import type { BidResultFacts, BidResultLine } from '@machvon/db';
import { DomainError, RESULT_DOA_DOCUMENT_TYPE, asUuid } from '@machvon/kernel';
import type { EffectiveAccess, TenantContext } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import { enforceSod } from '../../sod-gate';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { assertWithinDelegation } from '../../doa-delegation';
import { OperationId } from '../../operation-id.decorator';
import { CurrentTenant } from '../../tenant-context.decorator';

const SUBMIT_PERMISSION = PERMISSIONS.submitProcurementResult;
const DECIDE_PERMISSION = PERMISSIONS.decideProcurementResult;
const READ_PERMISSION = PERMISSIONS.listProcurementResults;
const RESOURCE_TYPE = 'procurement_result';

const person = (who: { membershipId: string; displayName: string } | null): Record<string, unknown> | null => (who === null ? null : { membership_id: who.membershipId, display_name: who.displayName });

/** A result as the screen reads it: an allowlist of what it is. */
export function resultDto(line: BidResultLine): Record<string, unknown> {
  return {
    id: line.id,
    package: { id: line.package.id, code: line.package.code, budget_vnd: line.package.budgetVnd },
    outcome: line.outcome,
    winner: line.winner === null ? null : { id: line.winner.id, legal_name: line.winner.legalName },
    award_price_vnd: line.awardPriceVnd,
    evaluation_minutes: line.evaluationMinutes === null ? null : { document_id: line.evaluationMinutes.documentId, title: line.evaluationMinutes.title },
    decision_document_id: line.decisionDocumentId,
    status: line.status,
    submitted_by: person(line.submittedBy),
    submitted_at: line.submittedAt,
    decided_by: person(line.decidedBy),
    decided_at: line.decidedAt,
    comment: line.comment,
    version: line.version,
  };
}

/**
 * The result of the selection of a contractor (ST-BID-006, BID 3 F7). A proposer of the scope of `bid.result.submit` submits it for a package whose plan is in force: the award
 * is no more than the price of the package, goes to a contractor no restriction stops, and rests on an evaluation that was issued. An authority of the scope of
 * `bid.result.approve` who is not the proposer approves it on a decision document, within the delegation limit of the matrix when the tenant configured one for results, or turns it down
 * with the reason. The decision is a person's: no analysis made by a machine is read or written here. Status, approver and version are written by no body.
 */
@Controller()
export class ResultController {
  private readonly results = new BidResultStore();
  private readonly doa = new DoaMatrixStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Post('procurement-results')
  @HttpCode(200)
  @OperationId('submitProcurementResult')
  @Command({ operation: 'submitProcurementResult' })
  async submit(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['BidResultSubmit']): Promise<CommandResult> {
    const now = new Date();
    const made = await this.results.submit(
      scope.tx,
      { packageId: body.package_id.toLowerCase(), outcome: body.outcome, winnerContractorId: body.winner_contractor_id, awardPriceVnd: body.award_price_vnd, evaluationReportId: body.evaluation_report_id },
      scope.tenant.membershipId,
      projectScope(access, SUBMIT_PERMISSION, now),
      now,
    );
    // G4-1: proposing the result of a package is the award duty of the separation-of-duties matrix.
    await enforceSod(scope, this.database, { taking: 'bid.award', subjectKind: 'bid_result', recordId: made.id, command: 'submitProcurementResult' }, now);
    const facts = {
      package_id: made.packageId,
      project_id: made.projectId,
      outcome: made.outcome,
      winner_contractor_id: made.winnerContractorId,
      award_price_vnd: made.awardPriceVnd,
      budget_vnd: made.budgetVnd,
      evaluation_minutes_document_id: made.evaluationMinutesDocumentId,
    };
    await scope.audit({ action: 'procurement_result.submitted', resourceType: RESOURCE_TYPE, resourceId: made.id, classification: 'CONFIDENTIAL', diff: { code: made.packageCode, ...facts } });
    await scope.emit({
      aggregateType: RESOURCE_TYPE,
      aggregateId: made.id,
      aggregateVersion: made.version,
      type: 'bid.result.submitted.v1',
      schemaVersion: 1,
      payload: { tenant_id: scope.tenant.tenantId, result_id: made.id, ...facts, status: made.status, version: made.version, actor_id: scope.tenant.membershipId, occurred_at: now.toISOString() },
      eventKey: `${RESOURCE_TYPE}:${made.id}:${made.version}`,
    });
    return commandResult(scope, made.status, made.version, made.id);
  }

  @Post('procurement-results/:id/decision')
  @HttpCode(200)
  @OperationId('decideProcurementResult')
  @Command({ operation: 'decideProcurementResult', versioned: true })
  async decide(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['BidResultDecision']): Promise<CommandResult> {
    const now = new Date();
    const done = await this.results.decide(
      scope.tx,
      id.toLowerCase(),
      scope.expectedVersion ?? 0,
      { decision: body.decision, decisionDocumentId: body.decision_document_id, comment: body.comment },
      scope.tenant.membershipId,
      projectScope(access, DECIDE_PERMISSION, now),
      now,
      { authorise: (facts) => this.limit(scope, access, facts, now) },
    );
    // Deciding the result is the sign-off duty of the matrix.
    await enforceSod(scope, this.database, { taking: 'bid.sign_off', subjectKind: 'bid_result', recordId: done.id, command: 'decideProcurementResult' }, now);
    const facts = {
      package_id: done.packageId,
      project_id: done.projectId,
      outcome: done.outcome,
      contractor_id: done.winnerContractorId,
      award_price_vnd: done.awardPriceVnd,
      decision_document_id: done.decisionDocumentId,
      decision: done.decision,
      package_status: done.packageStatus,
    };
    await scope.audit({
      action: done.status === 'APPROVED' ? 'procurement_result.approved' : 'procurement_result.rejected',
      resourceType: RESOURCE_TYPE,
      resourceId: done.id,
      classification: 'CONFIDENTIAL',
      ...(done.comment === null ? {} : { reason: done.comment }),
      diff: { code: done.packageCode, from_status: 'SUBMITTED', to_status: done.status, ...facts },
    });
    if (done.status === 'APPROVED') {
      // The contracts are drafted from this event: the package, the contractor, the price and the decision that awarded it, and nothing of how the evaluation was made.
      await scope.emit({
        aggregateType: RESOURCE_TYPE,
        aggregateId: done.id,
        aggregateVersion: done.version,
        type: 'bid.result.approved.v1',
        schemaVersion: 1,
        payload: { tenant_id: scope.tenant.tenantId, result_id: done.id, ...facts, status: done.status, version: done.version, actor_id: scope.tenant.membershipId, occurred_at: now.toISOString() },
        eventKey: `${RESOURCE_TYPE}:${done.id}:${done.version}`,
      });
    }
    return commandResult(scope, done.status, done.version, done.id);
  }

  @Get('procurement-results')
  @OperationId('listProcurementResults')
  async list(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Query('package_id') packageId?: unknown): Promise<{ items: Array<Record<string, unknown>>; as_of: string }> {
    const filter = packageId === undefined ? undefined : typeof packageId === 'string' ? asUuid(packageId) : undefined;
    if (packageId !== undefined && filter === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'package_id');
    const now = new Date();
    const lines = await this.database.withTenant(tenant, (tx) => this.results.list(tx, projectScope(access, READ_PERMISSION, now), { packageId: filter?.toLowerCase() }));
    return { items: lines.map(resultDto), as_of: now.toISOString() };
  }

  /** The delegation limit of the matrix for the value of the award, when the tenant configured one for results; a tenant that did not leaves the approval to the permission and its scope. */
  private limit(scope: CommandScope, access: EffectiveAccess, facts: BidResultFacts, now: Date): Promise<void> {
    return assertWithinDelegation(this.doa, scope, access, {
      documentType: RESULT_DOA_DOCUMENT_TYPE,
      permission: DECIDE_PERMISSION,
      amountVnd: facts.amountVnd,
      unitId: facts.ownerUnit.id,
      place: { ownerUnitPath: facts.ownerUnit.path, ownerUnitId: facts.ownerUnit.id, projectId: facts.projectId },
      now,
      unconfigured: 'ALLOW',
    });
  }
}
