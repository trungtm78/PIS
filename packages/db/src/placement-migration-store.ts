import { randomUUID } from 'node:crypto';
import { DomainError, abortedStatus, assertCutoverApproved, assertSiloPromotable, assertStartAccepted, freezeEndsAt, freezeOver, nextMigrationStatus, reconcileCopy, reportReference, sourcePurgeDueAt, versionConflict } from '@machvon/kernel';
import type { CopyReconciliation, MigrationStatus, SystemEndReason, TableMeasure, VerificationReport } from '@machvon/kernel';
import type { ApprovalEffects } from './approval-store.ts';
import type { TenantTx } from './tenant-database.ts';

export const PLACEMENT_MIGRATION_STARTED_EVENT = 'sas.placement_migration.started.v1';
export const PLACEMENT_MIGRATION_SWITCHED_EVENT = 'sas.placement_migration.switched.v1';
/** Migrations waiting for the cutover whose copy differs from the original: someone has to look. */
export const PLACEMENT_MISMATCH_GAUGE = 'placement_migration_mismatch_total';
/** Migrations whose worker keeps failing, and the ones the system had to roll back by itself in the last day. */
export const PLACEMENT_FAILING_GAUGE = 'placement_migration_failing_total';
/** For each tenant that has a migration open: the migrations that need a person (a copy that differs, a worker that fails); labelled with the tenant, never with a person. */
export const PLACEMENT_ATTENTION_GAUGE = 'placement_migration_attention';

const RESOURCE_TYPE = 'tenant_placement_migration';
/** The workflow id of a migration, unique while it runs. */
export const workflowIdOf = (tenantId: string, migrationId: string): string => `placement-migration:${tenantId}:${migrationId}`;
const DAY_MS = 86_400_000;

/** The comparison as it is kept: both sides, when they were taken, and the tables that could not be read. */
export interface StoredReport {
  measuredAt: Date;
  source: TableMeasure[];
  target: TableMeasure[];
  /** The tables of the tenant plane that the worker could not read: they were not compared. */
  unreadable: string[];
}

export interface MigrationRow {
  id: string;
  tenantId: string;
  fromPlacementId: string;
  toPlacementId: string;
  status: MigrationStatus;
  writeFreezeMaxMinutes: number;
  writeFreezeStartedAt: Date | null;
  plannedWindowStart: Date;
  reason: string;
  requestedBy: string;
  cutoverApprovedBy: string | null;
  cutoverApprovedAt: Date | null;
  approvalReason: string | null;
  verifiedAt: Date | null;
  checksumMatch: boolean | null;
  verificationReportRef: string | null;
  report: StoredReport | null;
  switchedAt: Date | null;
  completedAt: Date | null;
  endedAt: Date | null;
  endedBy: string | null;
  endReason: string | null;
  lastErrorCode: string | null;
  targetDiscardedAt: Date | null;
  sourcePurgeDueAt: Date | null;
  sourcePurgedAt: Date | null;
  workflowId: string;
  createdAt: Date;
  version: number;
}

interface MigrationDbRow {
  id: string;
  tenant_id: string;
  from_placement_id: string;
  to_placement_id: string;
  status: MigrationStatus;
  write_freeze_max_minutes: number;
  write_freeze_started_at: Date | null;
  planned_window_start: Date;
  reason: string;
  requested_by: string;
  cutover_approved_by: string | null;
  cutover_approved_at: Date | null;
  approval_reason: string | null;
  verified_at: Date | null;
  checksum_match: boolean | null;
  verification_report_ref: string | null;
  verification_report: { measured_at: string; source: TableMeasure[]; target: TableMeasure[]; unreadable?: string[] } | null;
  switched_at: Date | null;
  completed_at: Date | null;
  ended_at: Date | null;
  ended_by: string | null;
  end_reason: string | null;
  last_error_code: string | null;
  target_discarded_at: Date | null;
  source_purge_due_at: Date | null;
  source_purged_at: Date | null;
  temporal_workflow_id: string;
  created_at: Date;
  version: string;
}

const COLUMNS = `id, tenant_id, from_placement_id, to_placement_id, status, write_freeze_max_minutes, write_freeze_started_at, planned_window_start, reason, requested_by, cutover_approved_by, cutover_approved_at, approval_reason,
  verified_at, checksum_match, verification_report_ref, verification_report, switched_at, completed_at, ended_at, ended_by, end_reason, last_error_code, target_discarded_at, source_purge_due_at, source_purged_at,
  temporal_workflow_id, created_at, version::text as version`;

function migrationOf(row: MigrationDbRow): MigrationRow {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    fromPlacementId: row.from_placement_id,
    toPlacementId: row.to_placement_id,
    status: row.status,
    writeFreezeMaxMinutes: row.write_freeze_max_minutes,
    writeFreezeStartedAt: row.write_freeze_started_at,
    plannedWindowStart: row.planned_window_start,
    reason: row.reason,
    requestedBy: row.requested_by,
    cutoverApprovedBy: row.cutover_approved_by,
    cutoverApprovedAt: row.cutover_approved_at,
    approvalReason: row.approval_reason,
    verifiedAt: row.verified_at,
    checksumMatch: row.checksum_match,
    verificationReportRef: row.verification_report_ref,
    report: row.verification_report === null ? null : { measuredAt: new Date(row.verification_report.measured_at), source: row.verification_report.source, target: row.verification_report.target, unreadable: row.verification_report.unreadable ?? [] },
    switchedAt: row.switched_at,
    completedAt: row.completed_at,
    endedAt: row.ended_at,
    endedBy: row.ended_by,
    endReason: row.end_reason,
    lastErrorCode: row.last_error_code,
    targetDiscardedAt: row.target_discarded_at,
    sourcePurgeDueAt: row.source_purge_due_at,
    sourcePurgedAt: row.source_purged_at,
    workflowId: row.temporal_workflow_id,
    createdAt: row.created_at,
    version: Number(row.version),
  };
}

/** The comparison of the migration, table by table, worked out from what was kept (the verdict is never stored apart from the numbers it comes from); undefined while none was made. */
export function migrationReconciliation(row: Pick<MigrationRow, 'report'>): CopyReconciliation | undefined {
  return row.report === null ? undefined : reconcileCopy(row.report.source, row.report.target);
}

const reportJson = (report: VerificationReport, unreadable: readonly string[]): string =>
  JSON.stringify({ measured_at: report.measuredAt.toISOString(), source: report.source, target: report.target, unreadable: [...unreadable] });

export interface StartInput {
  tenantId: string;
  toPlacementId: string;
  writeFreezeMaxMinutes: number;
  plannedWindowStart: Date;
  reason: string;
  requestedBy: string;
}

export interface ApproveInput {
  migrationId: string;
  approver: string;
  reason: string;
  expectedVersion: number;
}

export interface AbortInput {
  migrationId: string;
  actor: string;
  reason: string;
  expectedVersion: number;
}

/** What the command that aborts a switched migration asks of the copy before it lets the routing go back: nothing may have been written to the silo since the switch. */
export interface AbortChecks {
  targetIntact(row: MigrationRow): Promise<boolean>;
}

export interface PlacementChoice {
  id: string;
  kind: 'POOL' | 'SILO';
  region: string;
  status: 'Active' | 'Draining' | 'Retired';
  maxTenants: number | null;
  tenants: number;
  incoming: number;
  /** Whether a promotion can be started towards it: a free, Active silo. */
  available: boolean;
}

export interface MigrationPressure {
  /** Migrations that are not over. */
  open: number;
  mismatch: number;
  failing: number;
}

// One lock for every request that picks a placement (the same as the tenant registry's): the count of tenants on a placement is only true once the earlier request has committed.
const PLACEMENT_LOCK_SQL = "select pg_advisory_xact_lock(hashtextextended('tenant-placement', 0))";
const OPEN_STATUSES_SQL = "('Planned', 'Copying', 'Verifying', 'AwaitingCutover', 'CutoverFrozen', 'Switched')";

/**
 * The promotion of a tenant to a silo of its own (ST-SAS-018, SAS.md 3.3) on the control plane: every method takes the transaction of the control role while it acts as the tenant of the migration (the table is the
 * tenant's own, with row-level security), and the tenant row, the placements and the directory of migrations are the control plane's. The commands are `start`, `approve` and `abort`; the worker moves the migration with the
 * others (`beginCopy` to `complete`). The rules are `@machvon/kernel` sas-placement; the database holds them again in its guards.
 */
export class PlacementMigrationStore {
  /**
   * Starts a promotion: an Active tenant on the pool, no migration open for it, a free Active silo of its region. 409 `MIGRATION_ALREADY_OPEN` when one is open (the database holds that with a unique index), 409
   * `TENANT_STATE_INVALID` and 422 `PLACEMENT_UNAVAILABLE` as the rules say, 422 `VALIDATION_FAILED` for a start that cannot be accepted. The migration is Planned; the worker begins the copy when its window comes.
   */
  async start(tx: TenantTx, effects: ApprovalEffects, input: StartInput, now: Date): Promise<MigrationRow> {
    assertStartAccepted({ writeFreezeMaxMinutes: input.writeFreezeMaxMinutes, plannedWindowStart: input.plannedWindowStart, reason: input.reason }, now);
    await tx.query(PLACEMENT_LOCK_SQL);
    const [tenant] = await tx.query<{ status: string; isolation_mode: string; region: string; placement_id: string }>('select status, isolation_mode, region, placement_id from machvon.tenant where id = $1::uuid for update', [input.tenantId]);
    if (tenant === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const open = await tx.query(`select 1 from machvon.tenant_placement_migration where status in ${OPEN_STATUSES_SQL}`);
    if (open.length > 0) throw new DomainError('MIGRATION_ALREADY_OPEN', 409);
    const [silo] = await tx.query<{ id: string; kind: string; status: string; region: string; max_tenants: number | null; tenants: string; incoming: number }>(
      `select p.id, p.kind, p.status, p.region, p.max_tenants,
              (select count(*) from machvon.tenant t where t.placement_id = p.id and t.status <> 'Archived')::text as tenants,
              machvon.placement_incoming_migrations(p.id) as incoming
         from machvon.placement p where p.id = $1::uuid`,
      [input.toPlacementId],
    );
    if (silo === undefined) throw new DomainError('PLACEMENT_UNAVAILABLE', 422, 'to_placement_id', { extensions: { reason: 'NOT_FOUND' } });
    assertSiloPromotable(
      { status: tenant.status, isolationMode: tenant.isolation_mode, region: tenant.region, placementId: tenant.placement_id },
      { id: silo.id, kind: silo.kind, status: silo.status, region: silo.region, hasRoom: Number(silo.tenants) + silo.incoming < (silo.max_tenants ?? 1) },
    );
    const id = randomUUID();
    const [row] = await tx.query<MigrationDbRow>(
      `insert into machvon.tenant_placement_migration
         (tenant_id, id, from_placement_id, to_placement_id, status, write_freeze_max_minutes, requested_by, reason, planned_window_start, temporal_workflow_id, created_at)
       values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'Planned', $5::int, $6::uuid, $7, $8::timestamptz, $9, $10::timestamptz)
       returning ${COLUMNS}`,
      [input.tenantId, id, tenant.placement_id, input.toPlacementId, input.writeFreezeMaxMinutes, input.requestedBy, input.reason.trim(), input.plannedWindowStart.toISOString(), workflowIdOf(input.tenantId, id), now.toISOString()],
    );
    const migration = migrationOf(row as MigrationDbRow);
    await effects.audit({
      action: 'tenant.placement_migration_started',
      resourceType: RESOURCE_TYPE,
      resourceId: migration.id,
      reason: migration.reason,
      classification: 'CONFIDENTIAL',
      diff: { from_placement_id: migration.fromPlacementId, to_placement_id: migration.toPlacementId, write_freeze_max_minutes: migration.writeFreezeMaxMinutes, planned_window_start: migration.plannedWindowStart.toISOString() },
    });
    await effects.emit({
      aggregateType: RESOURCE_TYPE,
      aggregateId: migration.id,
      aggregateVersion: migration.version,
      eventKey: `placement_migration:${migration.id}:started`,
      type: PLACEMENT_MIGRATION_STARTED_EVENT,
      schemaVersion: 1,
      payload: { migration_id: migration.id, tenant_id: migration.tenantId, from_placement_id: migration.fromPlacementId, to_placement_id: migration.toPlacementId },
    });
    return migration;
  }

  private async lock(tx: TenantTx, migrationId: string, expectedVersion?: number): Promise<MigrationRow> {
    const [row] = await tx.query<MigrationDbRow>(`select ${COLUMNS} from machvon.tenant_placement_migration where id = $1::uuid for update`, [migrationId]);
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const migration = migrationOf(row);
    if (expectedVersion !== undefined && migration.version !== expectedVersion) throw versionConflict(migration.version);
    return migration;
  }

  private async update(tx: TenantTx, sql: string, params: unknown[]): Promise<MigrationRow> {
    const [row] = await tx.query<MigrationDbRow>(`${sql} returning ${COLUMNS}`, params);
    return migrationOf(row as MigrationDbRow);
  }

  /**
   * Approves the cutover (BR-SAS-05): a System Admin other than the one who started, on the version they saw, while the migration waits and the last comparison, taken recently, found the copy and the original in
   * agreement. Writes are frozen from now for at most `write_freeze_max_minutes`; the worker sends the last difference, compares again and switches the routing, or rolls back when the freeze runs out.
   */
  async approve(tx: TenantTx, effects: ApprovalEffects, input: ApproveInput, now: Date): Promise<MigrationRow> {
    const current = await this.lock(tx, input.migrationId, input.expectedVersion);
    const reconciliation = migrationReconciliation(current);
    assertCutoverApproved(
      { status: current.status, requestedBy: current.requestedBy, report: current.report === null || reconciliation === undefined ? undefined : { measuredAt: current.report.measuredAt, match: reconciliation.match, mismatchedTables: reconciliation.mismatchedTables } },
      input.approver,
      now,
    );
    const [tenant] = await tx.query<{ status: string }>('select status from machvon.tenant where id = $1::uuid for update', [current.tenantId]);
    if (tenant === undefined || tenant.status !== 'Active') throw new DomainError('TENANT_STATE_INVALID', 409, tenant?.status);
    const frozenUntil = freezeEndsAt(now, current.writeFreezeMaxMinutes);
    const migration = await this.update(
      tx,
      `update machvon.tenant_placement_migration set status = $5::text, cutover_approved_by = $2::uuid, cutover_approved_at = $3::timestamptz, approval_reason = $4,
              write_freeze_started_at = $3::timestamptz, last_error_code = null, version = version + 1 where id = $1::uuid`,
      [current.id, input.approver, now.toISOString(), input.reason.trim(), nextMigrationStatus(current.status, 'approve')],
    );
    await tx.query('update machvon.tenant set write_frozen_until = $2::timestamptz, version = version + 1 where id = $1::uuid', [current.tenantId, frozenUntil.toISOString()]);
    await effects.audit({
      action: 'tenant.placement_cutover_approved',
      resourceType: RESOURCE_TYPE,
      resourceId: migration.id,
      reason: input.reason.trim(),
      classification: 'CONFIDENTIAL',
      diff: { requested_by: migration.requestedBy, approved_by: input.approver, write_frozen_until: frozenUntil.toISOString(), verification_report_ref: migration.verificationReportRef, tables: reconciliation?.tables.length ?? 0 },
    });
    return migration;
  }

  /**
   * Aborts a migration that is not over (SAS.md 3.3 item 4): before the cutover it is Aborted, once writes were frozen or the routing was switched it is RolledBack, writes work again and the routing is the old one.
   * A switched migration is rolled back only while nothing was written to the silo since the switch (`checks.targetIntact`): there is no way back for data that only the silo holds (409 `MIGRATION_STATE_INVALID`).
   */
  async abort(tx: TenantTx, effects: ApprovalEffects, input: AbortInput, now: Date, checks: AbortChecks): Promise<MigrationRow> {
    const current = await this.lock(tx, input.migrationId, input.expectedVersion);
    const to = abortedStatus(current.status);
    if (current.status === 'Switched' && !(await checks.targetIntact(current))) throw new DomainError('MIGRATION_STATE_INVALID', 409, 'TARGET_CHANGED');
    const migration = await this.end(tx, current, to, { endedBy: input.actor, reason: input.reason.trim(), now });
    await effects.audit({
      action: 'tenant.placement_migration_aborted',
      resourceType: RESOURCE_TYPE,
      resourceId: migration.id,
      reason: input.reason.trim(),
      classification: 'CONFIDENTIAL',
      diff: { from_status: current.status, to_status: to },
    });
    return migration;
  }

  // Ends the migration and puts back what it changed: the freeze is lifted, and a routing that was switched goes back to the placement it left.
  private async end(tx: TenantTx, current: MigrationRow, to: 'Aborted' | 'RolledBack', how: { endedBy: string | null; reason: string; now: Date; report?: { json: string; ref: string; match: boolean } }): Promise<MigrationRow> {
    const migration = await this.update(
      tx,
      `update machvon.tenant_placement_migration set status = $2, ended_at = $3::timestamptz, ended_by = $4::uuid, end_reason = $5, last_error_code = null,
              verification_report = coalesce($6::jsonb, verification_report), verification_report_ref = coalesce($7, verification_report_ref), checksum_match = coalesce($8::boolean, checksum_match),
              verified_at = case when $6::jsonb is null then verified_at else $3::timestamptz end, version = version + 1 where id = $1::uuid`,
      [current.id, to, how.now.toISOString(), how.endedBy, how.reason, how.report?.json ?? null, how.report?.ref ?? null, how.report?.match ?? null],
    );
    if (current.status === 'Switched') {
      await tx.query("update machvon.tenant set placement_id = $2::uuid, isolation_mode = 'POOL', write_frozen_until = null, version = version + 1 where id = $1::uuid", [current.tenantId, current.fromPlacementId]);
    } else if (current.status === 'CutoverFrozen') {
      await tx.query('update machvon.tenant set write_frozen_until = null, version = version + 1 where id = $1::uuid', [current.tenantId]);
    }
    return migration;
  }

  /** The migration, or undefined (the transaction acts as its tenant). */
  async find(tx: TenantTx, migrationId: string): Promise<MigrationRow | undefined> {
    const [row] = await tx.query<MigrationDbRow>(`select ${COLUMNS} from machvon.tenant_placement_migration where id = $1::uuid`, [migrationId]);
    return row === undefined ? undefined : migrationOf(row);
  }

  /** The migrations of the tenant, the newest first, a page at a time. */
  async list(tx: TenantTx, filter: { limit: number; after?: { createdAt: string; id: string } }): Promise<MigrationRow[]> {
    const rows = await tx.query<MigrationDbRow>(
      `select ${COLUMNS} from machvon.tenant_placement_migration where ($2::timestamptz is null or (date_trunc('milliseconds', created_at), id) < ($2::timestamptz, $3::uuid)) order by date_trunc('milliseconds', created_at) desc, id desc limit $1::int`,
      [filter.limit, filter.after?.createdAt ?? null, filter.after?.id ?? null],
    );
    return rows.map(migrationOf);
  }

  /** The silos and pools a promotion can look at, with how many tenants are on each and on their way to it. */
  async placements(tx: TenantTx): Promise<PlacementChoice[]> {
    const rows = await tx.query<{ id: string; kind: PlacementChoice['kind']; region: string; status: PlacementChoice['status']; max_tenants: number | null; tenants: string; incoming: number }>(
      `select p.id, p.kind, p.region, p.status, p.max_tenants,
              (select count(*) from machvon.tenant t where t.placement_id = p.id and t.status <> 'Archived')::text as tenants,
              machvon.placement_incoming_migrations(p.id) as incoming
         from machvon.placement p order by p.kind desc, p.region, p.id`,
    );
    return rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      region: row.region,
      status: row.status,
      maxTenants: row.max_tenants,
      tenants: Number(row.tenants),
      incoming: row.incoming,
      available: row.kind === 'SILO' && row.status === 'Active' && Number(row.tenants) + row.incoming < (row.max_tenants ?? 1),
    }));
  }

  // The worker ------------------------------------------------------------------------------------------------

  /** The migrations of the tenant that the worker has something to do with: the ones not over, and the ones that ended or completed and still have data to destroy. */
  async workItems(tx: TenantTx): Promise<MigrationRow[]> {
    const rows = await tx.query<MigrationDbRow>(
      `select ${COLUMNS} from machvon.tenant_placement_migration
        where status in ${OPEN_STATUSES_SQL}
           or (status in ('Aborted', 'RolledBack') and target_discarded_at is null)
           or (status = 'Completed' and source_purge_due_at is not null and source_purged_at is null)
        order by created_at, id`,
    );
    return rows.map(migrationOf);
  }

  /** Planned to Copying, when the window has come. */
  async beginCopy(tx: TenantTx, effects: ApprovalEffects, migrationId: string): Promise<MigrationRow> {
    const current = await this.lock(tx, migrationId);
    const to = nextMigrationStatus(current.status, 'copy');
    const migration = await this.update(tx, `update machvon.tenant_placement_migration set status = $2::text, last_error_code = null, version = version + 1 where id = $1::uuid`, [migrationId, to]);
    await effects.audit({ action: 'tenant.placement_migration_copy_started', resourceType: RESOURCE_TYPE, resourceId: migrationId, classification: 'CONFIDENTIAL', diff: { to_placement_id: migration.toPlacementId } });
    return migration;
  }

  /** Copying to Verifying, when the copy is made. */
  async copied(tx: TenantTx, migrationId: string): Promise<MigrationRow> {
    const current = await this.lock(tx, migrationId);
    const to = nextMigrationStatus(current.status, 'copied');
    return this.update(tx, `update machvon.tenant_placement_migration set status = $2::text, last_error_code = null, version = version + 1 where id = $1::uuid`, [migrationId, to]);
  }

  /**
   * Keeps a comparison. From Verifying it moves the migration to AwaitingCutover; while it waits the comparison is replaced by each newer one (the copy goes on catching up with the original), and the audit trail
   * is told when the verdict changes.
   */
  async recordVerification(tx: TenantTx, effects: ApprovalEffects, migrationId: string, report: VerificationReport, unreadable: readonly string[]): Promise<MigrationRow> {
    const current = await this.lock(tx, migrationId);
    if (current.status !== 'Verifying' && current.status !== 'AwaitingCutover') throw new DomainError('MIGRATION_STATE_INVALID', 409, `${current.status}->verified`);
    const to = current.status === 'Verifying' ? nextMigrationStatus(current.status, 'verified') : current.status;
    const ref = reportReference(report);
    const migration = await this.update(
      tx,
      `update machvon.tenant_placement_migration set status = $6::text, verification_report = $2::jsonb, verification_report_ref = $3, verified_at = $4::timestamptz, checksum_match = $5::boolean, last_error_code = null, version = version + 1
        where id = $1::uuid`,
      [migrationId, reportJson(report, unreadable), ref, report.measuredAt.toISOString(), report.match, to],
    );
    if (current.checksumMatch !== report.match) {
      await effects.audit({
        action: 'tenant.placement_migration_verified',
        resourceType: RESOURCE_TYPE,
        resourceId: migrationId,
        classification: 'CONFIDENTIAL',
        diff: { match: report.match, mismatched_tables: report.mismatchedTables, verification_report_ref: ref, unreadable_tables: unreadable.length },
      });
    }
    return migration;
  }

  /** Remembers the class of the failure that stopped the worker (never its message: it may hold data); the version moves only when the class does. */
  async recordError(tx: TenantTx, migrationId: string, code: string): Promise<void> {
    await tx.query('update machvon.tenant_placement_migration set last_error_code = $2, version = version + 1 where id = $1::uuid and last_error_code is distinct from $2', [migrationId, code]);
  }

  /**
   * CutoverFrozen to Switched, inside the freeze: the last comparison, taken with writes frozen, found the copy and the original in agreement (422 `MIGRATION_VERIFICATION_FAILED` otherwise) and the freeze is not over
   * (409 `MIGRATION_STATE_INVALID`). The routing of the tenant is the silo from here on, writes are allowed again, and the platform is told (`sas.placement_migration.switched.v1`).
   */
  async switch(tx: TenantTx, effects: ApprovalEffects, migrationId: string, report: VerificationReport, unreadable: readonly string[], now: Date): Promise<MigrationRow> {
    const current = await this.lock(tx, migrationId);
    const to = nextMigrationStatus(current.status, 'switch');
    if (!report.match) throw new DomainError('MIGRATION_VERIFICATION_FAILED', 422, undefined, { extensions: { reason: 'MISMATCH', tables: report.mismatchedTables } });
    if (current.writeFreezeStartedAt === null || freezeOver(current.writeFreezeStartedAt, current.writeFreezeMaxMinutes, now)) throw new DomainError('MIGRATION_STATE_INVALID', 409, 'FREEZE_OVER');
    const ref = reportReference(report);
    const migration = await this.update(
      tx,
      `update machvon.tenant_placement_migration set status = $6::text, switched_at = $2::timestamptz, verification_report = $3::jsonb, verification_report_ref = $4, verified_at = $5::timestamptz, checksum_match = true, last_error_code = null,
              version = version + 1 where id = $1::uuid`,
      [migrationId, now.toISOString(), reportJson(report, unreadable), ref, report.measuredAt.toISOString(), to],
    );
    await tx.query("update machvon.tenant set placement_id = $2::uuid, isolation_mode = 'SILO', write_frozen_until = null, version = version + 1 where id = $1::uuid", [current.tenantId, current.toPlacementId]);
    await effects.audit({
      action: 'tenant.placement_switched',
      resourceType: RESOURCE_TYPE,
      resourceId: migrationId,
      classification: 'CONFIDENTIAL',
      diff: { from_placement_id: current.fromPlacementId, to_placement_id: current.toPlacementId, verification_report_ref: ref, tables: report.target.length },
    });
    await effects.emit({
      aggregateType: RESOURCE_TYPE,
      aggregateId: migrationId,
      aggregateVersion: migration.version,
      eventKey: `placement_migration:${migrationId}:switched`,
      type: PLACEMENT_MIGRATION_SWITCHED_EVENT,
      schemaVersion: 1,
      payload: { migration_id: migrationId, tenant_id: current.tenantId, from_placement_id: current.fromPlacementId, to_placement_id: current.toPlacementId },
    });
    return migration;
  }

  /** The system rolls back a frozen migration by itself: the freeze ran out its time, or the last comparison disagreed. Nobody ended it; writes work again and the routing was never changed. */
  async rollBack(tx: TenantTx, effects: ApprovalEffects, migrationId: string, reason: SystemEndReason, now: Date, report?: { report: VerificationReport; unreadable: readonly string[] }): Promise<MigrationRow> {
    const current = await this.lock(tx, migrationId);
    if (current.status !== 'CutoverFrozen') throw new DomainError('MIGRATION_STATE_INVALID', 409, `${current.status}->${reason}`);
    const migration = await this.end(tx, current, 'RolledBack', {
      endedBy: null,
      reason,
      now,
      ...(report === undefined ? {} : { report: { json: reportJson(report.report, report.unreadable), ref: reportReference(report.report), match: report.report.match } }),
    });
    await effects.audit({ action: 'tenant.placement_migration_rolled_back', resourceType: RESOURCE_TYPE, resourceId: migrationId, reason, classification: 'CONFIDENTIAL', diff: { reason, mismatched_tables: report?.report.mismatchedTables ?? [] } });
    return migration;
  }

  /** Switched to Completed, once the tenant was watched for 24 hours on the silo; the old data is kept 30 days. */
  async complete(tx: TenantTx, effects: ApprovalEffects, migrationId: string, now: Date): Promise<MigrationRow> {
    const current = await this.lock(tx, migrationId);
    const to = nextMigrationStatus(current.status, 'complete');
    const migration = await this.update(
      tx,
      `update machvon.tenant_placement_migration set status = $4::text, completed_at = $2::timestamptz, source_purge_due_at = $3::timestamptz, last_error_code = null, version = version + 1 where id = $1::uuid`,
      [migrationId, now.toISOString(), sourcePurgeDueAt(now).toISOString(), to],
    );
    await effects.audit({ action: 'tenant.placement_migration_completed', resourceType: RESOURCE_TYPE, resourceId: migrationId, classification: 'CONFIDENTIAL', diff: { source_purge_due_at: migration.sourcePurgeDueAt?.toISOString() } });
    return migration;
  }

  /** The copy of a migration that ended without a switch was destroyed. */
  async targetDiscarded(tx: TenantTx, effects: ApprovalEffects, migrationId: string, now: Date): Promise<void> {
    const [row] = await tx.query<{ id: string }>("update machvon.tenant_placement_migration set target_discarded_at = $2::timestamptz, last_error_code = null where id = $1::uuid and target_discarded_at is null and status in ('Aborted', 'RolledBack') returning id", [migrationId, now.toISOString()]);
    if (row !== undefined) await effects.audit({ action: 'tenant.placement_target_discarded', resourceType: RESOURCE_TYPE, resourceId: migrationId, classification: 'CONFIDENTIAL', diff: {} });
  }

  /** The old data of a completed migration was deleted. */
  async sourcePurged(tx: TenantTx, effects: ApprovalEffects, migrationId: string, now: Date): Promise<void> {
    const [row] = await tx.query<{ id: string }>("update machvon.tenant_placement_migration set source_purged_at = $2::timestamptz, last_error_code = null where id = $1::uuid and source_purged_at is null and status = 'Completed' returning id", [migrationId, now.toISOString()]);
    if (row !== undefined) await effects.audit({ action: 'tenant.placement_source_purged', resourceType: RESOURCE_TYPE, resourceId: migrationId, classification: 'CONFIDENTIAL', diff: {} });
  }

  /** The legal holds in force on the tenant of the transaction; the old data is not deleted while there is one (BR-PLT-04). */
  async legalHoldsActive(tx: TenantTx, tenantId: string): Promise<number> {
    const [row] = await tx.query<{ n: number }>('select machvon.tenant_legal_holds_active($1::uuid) as n', [tenantId]);
    return row?.n ?? 0;
  }

  /** What the alerts watch, for the tenant of the transaction. */
  async pressure(tx: TenantTx, now: Date): Promise<MigrationPressure> {
    const [row] = await tx.query<{ open: string; mismatch: string; failing: string }>(
      `select count(*) filter (where status in ${OPEN_STATUSES_SQL})::text as open,
              count(*) filter (where status = 'AwaitingCutover' and checksum_match is false)::text as mismatch,
              count(*) filter (where (status in ${OPEN_STATUSES_SQL} and last_error_code is not null) or (status = 'RolledBack' and ended_by is null and ended_at > $1::timestamptz))::text as failing
         from machvon.tenant_placement_migration`,
      [new Date(now.getTime() - DAY_MS).toISOString()],
    );
    return { open: Number(row?.open ?? 0), mismatch: Number(row?.mismatch ?? 0), failing: Number(row?.failing ?? 0) };
  }
}

/** The tenant a migration belongs to, or undefined (the approval and the abort name only the migration). */
export async function tenantOfMigration(tx: TenantTx, migrationId: string): Promise<string | undefined> {
  const [row] = await tx.query<{ tenant_id: string | null }>('select machvon.placement_migration_tenant_of($1::uuid) as tenant_id', [migrationId]);
  return row?.tenant_id ?? undefined;
}
