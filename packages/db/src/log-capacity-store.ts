import { DomainError, capacityKindOf, logCapFindings } from '@machvon/kernel';
import type { CapacityState, LogCapPolicy, LogCapacityFinding } from '@machvon/kernel';
import type { TenantTx } from './tenant-database.ts';

export interface LogCapacityPolicyRow {
  id: string;
  recordClass: string;
  maxRows: number | null;
  maxBytes: number | null;
  warnPct: number;
  active: boolean;
  reason: string;
  version: number;
  updatedAt: string;
  updatedBy: string;
}

interface PolicySql {
  id: string;
  record_class: string;
  max_rows: string | null;
  max_bytes: string | null;
  warn_pct: number;
  active: boolean;
  reason: string;
  version: string;
  updated_at: string;
  updated_by: string;
}

const COLUMNS = `id, record_class, max_rows::text as max_rows, max_bytes::text as max_bytes, warn_pct, active, reason, version::text as version,
  to_char(updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as updated_at, updated_by`;

const policyOf = (row: PolicySql): LogCapacityPolicyRow => ({
  id: row.id,
  recordClass: row.record_class,
  maxRows: row.max_rows === null ? null : Number(row.max_rows),
  maxBytes: row.max_bytes === null ? null : Number(row.max_bytes),
  warnPct: row.warn_pct,
  active: row.active,
  reason: row.reason,
  version: Number(row.version),
  updatedAt: row.updated_at,
  updatedBy: row.updated_by,
});

export interface LogCapacityInput {
  recordClass: string;
  maxRows: number | null;
  maxBytes: number | null;
  warnPct: number;
  active: boolean;
  reason: string;
}

export interface LogCapacityReadingRow {
  recordClass: string;
  rows: number;
  bytes: number;
  bytesEstimated: boolean;
  eligibleRows: number;
  protectedRows: number;
  state: CapacityState;
  measuredAt: string;
}

interface ReadingSql {
  record_class: string;
  row_count: string;
  byte_count: string;
  bytes_estimated: boolean;
  eligible_rows: string;
  protected_rows: string;
  state: CapacityState;
  measured_at: string;
}

const READING_COLUMNS = `record_class, row_count::text as row_count, byte_count::text as byte_count, bytes_estimated, eligible_rows::text as eligible_rows, protected_rows::text as protected_rows, state,
  to_char(measured_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as measured_at`;

const readingOf = (row: ReadingSql): LogCapacityReadingRow => ({
  recordClass: row.record_class,
  rows: Number(row.row_count),
  bytes: Number(row.byte_count),
  bytesEstimated: row.bytes_estimated,
  eligibleRows: Number(row.eligible_rows),
  protectedRows: Number(row.protected_rows),
  state: row.state,
  measuredAt: row.measured_at,
});

export interface ArchiveBatchRow {
  id: string;
  recordClass: string;
  status: 'ARCHIVED' | 'PURGED';
  rows: number;
  bytes: number;
  oldestAt: string | null;
  newestAt: string | null;
  fileSha256: string;
  createdAt: string;
  purgedAt: string | null;
}

interface BatchSql {
  id: string;
  record_class: string;
  status: 'ARCHIVED' | 'PURGED';
  row_count: string;
  byte_count: string;
  oldest_at: string | null;
  newest_at: string | null;
  file_sha256: string;
  created_at: string;
  purged_at: string | null;
}

/** The caps on the number and the size of the log classes of a tenant, their last readings, and the archive batches (HT.06). Every change is a versioned command with a reason and a history row. */
export class LogCapacityStore {
  async policies(tx: TenantTx): Promise<LogCapacityPolicyRow[]> {
    return (await tx.query<PolicySql>(`select ${COLUMNS} from machvon.log_capacity_policy order by record_class`)).map(policyOf);
  }

  async readings(tx: TenantTx): Promise<LogCapacityReadingRow[]> {
    return (await tx.query<ReadingSql>(`select ${READING_COLUMNS} from machvon.log_capacity_reading order by record_class`)).map(readingOf);
  }

  async recentBatches(tx: TenantTx, limit: number): Promise<ArchiveBatchRow[]> {
    const rows = await tx.query<BatchSql>(
      `select id, record_class, status, row_count::text as row_count, byte_count::text as byte_count,
              to_char(oldest_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as oldest_at, to_char(newest_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as newest_at, file_sha256,
              to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as created_at, to_char(purged_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as purged_at
         from machvon.log_archive_batch order by created_at desc, id desc limit $1`,
      [limit],
    );
    return rows.map((row) => ({
      id: row.id,
      recordClass: row.record_class,
      status: row.status,
      rows: Number(row.row_count),
      bytes: Number(row.byte_count),
      oldestAt: row.oldest_at,
      newestAt: row.newest_at,
      fileSha256: row.file_sha256,
      createdAt: row.created_at,
      purgedAt: row.purged_at,
    }));
  }

  /**
   * Creates the cap of a class or changes it; `expectedVersion` is the version the caller saw (0 for a class with no cap), else 409 VERSION_CONFLICT. A cap on the rows of a technical class
   * below the rows that the platform minimum period protects (last reading) is refused: it could never be honoured without shortening retention (BR-ADM-11). Monitor-only classes carry no such floor.
   */
  async save(tx: TenantTx, actorId: string, input: LogCapacityInput, expectedVersion: number): Promise<{ row: LogCapacityPolicyRow; before: LogCapacityPolicyRow | undefined }> {
    const policy: LogCapPolicy = { recordClass: input.recordClass, maxRows: input.maxRows, maxBytes: input.maxBytes, warnPct: input.warnPct };
    const [reading] = await tx.query<{ protected_rows: string }>('select protected_rows::text as protected_rows from machvon.log_capacity_reading where record_class = $1', [input.recordClass]);
    const findings: LogCapacityFinding[] = logCapFindings(policy, input.reason, reading === undefined || !input.active ? 0 : Number(reading.protected_rows));
    const first = findings[0];
    if (first !== undefined) throw new DomainError('VALIDATION_FAILED', 422, first.field, { extensions: { errors: findings } });
    if (capacityKindOf(input.recordClass) === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'record_class');
    const [locked] = await tx.query<PolicySql>(`select ${COLUMNS} from machvon.log_capacity_policy where record_class = $1 for update`, [input.recordClass]);
    const before = locked === undefined ? undefined : policyOf(locked);
    if ((before?.version ?? 0) !== expectedVersion) throw new DomainError('VERSION_CONFLICT', 409, undefined, { extensions: { current_version: before?.version ?? 0 } });
    const reason = input.reason.trim();
    let row: LogCapacityPolicyRow;
    if (before === undefined) {
      const [made] = await tx.query<PolicySql>(
        `insert into machvon.log_capacity_policy (tenant_id, record_class, max_rows, max_bytes, warn_pct, active, reason, created_by, updated_by)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1, $2::bigint, $3::bigint, $4, $5, $6, $7::uuid, $7::uuid) returning ${COLUMNS}`,
        [input.recordClass, input.maxRows, input.maxBytes, input.warnPct, input.active, reason, actorId],
      );
      if (made === undefined) throw new Error('log capacity insert returned no row');
      row = policyOf(made);
    } else {
      const [changed] = await tx.query<PolicySql>(
        `update machvon.log_capacity_policy set max_rows = $2::bigint, max_bytes = $3::bigint, warn_pct = $4, active = $5, reason = $6, version = version + 1, updated_at = now(), updated_by = $7::uuid
          where id = $1::uuid returning ${COLUMNS}`,
        [before.id, input.maxRows, input.maxBytes, input.warnPct, input.active, reason, actorId],
      );
      if (changed === undefined) throw new Error('log capacity update returned no row');
      row = policyOf(changed);
    }
    const action = before === undefined ? 'CREATED' : before.active && !row.active ? 'REMOVED' : 'CHANGED';
    await tx.query(
      `insert into machvon.log_capacity_policy_event (tenant_id, policy_id, action, reason, actor_id, snapshot, policy_version)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2, $3, $4::uuid, $5::jsonb, $6)`,
      [row.id, action, reason, actorId, JSON.stringify({ record_class: row.recordClass, max_rows: row.maxRows, max_bytes: row.maxBytes, warn_pct: row.warnPct, active: row.active }), row.version],
    );
    return { row, before };
  }
}
