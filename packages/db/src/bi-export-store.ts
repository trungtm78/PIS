import { randomUUID } from 'node:crypto';
import type { BiExportFormat, BiScheduleFormat } from '@machvon/kernel';
import { assertTimestampCursor } from './keyset.ts';
import type { TenantTx } from './tenant-database.ts';

export type BiExportStatus = 'QUEUED' | 'RUNNING' | 'READY' | 'DENIED' | 'FAILED' | 'EXPIRED';
export type BiScheduleStatus = 'ACTIVE' | 'PAUSED' | 'RETIRED';

export interface BiExportJobRow {
  id: string;
  requestedBy: string;
  subjectUserId: string;
  subjectName: string | null;
  scheduleId: string | null;
  querySpec: Record<string, unknown>;
  asOfPeriod: string;
  datasetVersionId: string;
  scopeHash: string;
  scopeDescription: string;
  format: BiExportFormat;
  rowCount: number | null;
  rowCap: number;
  truncated: boolean;
  fileObjectKey: string | null;
  fileSha256: string | null;
  status: BiExportStatus;
  deniedReason: string | null;
  expiresAt: string | null;
  createdAt: string;
  version: number;
}

export interface BiExportJobInput {
  requestedBy: string;
  subjectUserId: string;
  scheduleId: string | null;
  querySpec: Record<string, unknown>;
  asOfPeriod: string;
  datasetVersionId: string;
  scopeHash: string;
  scopeDescription: string;
  format: BiExportFormat;
  rowCap: number;
}

export interface BiScheduleRow {
  id: string;
  dashboardId: string | null;
  querySpec: Record<string, unknown>;
  cron: string;
  timezone: string;
  format: BiScheduleFormat;
  recipients: string[];
  status: BiScheduleStatus;
  ownerUserId: string;
  ownerName: string | null;
  lastRunAt: string | null;
  createdAt: string;
  version: number;
}

export interface BiScheduleInput {
  dashboardId: string | null;
  querySpec: Record<string, unknown>;
  cron: string;
  timezone: string;
  format: BiScheduleFormat;
  recipients: readonly string[];
  owner: string;
}

interface Sql {
  [column: string]: unknown;
  id: string;
  requested_by: string;
  subject_user_id: string;
  subject_name: string | null;
  schedule_id: string | null;
  query_spec: Record<string, unknown>;
  as_of_period: string;
  dataset_version_id: string;
  scope_description: string;
  format: "CSV" | "XLSX" | "PDF" | "LINK_ONLY";
  row_count: number | null;
  row_cap: number;
  truncated: boolean;
  file_object_key: string | null;
  status: BiExportStatus | BiScheduleStatus;
  denied_reason: string | null;
  dashboard_id: string | null;
  cron: string;
  timezone: string;
  recipients: string[];
  owner_user_id: string;
  owner_name: string | null;
  sort_key: string;
  scope_hash: string;
  file_sha256: string | null;
}

const iso = (value: unknown): string => new Date(value as string).toISOString();
const isoOrNull = (value: unknown): string | null => (value === null || value === undefined ? null : iso(value));

const JOB_SELECT = `select j.id, j.requested_by, j.subject_user_id, j.schedule_id, j.query_spec, j.as_of_period, j.dataset_version_id, j.scope_hash, j.scope_description, j.format, j.row_count, j.row_cap, j.truncated,
  j.file_object_key, j.file_sha256, j.status, j.denied_reason, j.expires_at, j.created_at, j.version::text as version,
  to_char(j.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as sort_key,
  (select u.display_name from machvon.tenant_user_directory u where u.tenant_id = j.tenant_id and u.membership_id = j.subject_user_id) as subject_name
  from machvon.bi_export_job j`;

const toJob = (row: Sql): BiExportJobRow => ({
  id: row.id,
  requestedBy: row.requested_by,
  subjectUserId: row.subject_user_id,
  subjectName: row.subject_name,
  scheduleId: row.schedule_id,
  querySpec: row.query_spec,
  asOfPeriod: row.as_of_period,
  datasetVersionId: row.dataset_version_id,
  scopeHash: row.scope_hash.trim(),
  scopeDescription: row.scope_description,
  format: row.format as "CSV" | "XLSX" | "PDF",
  rowCount: row.row_count,
  rowCap: row.row_cap,
  truncated: row.truncated,
  fileObjectKey: row.file_object_key,
  fileSha256: row.file_sha256 === null ? null : row.file_sha256.trim(),
  status: row.status as BiExportStatus,
  deniedReason: row.denied_reason,
  expiresAt: isoOrNull(row.expires_at),
  createdAt: iso(row.created_at),
  version: Number(row.version),
});

const SCHEDULE_SELECT = `select s.id, s.dashboard_id, s.query_spec, s.cron, s.timezone, s.format, s.recipients, s.status, s.owner_user_id, s.last_run_at, s.created_at, s.version::text as version,
  to_char(s.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as sort_key,
  (select u.display_name from machvon.tenant_user_directory u where u.tenant_id = s.tenant_id and u.membership_id = s.owner_user_id) as owner_name
  from machvon.bi_export_schedule s`;

const toSchedule = (row: Sql): BiScheduleRow => ({
  id: row.id,
  dashboardId: row.dashboard_id,
  querySpec: row.query_spec,
  cron: row.cron,
  timezone: row.timezone,
  format: row.format,
  recipients: row.recipients,
  status: row.status as BiScheduleStatus,
  ownerUserId: row.owner_user_id,
  ownerName: row.owner_name,
  lastRunAt: isoOrNull(row.last_run_at),
  createdAt: iso(row.created_at),
  version: Number(row.version),
});

type Anchor = { at: string; id: string } | undefined;

/**
 * The export jobs and the schedules that make them (ST-BI-008, BI 3 F7). A job is made for one person under the scope that person had when it ran, moves forward only (QUEUED, RUNNING, then READY with its file and when it
 * expires, or DENIED with the reason, or FAILED), and is EXPIRED when the days of its file are over. A schedule fixes what it asks and who receives it; its runner makes one job for each recipient.
 */
export class BiExportStore {
  // ---- the jobs ----------------------------------------------------------------------------------------------------------------------------

  async findJob(tx: TenantTx, id: string): Promise<BiExportJobRow | undefined> {
    const rows = await tx.query<Sql>(`${JOB_SELECT} where j.id = $1::uuid`, [id]);
    return rows[0] === undefined ? undefined : toJob(rows[0]);
  }

  /** The jobs of a subject (or of the whole tenant when none is given), the newest first. */
  async listJobs(tx: TenantTx, subject: string | undefined, page: { limit: number; after: Anchor }): Promise<{ records: BiExportJobRow[]; next: Anchor }> {
    assertTimestampCursor(page.after?.at);
    const rows = await tx.query<Sql>(
      `${JOB_SELECT}
        where ($1::uuid is null or j.subject_user_id = $1::uuid) and ($2::timestamptz is null or (j.created_at, j.id) < ($2::timestamptz, $3::uuid))
        order by j.created_at desc, j.id desc limit $4::int`,
      [subject ?? null, page.after?.at ?? null, page.after?.id ?? null, page.limit + 1],
    );
    const shown = rows.slice(0, page.limit);
    const last = shown.at(-1);
    return { records: shown.map(toJob), next: rows.length > page.limit && last !== undefined ? { at: last.sort_key, id: last.id } : undefined };
  }

  /** The job is made QUEUED, with the id the file will be stored under. */
  async createJob(tx: TenantTx, id: string, input: BiExportJobInput): Promise<BiExportJobRow> {
    await tx.query(
      `insert into machvon.bi_export_job (tenant_id, id, requested_by, subject_user_id, schedule_id, query_spec, as_of_period, dataset_version_id, scope_hash, scope_description, format, row_cap, status, created_by, updated_by)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::jsonb, $6, $7::uuid, $8, $9, $10, $11::int, 'QUEUED', $2::uuid, $2::uuid)`,
      [
        id,
        input.requestedBy,
        input.subjectUserId,
        input.scheduleId,
        JSON.stringify(input.querySpec),
        input.asOfPeriod,
        input.datasetVersionId,
        input.scopeHash,
        input.scopeDescription,
        input.format,
        input.rowCap,
      ],
    );
    return (await this.findJob(tx, id)) as BiExportJobRow;
  }

  async markRunning(tx: TenantTx, id: string): Promise<void> {
    await tx.query("update machvon.bi_export_job set status = 'RUNNING', updated_at = now(), version = version + 1 where id = $1::uuid", [id]);
  }

  async markReady(tx: TenantTx, id: string, input: { rowCount: number; fileObjectKey: string; fileSha256: string; expiresAt: Date }): Promise<BiExportJobRow> {
    await tx.query(
      "update machvon.bi_export_job set status = 'READY', row_count = $2::int, file_object_key = $3, file_sha256 = $4, expires_at = $5::timestamptz, updated_at = now(), version = version + 1 where id = $1::uuid",
      [id, input.rowCount, input.fileObjectKey, input.fileSha256, input.expiresAt.toISOString()],
    );
    return (await this.findJob(tx, id)) as BiExportJobRow;
  }

  /** The job ended without a file: a recipient who lost the right (DENIED, with the reason) or a run that failed. */
  async markEnded(tx: TenantTx, id: string, status: 'DENIED' | 'FAILED', reason: string): Promise<BiExportJobRow> {
    await tx.query('update machvon.bi_export_job set status = $2, denied_reason = $3, updated_at = now(), version = version + 1 where id = $1::uuid', [id, status, reason]);
    return (await this.findJob(tx, id)) as BiExportJobRow;
  }

  /** The READY jobs whose days are over, with the file to remove. */
  async dueForExpiry(tx: TenantTx, now: Date, limit: number = 200): Promise<BiExportJobRow[]> {
    const rows = await tx.query<Sql>(`${JOB_SELECT} where j.status = 'READY' and j.expires_at <= $1::timestamptz order by j.expires_at, j.id limit $2::int for update of j skip locked`, [
      now.toISOString(),
      limit,
    ]);
    return rows.map(toJob);
  }

  async markExpired(tx: TenantTx, id: string): Promise<void> {
    await tx.query("update machvon.bi_export_job set status = 'EXPIRED', updated_at = now(), version = version + 1 where id = $1::uuid and status = 'READY'", [id]);
  }

  // ---- the schedules -----------------------------------------------------------------------------------------------------------------------

  async findSchedule(tx: TenantTx, id: string): Promise<BiScheduleRow | undefined> {
    const rows = await tx.query<Sql>(`${SCHEDULE_SELECT} where s.id = $1::uuid`, [id]);
    return rows[0] === undefined ? undefined : toSchedule(rows[0]);
  }

  /** The schedules of an owner (or of the whole tenant when none is given), the newest first. */
  async listSchedules(tx: TenantTx, owner: string | undefined, page: { limit: number; after: Anchor }): Promise<{ records: BiScheduleRow[]; next: Anchor }> {
    assertTimestampCursor(page.after?.at);
    const rows = await tx.query<Sql>(
      `${SCHEDULE_SELECT}
        where ($1::uuid is null or s.owner_user_id = $1::uuid) and ($2::timestamptz is null or (s.created_at, s.id) < ($2::timestamptz, $3::uuid))
        order by s.created_at desc, s.id desc limit $4::int`,
      [owner ?? null, page.after?.at ?? null, page.after?.id ?? null, page.limit + 1],
    );
    const shown = rows.slice(0, page.limit);
    const last = shown.at(-1);
    return { records: shown.map(toSchedule), next: rows.length > page.limit && last !== undefined ? { at: last.sort_key, id: last.id } : undefined };
  }

  async createSchedule(tx: TenantTx, input: BiScheduleInput): Promise<BiScheduleRow> {
    const id = randomUUID();
    await tx.query(
      `insert into machvon.bi_export_schedule (tenant_id, id, dashboard_id, query_spec, cron, timezone, format, recipients, status, owner_user_id, created_by, updated_by)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3::jsonb, $4, $5, $6, $7::jsonb, 'ACTIVE', $8::uuid, $8::uuid, $8::uuid)`,
      [id, input.dashboardId, JSON.stringify(input.querySpec), input.cron, input.timezone, input.format, JSON.stringify(input.recipients), input.owner],
    );
    return (await this.findSchedule(tx, id)) as BiScheduleRow;
  }

  /** The active schedules, each locked while the runner makes its jobs (a second runner skips what the first holds). */
  async activeSchedules(tx: TenantTx): Promise<BiScheduleRow[]> {
    const rows = await tx.query<Sql>(`${SCHEDULE_SELECT} where s.status = 'ACTIVE' order by s.created_at, s.id for update of s skip locked`);
    return rows.map(toSchedule);
  }

  async markRun(tx: TenantTx, id: string, at: Date): Promise<void> {
    await tx.query('update machvon.bi_export_schedule set last_run_at = $2::timestamptz, updated_at = now(), version = version + 1 where id = $1::uuid', [id, at.toISOString()]);
  }

  /** Which of the memberships are of this tenant and active: a recipient that is not is out of the tenant. */
  async activeMembers(tx: TenantTx, ids: readonly string[]): Promise<string[]> {
    if (ids.length === 0) return [];
    const rows = await tx.query<{ id: string }>("select id from machvon.membership where id = any($1::uuid[]) and status = 'Active'", [ids]);
    return rows.map((row) => row.id);
  }
}
