import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ControlDatabase, PlacementMigrationStore, actingAsTenant, migrationReconciliation, targetIntact, tenantOfMigration } from '@machvon/db';
import type { ApprovalEffects, MigrationRow, PlacementChoice, PlacementMover } from '@machvon/db';
import { DomainError, freezeEndsAt, observationEndsAt } from '@machvon/kernel';
import type { CopyReconciliation } from '@machvon/kernel';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import { Command, Scope } from '../../command.decorator';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { OperationId } from '../../operation-id.decorator';
import { encodeCursor, parsePageRequest } from '../../pagination';

/** Where the mover of placements is provided to the commands and to the worker: the stand-in until a real one is bound (D02), none in production. */
export const PLACEMENT_MOVER = Symbol('PLACEMENT_MOVER');

const iso = (value: Date | null): string | null => value?.toISOString() ?? null;

export function migrationView(row: MigrationRow): Schemas['PlacementMigration'] {
  return {
    id: row.id,
    tenant_id: row.tenantId,
    from_placement_id: row.fromPlacementId,
    to_placement_id: row.toPlacementId,
    status: row.status,
    write_freeze_max_minutes: row.writeFreezeMaxMinutes,
    planned_window_start: row.plannedWindowStart.toISOString(),
    reason: row.reason,
    requested_by: row.requestedBy,
    cutover_approved_by: row.cutoverApprovedBy,
    cutover_approved_at: iso(row.cutoverApprovedAt),
    approval_reason: row.approvalReason,
    write_freeze_started_at: iso(row.writeFreezeStartedAt),
    // Writes are refused until this instant, while the cutover is frozen.
    write_frozen_until: row.status === 'CutoverFrozen' && row.writeFreezeStartedAt !== null ? freezeEndsAt(row.writeFreezeStartedAt, row.writeFreezeMaxMinutes).toISOString() : null,
    checksum_match: row.checksumMatch,
    verified_at: iso(row.verifiedAt),
    verification_report_ref: row.verificationReportRef,
    switched_at: iso(row.switchedAt),
    observation_ends_at: row.switchedAt === null ? null : observationEndsAt(row.switchedAt).toISOString(),
    completed_at: iso(row.completedAt),
    ended_at: iso(row.endedAt),
    ended_by: row.endedBy,
    end_reason: row.endReason,
    last_error_code: row.lastErrorCode,
    target_discarded_at: iso(row.targetDiscardedAt),
    source_purge_due_at: iso(row.sourcePurgeDueAt),
    source_purged_at: iso(row.sourcePurgedAt),
    created_at: row.createdAt.toISOString(),
    version: row.version,
  };
}

export function reconciliationView(row: MigrationRow, result: CopyReconciliation): Schemas['PlacementReconciliation'] {
  return {
    match: result.match,
    measured_at: (row.report?.measuredAt ?? new Date(0)).toISOString(),
    source_rows: result.sourceRows,
    target_rows: result.targetRows,
    mismatched_tables: result.mismatchedTables,
    unreadable_tables: row.report?.unreadable ?? [],
    tables: result.tables.map((entry) => ({
      table: entry.table,
      source_rows: entry.sourceRows,
      target_rows: entry.targetRows,
      rows_match: entry.rowsMatch,
      source_checksum: entry.sourceChecksum,
      target_checksum: entry.targetChecksum,
      checksum_match: entry.checksumMatch,
      money: entry.money.map((money) => ({ column: money.column, source: money.source, target: money.target, match: money.match })),
      money_match: entry.moneyMatch,
      match: entry.match,
    })),
  };
}

export function placementView(choice: PlacementChoice): Schemas['PlacementChoice'] {
  return { id: choice.id, kind: choice.kind, region: choice.region, status: choice.status, max_tenants: choice.maxTenants, tenant_count: choice.tenants, incoming_migrations: choice.incoming, available: choice.available };
}

function effectsOf(scope: CommandScope): ApprovalEffects {
  return { actor: scope.tenant.membershipId, audit: (entry) => scope.audit(entry), emit: (event) => scope.emit(event) };
}

/**
 * The promotion of a tenant from the pool to a silo of its own on the control plane (ST-SAS-018, SAS-23, SAS.md 3.3, BR-SAS-05): `system.tenant.manage` writes (the System Admin), `system.tenant.read` reads. Starting a
 * promotion only plans it: the worker copies the data, compares the copy with the original table by table (rows, checksum of the keys, sums of money) and keeps the comparison up to date. A System Admin other than the one
 * who started approves the cutover when the comparison agrees (403 SELF_APPROVAL_DENIED, 422 MIGRATION_VERIFICATION_FAILED otherwise); writes are then frozen for at most the minutes asked for, the copy is compared again, and
 * the routing is switched and watched for 24 hours. An abort before Completed puts everything back. The commands act as the tenant of the migration, so what they write, audit and emit belongs to that tenant.
 */
@Controller('system')
export class PlacementMigrationController {
  private readonly store = new PlacementMigrationStore();

  constructor(
    @Inject(ControlDatabase) private readonly control: ControlDatabase,
    @Inject(PLACEMENT_MOVER) private readonly mover: PlacementMover,
  ) {}

  @Get('placements')
  @OperationId('listPlacements')
  async placements(): Promise<Schemas['PlacementList']> {
    const choices = await this.control.withControl((tx) => this.store.placements(tx));
    return { items: choices.map(placementView) };
  }

  @Get('tenants/:tenantId/placement-migrations')
  @OperationId('listPlacementMigrations')
  async list(@Param('tenantId', ParseUUIDPipe) tenantId: string, @Query('limit') limit?: unknown, @Query('cursor') cursor?: unknown): Promise<Schemas['PlacementMigrationPage']> {
    const page = parsePageRequest(limit, cursor);
    if (page.after !== undefined && Number.isNaN(Date.parse(page.after.code))) throw new DomainError('VALIDATION_FAILED', 422, 'cursor');
    const known = await this.control.withControl((tx) => tx.query<{ id: string }>('select id from machvon.tenant where id = $1::uuid', [tenantId]));
    if (known.length === 0) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return this.control.withTenantOf(tenantId, async (tx) => {
      const rows = await this.store.list(tx, { limit: page.limit + 1, after: page.after === undefined ? undefined : { createdAt: page.after.code, id: page.after.id } });
      const shown = rows.slice(0, page.limit);
      const last = shown[shown.length - 1];
      return { items: shown.map(migrationView), next_cursor: rows.length > page.limit && last !== undefined ? encodeCursor({ code: last.createdAt.toISOString(), id: last.id }) : null };
    });
  }

  @Get('placement-migrations/:migrationId')
  @OperationId('getPlacementMigration')
  async get(@Param('migrationId', ParseUUIDPipe) migrationId: string): Promise<Schemas['PlacementMigrationDetail']> {
    const tenantId = await this.control.withControl((tx) => tenantOfMigration(tx, migrationId));
    if (tenantId === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const row = await this.control.withTenantOf(tenantId, (tx) => this.store.find(tx, migrationId));
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const result = migrationReconciliation(row);
    return { migration: migrationView(row), reconciliation: result === undefined ? null : reconciliationView(row, result) };
  }

  @Post('tenants/:tenantId/placement-migrations')
  @HttpCode(202)
  @OperationId('startSiloPromotion')
  @Command({ operation: 'startSiloPromotion', plane: 'control' })
  async start(@Scope() scope: CommandScope, @Param('tenantId', ParseUUIDPipe) tenantId: string, @Body() body: Schemas['PlacementMigrationStart']): Promise<CommandResult> {
    const row = await actingAsTenant(scope.tx, tenantId, scope.tenant.tenantId, () =>
      this.store.start(
        scope.tx,
        effectsOf(scope),
        { tenantId, toPlacementId: body.to_placement_id, writeFreezeMaxMinutes: body.write_freeze_max_minutes, plannedWindowStart: new Date(body.planned_window_start), reason: body.reason, requestedBy: scope.tenant.membershipId },
        new Date(),
      ),
    );
    return commandResult(scope, 'PLANNED', row.version, row.id);
  }

  @Post('placement-migrations/:migrationId/cutover')
  @HttpCode(202)
  @OperationId('approvePlacementCutover')
  @Command({ operation: 'approvePlacementCutover', plane: 'control', versioned: true })
  async approve(@Scope() scope: CommandScope, @Param('migrationId', ParseUUIDPipe) migrationId: string, @Body() body: Schemas['ReasonOnly']): Promise<CommandResult> {
    return this.inTenantOf(scope, migrationId, async () => {
      const row = await this.store.approve(scope.tx, effectsOf(scope), { migrationId, approver: scope.tenant.membershipId, reason: body.reason, expectedVersion: scope.expectedVersion ?? 0 }, new Date());
      return commandResult(scope, 'CUTOVER_FROZEN', row.version, row.id);
    });
  }

  @Post('placement-migrations/:migrationId/abort')
  @HttpCode(202)
  @OperationId('abortPlacementMigration')
  @Command({ operation: 'abortPlacementMigration', plane: 'control', versioned: true })
  async abort(@Scope() scope: CommandScope, @Param('migrationId', ParseUUIDPipe) migrationId: string, @Body() body: Schemas['ReasonOnly']): Promise<CommandResult> {
    return this.inTenantOf(scope, migrationId, async () => {
      const row = await this.store.abort(
        scope.tx,
        effectsOf(scope),
        { migrationId, actor: scope.tenant.membershipId, reason: body.reason, expectedVersion: scope.expectedVersion ?? 0 },
        new Date(),
        { targetIntact: (migration) => targetIntact(this.mover, migration) },
      );
      return commandResult(scope, row.status === 'RolledBack' ? 'ROLLED_BACK' : 'ABORTED', row.version, row.id);
    });
  }

  // The path names only the migration: its tenant is found first, and the work runs as that tenant (404 when no tenant has the migration).
  private async inTenantOf<T>(scope: CommandScope, migrationId: string, work: () => Promise<T>): Promise<T> {
    const tenantId = await tenantOfMigration(scope.tx, migrationId);
    if (tenantId === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return actingAsTenant(scope.tx, tenantId, scope.tenant.tenantId, work);
  }
}
