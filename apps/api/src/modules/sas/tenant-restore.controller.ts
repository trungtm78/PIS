import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ControlDatabase, TenantRestoreStore, actingAsTenant, tenantOfRestore } from '@machvon/db';
import type { ApprovalEffects, RestoreRow, TenantRestoreEngine } from '@machvon/db';
import { DomainError, RESTORE_RPO_TARGET_SECONDS, RESTORE_RTO_TARGET_SECONDS } from '@machvon/kernel';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import { Command, Scope } from '../../command.decorator';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { OperationId } from '../../operation-id.decorator';
import { encodeCursor, parsePageRequest } from '../../pagination';

/** Where the restore engine is provided to the restore commands and reads: the MOCK where no real data is held, none where it is (a real one is bound when the infrastructure spike has measured it). */
export const RESTORE_ENGINE = Symbol('RESTORE_ENGINE');

export function restoreView(row: RestoreRow): Schemas['TenantRestore'] {
  return {
    id: row.id,
    recovery_point: row.recoveryPoint.toISOString(),
    target: row.target,
    reason: row.reason,
    status: row.status,
    requested_by: row.requestedBy,
    requested_at: row.requestedAt.toISOString(),
    decided_by: row.decidedBy,
    approved_by: row.approvedBy,
    decided_at: row.decidedAt?.toISOString() ?? null,
    decision_reason: row.decisionReason,
    started_at: row.startedAt?.toISOString() ?? null,
    completed_at: row.completedAt?.toISOString() ?? null,
    restored_to: row.restoredTo?.toISOString() ?? null,
    sandbox_ref: row.sandboxRef,
    error_code: row.errorCode,
    verification_report_ref: row.verificationReportRef,
    verification_report: row.report,
    version: row.version,
  };
}

function effectsOf(scope: CommandScope): ApprovalEffects {
  return { actor: scope.tenant.membershipId, audit: (entry) => scope.audit(entry), emit: (event) => scope.emit(event) };
}

/**
 * The restore of one tenant to a recovery point on the control plane (ST-SAS-019, SAS-21; `system.tenant.manage`, the list needs `system.tenant.read`): a System Admin asks for a copy in a sandbox, or over the data of the tenant
 * while it is Suspended, a second one decides (never the one who asked), and the worker (`tenant-restore`) makes it and verifies it. The commands act as the tenant while they write, audit and emit.
 */
@Controller('system')
export class TenantRestoreController {
  private readonly store = new TenantRestoreStore();

  constructor(
    @Inject(ControlDatabase) private readonly control: ControlDatabase,
    @Inject(RESTORE_ENGINE) private readonly engine: TenantRestoreEngine,
  ) {}

  @Get('tenants/:tenantId/restore-requests')
  @OperationId('listTenantRestoreRequests')
  async list(@Param('tenantId', ParseUUIDPipe) tenantId: string, @Query('limit') limit?: unknown, @Query('cursor') cursor?: unknown): Promise<Schemas['TenantRestorePage']> {
    const page = parsePageRequest(limit, cursor);
    if (page.after !== undefined && Number.isNaN(Date.parse(page.after.code))) throw new DomainError('VALIDATION_FAILED', 422, 'cursor');
    const window = await this.engine.window(tenantId, new Date());
    return this.control.withTenantOf(tenantId, async (tx) => {
      const [tenant] = await tx.query<{ status: Schemas['TenantRestorePage']['tenant_status']; version: string }>('select status, version::text as version from machvon.tenant where id = $1::uuid', [tenantId]);
      if (tenant === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
      const rows = await this.store.list(tx, { limit: page.limit + 1, after: page.after === undefined ? undefined : { requestedAt: page.after.code, id: page.after.id } });
      const shown = rows.slice(0, page.limit);
      const last = shown[shown.length - 1];
      return {
        tenant_status: tenant.status,
        tenant_version: Number(tenant.version),
        recovery_window: window === undefined ? null : { earliest: window.earliest.toISOString(), latest: window.latest.toISOString() },
        rpo_target_seconds: RESTORE_RPO_TARGET_SECONDS,
        rto_target_seconds: RESTORE_RTO_TARGET_SECONDS,
        items: shown.map(restoreView),
        next_cursor: rows.length > page.limit && last !== undefined ? encodeCursor({ code: last.requestedAt.toISOString(), id: last.id }) : null,
      };
    });
  }

  @Post('tenants/:tenantId/restore-requests')
  @HttpCode(201)
  @OperationId('requestTenantRestore')
  @Command({ operation: 'requestTenantRestore', plane: 'control' })
  async request(@Scope() scope: CommandScope, @Param('tenantId', ParseUUIDPipe) tenantId: string, @Body() body: Schemas['TenantRestoreRequest']): Promise<CommandResult> {
    const now = new Date();
    const window = await this.engine.window(tenantId, now);
    return actingAsTenant(scope.tx, tenantId, scope.tenant.tenantId, async () => {
      const row = await this.store.request(scope.tx, effectsOf(scope), {
        recoveryPoint: new Date(body.recovery_point),
        target: body.target,
        reason: body.reason,
        requestedBy: scope.tenant.membershipId,
        window,
        now,
      });
      return commandResult(scope, 'PENDING_APPROVAL', row.version, row.id);
    });
  }

  @Post('restore-requests/:restoreId/decision')
  @HttpCode(202)
  @OperationId('decideTenantRestore')
  @Command({ operation: 'decideTenantRestore', plane: 'control', versioned: true })
  async decide(@Scope() scope: CommandScope, @Param('restoreId', ParseUUIDPipe) restoreId: string, @Body() body: Schemas['Decision']): Promise<CommandResult> {
    // The decision of the contract is shared by every approval; a restore has no "return for rework": a change of mind is a new request.
    const decision = body.decision;
    if (decision === 'return') throw new DomainError('VALIDATION_FAILED', 422, 'decision', { extensions: { reason: 'DECISION_NOT_OFFERED' } });
    const tenantId = await tenantOfRestore(scope.tx, restoreId);
    if (tenantId === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const now = new Date();
    const window = await this.engine.window(tenantId, now);
    return actingAsTenant(scope.tx, tenantId, scope.tenant.tenantId, async () => {
      const row = await this.store.decide(scope.tx, effectsOf(scope), {
        restoreId,
        decision,
        decidedBy: scope.tenant.membershipId,
        reason: body.reason,
        evidenceIds: body.evidence_ids,
        expectedVersion: scope.expectedVersion ?? 0,
        window,
        now,
      });
      return commandResult(scope, row.status === 'Approved' ? 'APPROVED' : 'REJECTED', row.version, row.id);
    });
  }
}
