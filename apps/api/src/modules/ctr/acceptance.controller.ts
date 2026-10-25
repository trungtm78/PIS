import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { CtrAcceptanceStore, TenantDatabase, contractScope } from '@machvon/db';
import type { ContractScopes, CtrAcceptanceResult } from '@machvon/db';
import { DomainError, asUuid, vietnamDateOf } from '@machvon/kernel';
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
import { acceptanceActionsOf, acceptanceView } from './acceptance-view';
import type { AcceptancePermissions } from './acceptance-view';

const CREATE_PERMISSION = PERMISSIONS.createAcceptance;
const SUBMIT_PERMISSION = PERMISSIONS.submitAcceptance;
const DECIDE_PERMISSION = PERMISSIONS.post_acceptances_id_decision;
const REVOKE_PERMISSION = PERMISSIONS.revokeAcceptance;
const READ_PERMISSION = PERMISSIONS.get_resources_acceptance;
const RESOURCE_TYPE = 'acceptance';
const CLASSIFICATION = 'INTERNAL';

const ACTION_PERMISSIONS: AcceptancePermissions = { submit: SUBMIT_PERMISSION, decide: DECIDE_PERMISSION, revoke: REVOKE_PERMISSION };

const scopesFor = (access: EffectiveAccess, permission: string, now: Date): ContractScopes => ({ update: contractScope(access, permission, now), read: contractScope(access, READ_PERMISSION, now) });

/**
 * The acceptance of work done under a contract (ST-CTR-009, CTR 3.4, BR-CTR-05). An approver drafts an acceptance from approved measurements, each line priced at the price of the revision in
 * force on the day; it is sent with the people who sign the paper and decided by someone other than whoever drafted or sent it. Approving needs, when the contract asks for them, approved quality
 * acceptance minutes (422 `QUALITY_ACCEPTANCE_REQUIRED`) and no open serious non-conformance on the work (422 `OPEN_CRITICAL_NCR`), keeps the accepted value within the value of the contract (422
 * `ACCEPTANCE_VALUE_EXCEEDS_CONTRACT`), and gives a measurement to one acceptance only (409 `MEASUREMENT_ALREADY_ACCEPTED`). The approval is sent to PAY as `ctr.acceptance.approved.v1` with a line
 * for each measurement; a revocation is refused while a payment request holds the acceptance (409 `ACCEPTANCE_ALREADY_CLAIMED`).
 */
@Controller()
export class AcceptanceController {
  private readonly acceptances = new CtrAcceptanceStore();

  @Post('contracts/:id/acceptances')
  @HttpCode(200)
  @OperationId('createAcceptance')
  @Command({ operation: 'createAcceptance' })
  async create(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['CtrCreateAcceptance']): Promise<CommandResult> {
    const now = new Date();
    const done = await this.acceptances.create(
      scope.tx,
      id.toLowerCase(),
      { measurementIds: body.measurement_ids, periodId: body.period_id, documentVersionId: body.document_version_id, qualityAcceptanceId: body.quality_acceptance_id },
      scope.tenant.membershipId,
      scopesFor(access, CREATE_PERMISSION, now),
      vietnamDateOf(now),
    );
    await this.written(scope, done, 'acceptance.drafted', 'ctr.acceptance.drafted.v1', now, {});
    return commandResult(scope, done.status, done.version, done.id);
  }

  @Post('acceptances/:id/submit')
  @HttpCode(200)
  @OperationId('submitAcceptance')
  @Command({ operation: 'submitAcceptance', versioned: true })
  async submit(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['CtrSubmitAcceptance']): Promise<CommandResult> {
    const now = new Date();
    const done = await this.acceptances.submit(scope.tx, id.toLowerCase(), scope.expectedVersion ?? 0, { signerRefs: body.signer_refs }, scope.tenant.membershipId, scopesFor(access, SUBMIT_PERMISSION, now));
    await this.written(scope, done, 'acceptance.submitted', 'ctr.acceptance.submitted.v1', now, { signer_count: body.signer_refs.length });
    return commandResult(scope, done.status, done.version, done.id);
  }

  @Post('acceptances/:id/decision')
  @HttpCode(200)
  @OperationId('post_acceptances_id_decision')
  @Command({ operation: 'post_acceptances_id_decision', versioned: true })
  async decide(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['Decision']): Promise<CommandResult> {
    const now = new Date();
    const done = await this.acceptances.decide(
      scope.tx,
      id.toLowerCase(),
      scope.expectedVersion ?? 0,
      { decision: body.decision, reason: body.reason, evidenceIds: body.evidence_ids },
      scope.tenant.membershipId,
      scopesFor(access, DECIDE_PERMISSION, now),
    );
    // Approving tells PAY (once: the event key is the version it was approved at); rejecting and giving back are audited, with the reason, and send no event.
    const action = done.decision === 'approve' ? 'approved' : done.decision === 'return' ? 'returned' : 'rejected';
    await this.written(scope, done, `acceptance.${action}`, done.decision === 'approve' ? 'ctr.acceptance.approved.v1' : undefined, now, { decision: done.decision, evidence_ids: done.evidenceIds }, done.reason);
    return commandResult(scope, done.status, done.version, done.id);
  }

  @Post('acceptances/:id/revoke')
  @HttpCode(200)
  @OperationId('revokeAcceptance')
  @Command({ operation: 'revokeAcceptance', versioned: true })
  async revoke(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['CtrRevokeAcceptance']): Promise<CommandResult> {
    const now = new Date();
    const done = await this.acceptances.revoke(
      scope.tx,
      id.toLowerCase(),
      scope.expectedVersion ?? 0,
      { reason: body.reason, approvalDocumentVersionId: body.approval_document_version_id },
      scope.tenant.membershipId,
      scopesFor(access, REVOKE_PERMISSION, now),
    );
    await this.written(scope, done, 'acceptance.revoked', 'ctr.acceptance.revoked.v1', now, { approval_document_version_id: body.approval_document_version_id.toLowerCase() }, body.reason);
    return commandResult(scope, done.status, done.version, done.id);
  }

  /** The audit row and the event of a command: ids, amounts, dates and statuses, with a line for each measurement for PAY; never the words of a reason beyond the row that keeps them. */
  private async written(scope: CommandScope, done: CtrAcceptanceResult, action: string, type: string | undefined, now: Date, extra: Record<string, unknown>, reason?: string): Promise<void> {
    const facts = {
      acceptance_no: done.acceptanceNo,
      contract_id: done.contractId,
      contract_code: done.contractCode,
      project_id: done.projectId,
      accepted_on: done.acceptedOn,
      accepted_amount_vnd: done.acceptedAmountVnd,
      accepted_total_vnd: done.acceptedTotalVnd,
      quality_acceptance_id: done.qualityAcceptanceId,
      lines: done.lines.map((line) => ({
        line_id: line.id,
        measurement_id: line.measurementId,
        boq_item_id: line.boqItemId,
        party_id: line.partyId,
        contract_revision_id: line.contractRevisionId,
        quantity: line.quantity,
        unit_price_snapshot: line.unitPriceSnapshot,
        amount_vnd: line.amountVnd,
        retention_pct_snapshot: line.retentionPctSnapshot,
      })),
    };
    await scope.audit({
      action,
      resourceType: RESOURCE_TYPE,
      resourceId: done.id,
      classification: CLASSIFICATION,
      ...(reason === undefined ? {} : { reason }),
      diff: { from_status: done.fromStatus, to_status: done.status, ...facts, ...extra },
    });
    if (type === undefined) return;
    await scope.emit({
      aggregateType: RESOURCE_TYPE,
      aggregateId: done.id,
      aggregateVersion: done.version,
      type,
      schemaVersion: 1,
      payload: { tenant_id: scope.tenant.tenantId, acceptance_id: done.id, ...facts, status: done.status, from_status: done.fromStatus, version: done.version, actor_id: scope.tenant.membershipId, occurred_at: now.toISOString(), ...extra },
      eventKey: `${RESOURCE_TYPE}:${done.id}:${done.version}`,
    });
  }
}

/** The acceptances of the contracts in the scope of the caller (the right to read them is `acceptance.read`). */
@Controller('resources/acceptance')
export class AcceptanceReadsController {
  private readonly acceptances = new CtrAcceptanceStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get()
  @OperationId('get_resources_acceptance')
  async list(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Query('limit') limit?: unknown,
    @Query('cursor') cursor?: unknown,
    @Query('contract_id') contractId?: unknown,
  ): Promise<{ items: Array<Record<string, unknown>>; next_cursor: string | null; as_of: string }> {
    const filter = contractId === undefined ? undefined : typeof contractId === 'string' ? asUuid(contractId) : undefined;
    if (contractId !== undefined && filter === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'contract_id');
    const request = parsePageRequest(limit, cursor);
    const now = new Date();
    const rows = await this.database.withTenant(tenant, (tx) =>
      this.acceptances.list(tx, contractScope(access, READ_PERMISSION, now), {
        contractId: filter?.toLowerCase(),
        limit: request.limit + 1,
        after: request.after === undefined ? undefined : { createdAt: request.after.code, id: request.after.id },
      }),
    );
    const shown = rows.slice(0, request.limit);
    const last = shown[shown.length - 1];
    return {
      items: shown.map((line) => acceptanceView(line, acceptanceActionsOf(line, access, now, ACTION_PERMISSIONS, tenant.membershipId))),
      // The ordering key of the page is the creation time and the id, which the store compares as a pair.
      next_cursor: rows.length > request.limit && last !== undefined ? encodeCursor({ code: last.createdAt, id: last.id }) : null,
      as_of: now.toISOString(),
    };
  }

  @Get(':id')
  @OperationId('get_resources_acceptance_id')
  async get(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    const now = new Date();
    const line = await this.database.withTenant(tenant, (tx) => this.acceptances.find(tx, id.toLowerCase(), contractScope(access, READ_PERMISSION, now)));
    // An acceptance in another tenant or outside the scope of the caller is indistinguishable from one that does not exist.
    if (line === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return acceptanceView(line, acceptanceActionsOf(line, access, now, ACTION_PERMISSIONS, tenant.membershipId));
  }
}
