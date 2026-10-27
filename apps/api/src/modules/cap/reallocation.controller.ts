import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { CapPlanStore, CapReallocationStore, TenantDatabase, reallocationAppliedEvent, reallocationRecord, reallocationScope } from '@machvon/db';
import type { ReallocationRow } from '@machvon/db';
import { DomainError, vietnamDateOf } from '@machvon/kernel';
import type { EffectiveAccess, TenantContext } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { encodeCursor, parsePageRequest } from '../../pagination';
import { CurrentTenant } from '../../tenant-context.decorator';
import { planPublishedEvent } from './plan-events';
import { unitAuthorizer } from './plan-approval.service';

const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;
const STATUS = /^(DRAFT|SUBMITTED|APPROVED|APPLIED|REJECTED|WITHDRAWN)$/;

/** The proposal as the contract exposes it (an allowlist). */
export function reallocationView(row: ReallocationRow): Record<string, unknown> {
  return {
    id: row.id,
    code: row.code,
    plan_year: row.planYear,
    scope_unit: { id: row.scopeUnitId, name: row.scopeUnitName },
    basis_snapshot_id: row.basisSnapshotId,
    source_capital_plan_id: row.sourceCapitalPlanId,
    reason: row.reason,
    status: row.status,
    decision_document_id: row.decisionDocumentId,
    resulting_capital_plan_id: row.resultingCapitalPlanId,
    submitted_by: row.submittedBy,
    approved_by: row.approvedBy,
    decision_reason: row.decisionReason,
    created_by: row.createdBy,
    created_at: row.createdAt,
    applied_at: row.appliedAt,
    version: row.version,
    total_vnd: row.totalVnd,
    lines: row.lines.map((line) => ({
      id: line.id,
      from_allocation_line_id: line.fromAllocationLineId,
      from_project: { id: line.fromProjectId, code: line.fromProjectCode, name: line.fromProjectName },
      to_allocation_line_id: line.toAllocationLineId,
      to_project: { id: line.toProjectId, code: line.toProjectCode, name: line.toProjectName },
      appropriation_id: line.appropriationId,
      amount_vnd: line.amountVnd,
      from_allocated_vnd: line.fromAllocatedVnd,
      to_allocated_vnd: line.toAllocatedVnd,
      rationale: line.rationale,
    })),
  };
}

/**
 * The reallocation of capital from slow to fast projects (ST-CAP-010, CAP 3.1 F5, CAP-19): a planner drafts a balanced move on a frozen disbursement snapshot, submits it, someone else decides, and an approver applies it
 * with a decision document as a new published revision of the plan, in one transaction. What is read here is the proposals whose unit lies in the scope of the caller.
 */
@Controller()
export class ReallocationController {
  private readonly store = new CapReallocationStore();
  private readonly plans = new CapPlanStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get('reallocation-proposals')
  @OperationId('listReallocationProposals')
  async list(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Query('status') status?: unknown,
    @Query('plan_year') planYear?: unknown,
    @Query('limit') limit?: unknown,
    @Query('cursor') cursor?: unknown,
  ): Promise<{ items: Array<Record<string, unknown>>; next_cursor: string | null; as_of: string }> {
    const request = parsePageRequest(limit, cursor);
    if (request.after !== undefined && (!TIMESTAMP.test(request.after.code) || Number.isNaN(Date.parse(request.after.code)))) throw invalid('cursor');
    if (status !== undefined && (typeof status !== 'string' || !STATUS.test(status))) throw invalid('status');
    if (planYear !== undefined && (typeof planYear !== 'string' || !/^\d{4}$/.test(planYear))) throw invalid('plan_year');
    const now = new Date();
    const rows = await this.database.withTenant(tenant, (tx) =>
      this.store.list(
        tx,
        { status: status as string | undefined, planYear: planYear === undefined ? undefined : Number(planYear) },
        reallocationScope(access, PERMISSIONS.listReallocationProposals, now),
        { limit: request.limit, after: request.after === undefined ? undefined : { createdAt: request.after.code, id: request.after.id } },
      ),
    );
    const shown = rows.slice(0, request.limit);
    const last = shown[shown.length - 1];
    return { items: shown.map(reallocationView), next_cursor: rows.length > request.limit && last !== undefined ? encodeCursor({ code: last.createdAt, id: last.id }) : null, as_of: vietnamDateOf(now) };
  }

  @Post('reallocation-proposals')
  @HttpCode(200)
  @OperationId('draftReallocationProposal')
  @Command({ operation: 'draftReallocationProposal' })
  async draft(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['CapReallocationProposal']): Promise<CommandResult> {
    const now = new Date();
    const made = await this.store.draft(scope.tx, {
      code: body.code,
      planYear: body.plan_year,
      scopeUnitId: body.scope_unit_id,
      basisSnapshotId: body.basis_snapshot_id,
      sourceCapitalPlanId: body.source_capital_plan_id,
      reason: body.reason,
      lines: body.lines.map((line) => ({ fromAllocationLineId: line.from_allocation_line_id, toProjectId: line.to_project_id, amountVnd: line.amount_vnd, rationale: line.rationale })),
      actor: scope.tenant.membershipId,
      authorize: unitAuthorizer(access, PERMISSIONS.draftReallocationProposal, now),
    });
    await scope.audit(reallocationRecord('drafted', made));
    return commandResult(scope, made.row.status, made.row.version, made.row.id);
  }

  @Post('reallocation-proposals/:id/submit')
  @HttpCode(200)
  @OperationId('submitReallocationProposal')
  @Command({ operation: 'submitReallocationProposal', versioned: true })
  async submit(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<CommandResult> {
    const now = new Date();
    const done = await this.store.submit(scope.tx, { id: id.toLowerCase(), expectedVersion: scope.expectedVersion ?? 0, actor: scope.tenant.membershipId, now, authorize: unitAuthorizer(access, PERMISSIONS.submitReallocationProposal, now) });
    await scope.audit(reallocationRecord('submitted', done));
    return commandResult(scope, done.row.status, done.row.version, done.row.id);
  }

  @Post('reallocation-proposals/:id/decision')
  @HttpCode(200)
  @OperationId('decideReallocationProposal')
  @Command({ operation: 'decideReallocationProposal', versioned: true })
  async decide(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['MdmDecision']): Promise<CommandResult> {
    const now = new Date();
    const done = await this.store.decide(scope.tx, {
      id: id.toLowerCase(),
      expectedVersion: scope.expectedVersion ?? 0,
      actor: scope.tenant.membershipId,
      now,
      authorize: unitAuthorizer(access, PERMISSIONS.decideReallocationProposal, now),
      decision: body.decision,
      reason: body.reason,
    });
    await scope.audit(reallocationRecord(body.decision === 'approve' ? 'approved' : body.decision === 'reject' ? 'rejected' : 'returned', done));
    return commandResult(scope, done.row.status, done.row.version, done.row.id);
  }

  @Post('reallocation-proposals/:id/apply')
  @HttpCode(200)
  @OperationId('applyReallocationProposal')
  @Command({ operation: 'applyReallocationProposal', versioned: true })
  async apply(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['CapApplyDecision']): Promise<CommandResult> {
    const now = new Date();
    const done = await this.store.apply(scope.tx, {
      id: id.toLowerCase(),
      expectedVersion: scope.expectedVersion ?? 0,
      actor: scope.tenant.membershipId,
      now,
      authorize: unitAuthorizer(access, PERMISSIONS.applyReallocationProposal, now),
      decisionDocumentId: body.decision_document_id,
    });
    await scope.audit(reallocationRecord('applied', done));
    // The revision that the application published is published like any other: its own audit row and its own event, which the project register reads to move the projects that now have money.
    await scope.audit({
      action: 'capital.plan_published',
      resourceType: 'capital_plan',
      resourceId: done.resultingPlanId,
      diff: {
        via: 'reallocation',
        proposal_id: done.row.id,
        revision: done.published.revision,
        plan_year: done.published.planYear,
        superseded_plan_id: done.published.supersededId,
        decision_document_id: done.published.decisionDocumentId,
        total_before_vnd: done.published.totalBeforeVnd,
        total_after_vnd: done.published.totalAfterVnd,
        transferred: done.transferred.map((entry) => ({ entry_type: entry.entryType, project_id: entry.projectId, allocation_line_id: entry.allocationLineId, amount_vnd: entry.amountVnd })),
      },
    });
    await scope.emit(reallocationAppliedEvent(done, scope.tenant.tenantId, scope.tenant.membershipId, now));
    const facts = await this.plans.publicationFacts(scope.tx, done.resultingPlanId);
    if (facts === undefined) throw new Error('a plan that was just published is not published');
    await scope.emit(planPublishedEvent(scope.tenant.tenantId, scope.tenant.membershipId, facts, done.published.version, now));
    return commandResult(scope, done.row.status, done.row.version, done.row.id);
  }
}
