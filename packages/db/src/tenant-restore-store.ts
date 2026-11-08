import { DomainError, RESTORE_STALLED_AFTER_MS, assertRecoveryPointHeld, assertRestorable, restoreReportReference, restoreRequestDefects, tablesToExport, versionConflict } from '@machvon/kernel';
import type { Measurement, RecoveryWindow, RestoreStatus, RestoreTarget, RestoreVerificationReport, TableMeasurement } from '@machvon/kernel';
import type { ApprovalEffects } from './approval-store.ts';
import type { TenantTx } from './tenant-database.ts';

export const TENANT_RESTORE_COMPLETED_EVENT = 'sas.tenant_restore.completed.v1';
/** The gauge of the restores that were approved and have not ended, for the alert that watches for a restore that does not finish. */
export const TENANT_RESTORE_PENDING_GAUGE = 'tenant_restore_pending';
/** The gauge of the restores that ended as Failed in the last day, for the alert that watches for a restore that cannot be verified. */
export const TENANT_RESTORE_FAILED_GAUGE = 'tenant_restore_failed_24h';

const RESOURCE_TYPE = 'tenant_restore_request';
const DAY_MS = 86_400_000;

export interface RestoreRow {
  id: string;
  tenantId: string;
  recoveryPoint: Date;
  target: RestoreTarget;
  reason: string;
  status: RestoreStatus;
  requestedBy: string;
  requestedAt: Date;
  decidedBy: string | null;
  approvedBy: string | null;
  decidedAt: Date | null;
  decisionReason: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
  restoredTo: Date | null;
  sandboxRef: string | null;
  errorCode: string | null;
  verificationReportRef: string | null;
  report: RestoreVerificationReport | null;
  version: number;
}

interface RestoreDbRow {
  id: string;
  tenant_id: string;
  recovery_point: Date;
  target: RestoreTarget;
  reason: string;
  status: RestoreStatus;
  requested_by: string;
  requested_at: Date;
  decided_by: string | null;
  approved_by: string | null;
  decided_at: Date | null;
  decision_reason: string | null;
  started_at: Date | null;
  completed_at: Date | null;
  restored_to: Date | null;
  sandbox_ref: string | null;
  error_code: string | null;
  verification_report_ref: string | null;
  verification_report: RestoreVerificationReport | null;
  version: string;
}

const COLUMNS = `id, tenant_id, recovery_point, target, reason, status, requested_by, requested_at, decided_by, approved_by, decided_at, decision_reason, started_at, completed_at, restored_to, sandbox_ref, error_code,
  verification_report_ref, verification_report, version::text as version`;

const restoreOf = (row: RestoreDbRow): RestoreRow => ({
  id: row.id,
  tenantId: row.tenant_id,
  recoveryPoint: row.recovery_point,
  target: row.target,
  reason: row.reason,
  status: row.status,
  requestedBy: row.requested_by,
  requestedAt: row.requested_at,
  decidedBy: row.decided_by,
  approvedBy: row.approved_by,
  decidedAt: row.decided_at,
  decisionReason: row.decision_reason,
  startedAt: row.started_at,
  completedAt: row.completed_at,
  restoredTo: row.restored_to,
  sandboxRef: row.sandbox_ref,
  errorCode: row.error_code,
  verificationReportRef: row.verification_report_ref,
  report: row.verification_report,
  version: Number(row.version),
});

export interface RestoreRequestInput {
  recoveryPoint: Date;
  target: RestoreTarget;
  reason: string;
  requestedBy: string;
  /** The recovery points the backups hold for the tenant, as the restore engine tells; undefined when it holds none. */
  window: RecoveryWindow | undefined;
  now: Date;
}

export interface RestoreDecisionInput {
  restoreId: string;
  decision: 'approve' | 'reject';
  decidedBy: string;
  reason: string;
  /** The documents the decision rests on, kept in the audit trail beside it. */
  evidenceIds: readonly string[];
  expectedVersion: number;
  window: RecoveryWindow | undefined;
  now: Date;
}

export interface RestorePassResult {
  /** Restores that were approved and have not ended: the backlog. */
  pending: number;
  /** Restores that ended as Failed in the last day. */
  failed: number;
}

const quote = (identifier: string): string => `"${identifier.replaceAll('"', '""')}"`;

/**
 * The restore of one tenant (ST-SAS-019, SAS.md 3.11), on the rows of the tenant a transaction acts as. A System Admin asks (`request`): a recovery point the backups hold, a sandbox for a tenant that has data or an in-place restore only
 * while it is Suspended (409 TENANT_STATE_INVALID), one in-place restore at a time (409 RESTORE_IN_PROGRESS). A second System Admin decides (`decide`): never the one who asked (403 SELF_APPROVAL_DENIED, and the database holds that too);
 * approving asks again for the state of the tenant and for the recovery point, because both may have changed while the request waited. The worker takes what was approved (`claim`), has it restored, records where the copy is (`restored`)
 * and ends it as Completed only with a verification report that matched (`complete`), or as Failed with the class of the failure (`fail`).
 */
export class TenantRestoreStore {
  async request(tx: TenantTx, effects: ApprovalEffects, input: RestoreRequestInput): Promise<RestoreRow> {
    const defect = restoreRequestDefects(input)[0];
    if (defect !== undefined) throw new DomainError('VALIDATION_FAILED', 422, defect);
    assertRestorable(input.target, await this.tenantStatus(tx));
    assertRecoveryPointHeld(input.recoveryPoint, input.window);
    const reason = input.reason.trim();
    const [row] = await tx
      .query<RestoreDbRow>(
        `insert into machvon.tenant_restore_request (tenant_id, id, recovery_point, target, reason, status, requested_by, requested_at)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1::timestamptz, $2, $3, 'Requested', $4::uuid, $5::timestamptz)
         returning ${COLUMNS}`,
        [input.recoveryPoint.toISOString(), input.target, reason, input.requestedBy, input.now.toISOString()],
      )
      .catch((error: unknown) => {
        // The unique index on the open in-place restore of the tenant.
        if (error instanceof Error && 'code' in error && error.code === '23505') throw new DomainError('RESTORE_IN_PROGRESS', 409);
        throw error;
      });
    if (row === undefined) throw new Error('restore insert returned no row');
    const restore = restoreOf(row);
    await effects.audit({
      action: 'tenant.restore_requested',
      resourceType: RESOURCE_TYPE,
      resourceId: restore.id,
      reason,
      classification: 'CONFIDENTIAL',
      diff: { target: restore.target, recovery_point: restore.recoveryPoint.toISOString() },
    });
    return restore;
  }

  /**
   * Decides a request that waits. 404 for one that does not exist, 409 VERSION_CONFLICT for a stale version, 409 STAGE_TRANSITION_DENIED for one that is no longer waiting, 403 SELF_APPROVAL_DENIED for the person who asked (whichever way
   * they decide). Approving it asks again for the state of the tenant (409 TENANT_STATE_INVALID: an in-place restore of a tenant that was resumed meanwhile) and for the recovery point (422 RECOVERY_POINT_UNAVAILABLE: it left the window
   * of the backups while the request waited); turning it down needs neither.
   */
  async decide(tx: TenantTx, effects: ApprovalEffects, input: RestoreDecisionInput): Promise<RestoreRow> {
    const current = await this.lock(tx, input.restoreId);
    if (current.version !== input.expectedVersion) throw versionConflict(current.version);
    if (current.status !== 'Requested') throw new DomainError('STAGE_TRANSITION_DENIED', 409);
    if (current.requestedBy.toLowerCase() === input.decidedBy.toLowerCase()) throw new DomainError('SELF_APPROVAL_DENIED', 403);
    if (input.decision === 'approve') {
      assertRestorable(current.target, await this.tenantStatus(tx));
      assertRecoveryPointHeld(current.recoveryPoint, input.window);
    }
    const approved = input.decision === 'approve';
    const [row] = await tx.query<RestoreDbRow>(
      `update machvon.tenant_restore_request
          set status = $2, decided_by = $3::uuid, approved_by = $4::uuid, decided_at = $5::timestamptz, decision_reason = $6, version = version + 1
        where id = $1::uuid returning ${COLUMNS}`,
      [current.id, approved ? 'Approved' : 'Rejected', input.decidedBy, approved ? input.decidedBy : null, input.now.toISOString(), input.reason.trim()],
    );
    if (row === undefined) throw new Error('restore update returned no row');
    const restore = restoreOf(row);
    await effects.audit({
      action: 'tenant.restore_decided',
      resourceType: RESOURCE_TYPE,
      resourceId: restore.id,
      reason: input.reason.trim(),
      classification: 'CONFIDENTIAL',
      diff: { decision: input.decision, target: restore.target, requested_by: restore.requestedBy, evidence_ids: input.evidenceIds },
    });
    return restore;
  }

  /** Takes the oldest approved restore and makes it Restoring; another worker that asks at the same time gets another one or none. */
  async claim(tx: TenantTx, now: Date): Promise<RestoreRow | undefined> {
    const [waiting] = await tx.query<{ id: string }>("select id from machvon.tenant_restore_request where status = 'Approved' order by requested_at, id limit 1 for update skip locked");
    if (waiting === undefined) return undefined;
    const [row] = await tx.query<RestoreDbRow>(`update machvon.tenant_restore_request set status = 'Restoring', started_at = $2::timestamptz, version = version + 1 where id = $1::uuid returning ${COLUMNS}`, [waiting.id, now.toISOString()]);
    return row === undefined ? undefined : restoreOf(row);
  }

  /** The engine has put the copy in place: where it is and the instant it stopped at, and the verification begins. */
  async restored(tx: TenantTx, restoreId: string, done: { restoredTo: Date; sandboxRef: string | null }): Promise<RestoreRow> {
    const [row] = await tx.query<RestoreDbRow>(
      `update machvon.tenant_restore_request set status = 'Verifying', restored_to = $2::timestamptz, sandbox_ref = $3, version = version + 1
        where id = $1::uuid and status = 'Restoring' returning ${COLUMNS}`,
      [restoreId, done.restoredTo.toISOString(), done.sandboxRef],
    );
    if (row === undefined) throw new DomainError('STAGE_TRANSITION_DENIED', 409);
    return restoreOf(row);
  }

  /** The verification matched: the restore is Completed, with the report and its sha256 as the record of the drill, and the event tells the platform. A report that did not match cannot complete a restore. */
  async complete(tx: TenantTx, effects: ApprovalEffects, restoreId: string, report: RestoreVerificationReport, now: Date): Promise<RestoreRow> {
    if (!report.matched) throw new DomainError('STAGE_TRANSITION_DENIED', 409, 'REPORT_NOT_MATCHED');
    const [row] = await tx.query<RestoreDbRow>(
      `update machvon.tenant_restore_request set status = 'Completed', verification_report = $2::jsonb, verification_report_ref = $3, completed_at = $4::timestamptz, version = version + 1
        where id = $1::uuid and status = 'Verifying' returning ${COLUMNS}`,
      [restoreId, JSON.stringify(report), restoreReportReference(report), now.toISOString()],
    );
    if (row === undefined) throw new DomainError('STAGE_TRANSITION_DENIED', 409);
    const restore = restoreOf(row);
    await effects.audit({
      action: 'tenant.restore_completed',
      resourceType: RESOURCE_TYPE,
      resourceId: restore.id,
      classification: 'CONFIDENTIAL',
      diff: { target: restore.target, tables: report.totals.tables, rows: report.totals.rows_restored, rpo_seconds: report.rpo_seconds, rto_seconds: report.rto_seconds, within_targets: report.within_targets, report_ref: restore.verificationReportRef },
    });
    await effects.emit({
      aggregateType: RESOURCE_TYPE,
      aggregateId: restore.id,
      aggregateVersion: restore.version,
      eventKey: `tenant_restore:${restore.id}:completed`,
      type: TENANT_RESTORE_COMPLETED_EVENT,
      schemaVersion: 1,
      payload: { restore_id: restore.id, target: restore.target, within_targets: report.within_targets },
    });
    return restore;
  }

  /**
   * The restore could not be made or did not verify: it ends as Failed with the class of the failure (never its message: it may hold data), and with the report when there was one. A restore that has ended is left as it is.
   */
  async fail(tx: TenantTx, effects: ApprovalEffects, restoreId: string, errorCode: string, now: Date, report?: RestoreVerificationReport): Promise<void> {
    const [row] = await tx.query<RestoreDbRow>(
      `update machvon.tenant_restore_request set status = 'Failed', error_code = $2, completed_at = $3::timestamptz, verification_report = $4::jsonb, verification_report_ref = $5, version = version + 1
        where id = $1::uuid and status in ('Approved', 'Restoring', 'Verifying') returning ${COLUMNS}`,
      [restoreId, errorCode, now.toISOString(), report === undefined ? null : JSON.stringify(report), report === undefined ? null : restoreReportReference(report)],
    );
    if (row === undefined) return;
    await effects.audit({
      action: 'tenant.restore_failed',
      resourceType: RESOURCE_TYPE,
      resourceId: restoreId,
      classification: 'CONFIDENTIAL',
      diff: { error_code: errorCode, mismatches: report?.mismatches.length ?? 0 },
    });
  }

  /** A restore that has been running for longer than the time agreed to recover, and two hours more, belongs to a process that is gone: it ends as Failed (Stalled). */
  async sweepStalled(tx: TenantTx, effects: ApprovalEffects, now: Date): Promise<string[]> {
    const stalled = await tx.query<{ id: string }>(
      "select id from machvon.tenant_restore_request where status in ('Restoring', 'Verifying') and started_at <= $1::timestamptz order by started_at, id for update",
      [new Date(now.getTime() - RESTORE_STALLED_AFTER_MS).toISOString()],
    );
    for (const { id } of stalled) await this.fail(tx, effects, id, 'Stalled', now);
    return stalled.map((entry) => entry.id);
  }

  /** The backlog and the failures of the last day, for the gauges. */
  async counts(tx: TenantTx, now: Date): Promise<RestorePassResult> {
    const [row] = await tx.query<{ pending: string; failed: string }>(
      `select count(*) filter (where status in ('Approved', 'Restoring', 'Verifying'))::text as pending,
              count(*) filter (where status = 'Failed' and completed_at > $1::timestamptz)::text as failed
         from machvon.tenant_restore_request`,
      [new Date(now.getTime() - DAY_MS).toISOString()],
    );
    return { pending: Number(row?.pending ?? 0), failed: Number(row?.failed ?? 0) };
  }

  /** The state of the tenant the transaction acts as. */
  async tenantStatus(tx: TenantTx): Promise<string> {
    const [runtime] = await tx.query<{ status: string }>("select status from machvon.tenant_runtime(nullif(current_setting('app.tenant_id', true), '')::uuid)");
    if (runtime === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return runtime.status;
  }

  async find(tx: TenantTx, id: string): Promise<RestoreRow | undefined> {
    const [row] = await tx.query<RestoreDbRow>(`select ${COLUMNS} from machvon.tenant_restore_request where id = $1::uuid`, [id]);
    return row === undefined ? undefined : restoreOf(row);
  }

  /** The restores of the tenant, the newest first, a page at a time. */
  async list(tx: TenantTx, filter: { limit: number; after?: { requestedAt: string; id: string } }): Promise<RestoreRow[]> {
    const rows = await tx.query<RestoreDbRow>(
      `select ${COLUMNS} from machvon.tenant_restore_request where ($2::timestamptz is null or (requested_at, id) < ($2::timestamptz, $3::uuid)) order by requested_at desc, id desc limit $1::int`,
      [filter.limit, filter.after?.requestedAt ?? null, filter.after?.id ?? null],
    );
    return rows.map(restoreOf);
  }

  /**
   * What the tenant holds now, table by table: the tables of the tenant plane (the ones with row-level security that carry the tenant, except the machinery of the platform), the rows of each, a checksum of the rows that does not
   * depend on their order, and the total of every money column (a numeric column whose name ends in `_vnd`). The restore engines measure the same way, so that a copy and its backup can be compared.
   */
  async measure(tx: TenantTx): Promise<Measurement> {
    // One read of the catalogue gives the tables and their money columns together: asking information_schema for each table separately grows with the number of tables of the product and made the measure slower than the restore it checks.
    const catalogue = await tx.query<{ relname: string; money: string[] }>(
      `select c.relname,
              coalesce(array(select a.attname::text from pg_attribute a where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped and a.atttypid = 'numeric'::regtype and a.attname::text like '%\\_vnd' order by a.attname::text), array[]::text[]) as money
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'machvon' and c.relkind in ('r', 'p') and c.relrowsecurity and has_table_privilege(c.oid, 'select')
          and exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'tenant_id' and a.attnum > 0 and not a.attisdropped)
        order by c.relname`,
    );
    const moneyOf = new Map(catalogue.map((entry) => [entry.relname, entry.money]));
    const tables: Record<string, TableMeasurement> = {};
    for (const table of tablesToExport(
      catalogue.map((entry) => entry.relname),
      'FULL',
    )) {
      const moneyColumns = moneyOf.get(table) ?? [];
      const sums = moneyColumns.map((column, index) => `coalesce(sum(s.${quote(column)}), 0)::text as m${index}`).join(', ');
      const [row] = await tx.query<Record<string, string>>(
        `select count(*)::text as rows, md5(coalesce(string_agg(s.__row_hash, '' order by s.__row_hash), '')) as checksum${sums === '' ? '' : `, ${sums}`}
           from (select md5(x::text) as __row_hash, x.* from machvon.${quote(table)} x) s`,
      );
      tables[table] = {
        rows: Number(row?.rows ?? 0),
        checksum: row?.checksum ?? '',
        money: Object.fromEntries(moneyColumns.map((column, index) => [column, row?.[`m${index}`] ?? '0'])),
      };
    }
    return { tables };
  }

  private async lock(tx: TenantTx, restoreId: string): Promise<RestoreRow> {
    const [row] = await tx.query<RestoreDbRow>(`select ${COLUMNS} from machvon.tenant_restore_request where id = $1::uuid for update`, [restoreId]);
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return restoreOf(row);
  }
}
