import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { PayAdvanceStore, TenantDatabase, contractScope } from '@machvon/db';
import type { AdvanceResult, AdvanceView, ContractScopes } from '@machvon/db';
import { DomainError, asUuid, vietnamDateOf } from '@machvon/kernel';
import type { EffectiveAccess, TenantContext } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { encodeCursor, parsePageRequest } from '../../pagination';
import { CurrentTenant } from '../../tenant-context.decorator';
import { advanceView, advanceWarnings, planView } from './advance-view';
import type { AdvancePermissions } from './advance-view';

const REQUEST_PERMISSION = PERMISSIONS.requestAdvance;
const CANCEL_PERMISSION = PERMISSIONS.cancelAdvance;
const RECOVER_PERMISSION = PERMISSIONS.recordAdvanceRecovery;
const READ_PERMISSION = PERMISSIONS.listAdvances;
const RESOURCE_TYPE = 'contract_advance';
const CLASSIFICATION = 'CONFIDENTIAL';

const PERMISSIONS_OF_ACTIONS: AdvancePermissions = { cancel: CANCEL_PERMISSION, recover: RECOVER_PERMISSION };

type AdvanceCommandResult = Schemas['PayAdvanceCommandResult'];

const scopesFor = (access: EffectiveAccess, permission: string, now: Date): ContractScopes => ({ update: contractScope(access, permission, now), read: contractScope(access, READ_PERMISSION, now) });

/** What a command answers: the usual result of a command and the figures the server worked out, with what the caller should know. */
function answer(scope: CommandScope, view: AdvanceView): AdvanceCommandResult {
  return {
    ...commandResult(scope, view.status, view.version, view.id),
    amount_vnd: view.amountVnd,
    cap_vnd: view.capVnd,
    cap_pct: view.capPct,
    cap_rule_version_id: view.capRuleVersionId,
    paid_vnd: view.paidVnd,
    recovered_vnd: view.recoveredVnd,
    outstanding_vnd: view.outstandingVnd,
    warnings: advanceWarnings(view),
  };
}

/** The audit row and the event of a command on an advance: identifiers, amounts and the status; the reason or the evidence is named, never repeated. */
export async function recordAdvanceTrail(scope: CommandScope, done: AdvanceResult, action: string, type: string, now: Date, extra: { reason?: string; recovery?: Record<string, unknown> } = {}): Promise<void> {
  const { view } = done;
  const facts = {
    contract_id: view.contract.id,
    contract_code: view.contract.code,
    project_id: view.projectId,
    party_id: view.party.id,
    tranche_no: view.trancheNo,
    kind: view.kind,
    amount_vnd: view.amountVnd,
    cap_vnd: view.capVnd,
    paid_vnd: view.paidVnd,
    recovered_vnd: view.recoveredVnd,
    outstanding_vnd: view.outstandingVnd,
    ...(extra.recovery ?? {}),
  };
  await scope.audit({
    action,
    resourceType: RESOURCE_TYPE,
    resourceId: view.id,
    classification: CLASSIFICATION,
    ...(extra.reason === undefined ? {} : { reason: extra.reason }),
    diff: { from_status: done.fromStatus, to_status: view.status, ...facts },
  });
  await scope.emit({
    aggregateType: RESOURCE_TYPE,
    aggregateId: view.id,
    aggregateVersion: view.version,
    type,
    schemaVersion: 1,
    payload: { tenant_id: scope.tenant.tenantId, advance_id: view.id, ...facts, status: view.status, from_status: done.fromStatus, version: view.version, actor_id: scope.tenant.membershipId, occurred_at: now.toISOString() },
    eventKey: `${RESOURCE_TYPE}:${view.id}:${view.version}`,
  });
}

/**
 * The advance of a contract (ST-PAY-004, PAY 3.2): planned on a contract in force, under a guarantee and within the cap the rule of the day gives the work of the member (the server works the cap
 * out and no API takes it from the client); cancelled while it is only planned or asked for; recovered outside the payments with a basis and evidence. A request for the Treasury follows from a
 * planned advance as a payment request of the ADVANCE kind (ST-PAY-002, ST-PAY-003).
 */
@Controller()
export class AdvanceController {
  private readonly advances = new PayAdvanceStore();

  @Post('contracts/:id/advances')
  @HttpCode(200)
  @OperationId('requestAdvance')
  @Command({ operation: 'requestAdvance' })
  async request(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['PayRequestAdvance']): Promise<AdvanceCommandResult> {
    const now = new Date();
    const done = await this.advances.request(
      scope.tx,
      id.toLowerCase(),
      { partyId: body.party_id, kind: body.kind, amountVnd: body.amount_vnd, guaranteeId: body.guarantee_id, allocationLineId: body.allocation_line_id, trancheNo: body.tranche_no },
      scope.tenant.membershipId,
      scopesFor(access, REQUEST_PERMISSION, now),
      now,
    );
    await recordAdvanceTrail(scope, done, 'advance.planned', 'pay.advance.planned.v1', now);
    return answer(scope, done.view);
  }

  @Post('advances/:id/cancel')
  @HttpCode(200)
  @OperationId('cancelAdvance')
  @Command({ operation: 'cancelAdvance', versioned: true })
  async cancel(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['PayCancelAdvance']): Promise<AdvanceCommandResult> {
    const now = new Date();
    const done = await this.advances.cancel(scope.tx, id.toLowerCase(), scope.expectedVersion ?? 0, body.reason, scope.tenant.membershipId, scopesFor(access, CANCEL_PERMISSION, now));
    await recordAdvanceTrail(scope, done, 'advance.cancelled', 'pay.advance.cancelled.v1', now, { reason: body.reason.trim() });
    return answer(scope, done.view);
  }

  @Post('advances/:id/recoveries')
  @HttpCode(200)
  @OperationId('recordAdvanceRecovery')
  @Command({ operation: 'recordAdvanceRecovery', versioned: true })
  async recover(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['PayRecordAdvanceRecovery']): Promise<AdvanceCommandResult> {
    const now = new Date();
    const done = await this.advances.recordRecovery(
      scope.tx,
      id.toLowerCase(),
      scope.expectedVersion ?? 0,
      { amountVnd: body.amount_vnd, basis: body.basis, sourceRefId: body.source_ref_id, evidenceDocumentVersionId: body.evidence_document_version_id, requestId: scope.requestId },
      scope.tenant.membershipId,
      scopesFor(access, RECOVER_PERMISSION, now),
    );
    await recordAdvanceTrail(scope, done, 'advance.recovered', 'pay.advance.recovered.v1', now, {
      recovery: { recovery_amount_vnd: body.amount_vnd, basis: body.basis, source_ref_id: body.source_ref_id ?? null, evidence_document_version_id: body.evidence_document_version_id.toLowerCase() },
    });
    return answer(scope, done.view);
  }
}

/** The advances in the scope of the caller and the plan of the recovery of one (the right to read them is `advance.read`). */
@Controller()
export class AdvanceReadsController {
  private readonly advances = new PayAdvanceStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get('advances')
  @OperationId('listAdvances')
  async list(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Query('limit') limit?: unknown,
    @Query('cursor') cursor?: unknown,
    @Query('contract_id') contractId?: unknown,
    @Query('status') status?: unknown,
  ): Promise<{ items: Array<Record<string, unknown>>; next_cursor: string | null; as_of: string }> {
    const filter = contractId === undefined ? undefined : typeof contractId === 'string' ? asUuid(contractId) : undefined;
    if (contractId !== undefined && filter === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'contract_id');
    if (status !== undefined && typeof status !== 'string') throw new DomainError('VALIDATION_FAILED', 422, 'status');
    const request = parsePageRequest(limit, cursor);
    const now = new Date();
    const today = vietnamDateOf(now);
    const rows = await this.database.withTenant(tenant, (tx) =>
      this.advances.list(tx, contractScope(access, READ_PERMISSION, now), {
        contractId: filter?.toLowerCase(),
        status: status as string | undefined,
        limit: request.limit + 1,
        after: request.after === undefined ? undefined : { createdAt: request.after.code, id: request.after.id },
      }),
    );
    const shown = rows.slice(0, request.limit);
    const last = shown[shown.length - 1];
    return {
      items: shown.map((row) => advanceView(row, access, now, PERMISSIONS_OF_ACTIONS, today)),
      next_cursor: rows.length > request.limit && last !== undefined ? encodeCursor({ code: last.createdAt, id: last.id }) : null,
      as_of: now.toISOString(),
    };
  }

  @Get('advances/:id/recovery-plan')
  @OperationId('getAdvanceRecoveryPlan')
  async plan(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    const now = new Date();
    const found = await this.database.withTenant(tenant, (tx) => this.advances.plan(tx, id.toLowerCase(), contractScope(access, READ_PERMISSION, now)));
    // An advance in another tenant or outside the scope of the caller is indistinguishable from one that does not exist.
    if (found === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return planView(found, access, now, PERMISSIONS_OF_ACTIONS, vietnamDateOf(now));
  }
}
