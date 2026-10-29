import { DomainError, EXPORT_LINK_TTL_MS, parseCustomerKey } from '@machvon/kernel';
import type { ExportScopeKind } from '@machvon/kernel';
import type { ApprovalEffects } from './approval-store.ts';
import type { TenantTx } from './tenant-database.ts';

export const TENANT_EXPORT_READY_EVENT = 'sas.tenant_export.ready.v1';
export const TENANT_EXPORT_DELIVERED_EVENT = 'sas.tenant_export.delivered.v1';
/** The gauge of the exports that wait for the worker or run, for the alert that watches for an export that does not finish. */
export const TENANT_EXPORT_PENDING_GAUGE = 'tenant_export_pending';

const RESOURCE_TYPE = 'tenant_export_job';
export type ExportJobStatus = 'Requested' | 'Running' | 'Ready' | 'Delivered' | 'Failed' | 'Expired';

export interface ExportJobRow {
  id: string;
  tenantId: string;
  scope: ExportScopeKind;
  publicKeyPem: string | null;
  encryptionKeyFingerprint: string | null;
  status: ExportJobStatus;
  reason: string;
  requestedBy: string;
  requestedAt: Date;
  snapshotAt: Date | null;
  readyAt: Date | null;
  expiresAt: Date | null;
  deliveredAt: Date | null;
  manifestStorageKey: string | null;
  manifestSha256: string | null;
  fileCount: number | null;
  totalBytes: string | null;
  rowCounts: Record<string, number> | null;
  filesDownloaded: string[];
  errorCode: string | null;
  version: number;
}

interface JobDbRow {
  id: string;
  tenant_id: string;
  scope_json: { scope?: string; encryption_public_key_pem?: string | null };
  encryption_key_fingerprint: string | null;
  status: ExportJobStatus;
  reason: string;
  requested_by: string;
  requested_at: Date;
  snapshot_at: Date | null;
  ready_at: Date | null;
  expires_at: Date | null;
  delivered_at: Date | null;
  manifest_storage_key: string | null;
  manifest_sha256: string | null;
  file_count: number | null;
  total_bytes: string | null;
  row_counts: Record<string, number> | null;
  files_downloaded: string[];
  error_code: string | null;
  version: string;
}

const COLUMNS = `id, tenant_id, scope_json, encryption_key_fingerprint, status, reason, requested_by, requested_at, snapshot_at, ready_at, expires_at, delivered_at, manifest_storage_key, manifest_sha256, file_count, total_bytes::text as total_bytes, row_counts, files_downloaded, error_code, version::text as version`;

function jobOf(row: JobDbRow): ExportJobRow {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    scope: row.scope_json.scope === 'BUSINESS_DATA_ONLY' ? 'BUSINESS_DATA_ONLY' : 'FULL',
    publicKeyPem: row.scope_json.encryption_public_key_pem ?? null,
    encryptionKeyFingerprint: row.encryption_key_fingerprint,
    status: row.status,
    reason: row.reason,
    requestedBy: row.requested_by,
    requestedAt: row.requested_at,
    snapshotAt: row.snapshot_at,
    readyAt: row.ready_at,
    expiresAt: row.expires_at,
    deliveredAt: row.delivered_at,
    manifestStorageKey: row.manifest_storage_key,
    manifestSha256: row.manifest_sha256,
    fileCount: row.file_count,
    totalBytes: row.total_bytes,
    rowCounts: row.row_counts,
    filesDownloaded: row.files_downloaded,
    errorCode: row.error_code,
    version: Number(row.version),
  };
}

export interface ExportRequest {
  requestedBy: string;
  scope: ExportScopeKind;
  publicKeyPem?: string;
  reason: string;
}

export interface ExportReady {
  manifestStorageKey: string;
  manifestSha256: string;
  fileCount: number;
  totalBytes: number;
  rowCounts: Record<string, number>;
  snapshotAt: Date;
  /** The state of the tenant as the snapshot saw it. */
  tenantStatus: string;
}

export interface ExportPassResult {
  /** Jobs that were made Expired in this pass (their link ended without the export being delivered). */
  expired: string[];
  /** Jobs waiting for the worker or running after the pass. */
  pending: number;
}

/** A job that has run for this long is taken for lost. */
const STALLED_AFTER_MS = 2 * 3_600_000;

const quote = (identifier: string): string => `"${identifier.replaceAll('"', '""')}"`;

/**
 * The export of the data of a tenant (ST-SAS-016, SAS.md 3.10) on the tenant plane. The owner asks (`request`): one export at a time (409 EXPORT_ALREADY_RUNNING), in a tenant that is Active, Suspended with read and export, or
 * Offboarding (409 TENANT_STATE_INVALID otherwise). The worker claims it, reads the tables of the tenant in one REPEATABLE READ snapshot (`tablesOf`, `columnsOf`, `readRows`), stores the files and the manifest, and makes it Ready (`ready`):
 * its link lives 72 hours. Every download is recorded (`recordDownload`) and the export is Delivered once every file of the manifest has been downloaded; only then, or when the window to export is over, may the tenant be archived.
 */
export class TenantExportStore {
  // The transactions that have a cursor open.
  private readonly opened = new WeakSet<TenantTx>();

  async request(tx: TenantTx, effects: ApprovalEffects, input: ExportRequest, now: Date): Promise<ExportJobRow> {
    const reason = input.reason.trim();
    if (reason.length < 10 || reason.length > 2000) throw new DomainError('VALIDATION_FAILED', 422, 'reason');
    const key = input.publicKeyPem === undefined ? undefined : parseCustomerKey(input.publicKeyPem);
    const [runtime] = await tx.query<{ status: string; access_policy: string }>("select status, access_policy from machvon.tenant_runtime(nullif(current_setting('app.tenant_id', true), '')::uuid)");
    if (runtime === undefined || runtime.access_policy === 'NO_ACCESS' || !['Active', 'Suspended', 'Offboarding'].includes(runtime.status)) throw new DomainError('TENANT_STATE_INVALID', 409, runtime?.status);
    const [row] = await tx.query<JobDbRow>(
      `insert into machvon.tenant_export_job (tenant_id, id, scope_json, format, status, requested_by, reason, requested_at, encryption_key_fingerprint)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1::jsonb, 'JSONL_CSV_BUNDLE', 'Requested', $2::uuid, $3, $4::timestamptz, $5)
       on conflict (tenant_id) where status in ('Requested', 'Running') do nothing
       returning ${COLUMNS}`,
      [JSON.stringify({ scope: input.scope, encryption_public_key_pem: key?.pem ?? null }), input.requestedBy, reason, now.toISOString(), key?.fingerprint ?? null],
    );
    if (row === undefined) throw new DomainError('EXPORT_ALREADY_RUNNING', 409);
    const job = jobOf(row);
    await effects.audit({
      action: 'tenant.export_requested',
      resourceType: RESOURCE_TYPE,
      resourceId: job.id,
      reason,
      classification: 'CONFIDENTIAL',
      diff: { scope: input.scope, encrypted: key !== undefined, tenant_status: runtime.status },
    });
    return job;
  }

  /** Takes the oldest waiting job and makes it Running; another worker that asks at the same time gets another job or none. */
  async claim(tx: TenantTx): Promise<ExportJobRow | undefined> {
    const [waiting] = await tx.query<{ id: string }>("select id from machvon.tenant_export_job where status = 'Requested' order by requested_at, id limit 1 for update skip locked");
    if (waiting === undefined) return undefined;
    const [row] = await tx.query<JobDbRow>(`update machvon.tenant_export_job set status = 'Running', version = version + 1 where id = $1::uuid returning ${COLUMNS}`, [waiting.id]);
    return row === undefined ? undefined : jobOf(row);
  }

  /** The tables of the tenant plane that the role of the worker can read: the ones with row-level security that carry the tenant (sorted). Reading them is what the snapshot is for. */
  async tablesOf(tx: TenantTx): Promise<string[]> {
    return (await this.catalogue(tx)).filter((entry) => entry.readable).map((entry) => entry.name);
  }

  /** The tables of the tenant plane that the role of the worker cannot read (the theme drafts and reviews, for one): an export names them as not exported instead of writing them as empty. */
  async unreadableTablesOf(tx: TenantTx): Promise<string[]> {
    return (await this.catalogue(tx)).filter((entry) => !entry.readable).map((entry) => entry.name);
  }

  private async catalogue(tx: TenantTx): Promise<Array<{ name: string; readable: boolean }>> {
    const rows = await tx.query<{ relname: string; readable: boolean }>(
      `select c.relname, has_table_privilege(c.oid, 'select') as readable from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'machvon' and c.relkind in ('r', 'p') and c.relrowsecurity
          and exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'tenant_id' and a.attnum > 0 and not a.attisdropped)
        order by c.relname`,
    );
    return rows.map((row) => ({ name: row.relname, readable: row.readable }));
  }

  async columnsOf(tx: TenantTx, table: string): Promise<string[]> {
    const rows = await tx.query<{ column_name: string }>("select column_name from information_schema.columns where table_schema = 'machvon' and table_name = $1 order by ordinal_position", [table]);
    return rows.map((row) => row.column_name);
  }

  /**
   * Opens a cursor over the rows of a table inside the snapshot (the rows of other tenants are not visible: row-level security). The rows come in the order of the table and each is read once, however large the table is;
   * `nextRows` takes them a page at a time and `closeRows` ends the cursor. One cursor is open at a time in a transaction.
   */
  async openRows(tx: TenantTx, table: string, columns: readonly string[]): Promise<void> {
    if (columns.length === 0) return;
    this.opened.add(tx);
    await tx.query(`declare export_rows no scroll cursor for select ${columns.map(quote).join(', ')} from machvon.${quote(table)}`);
  }

  /** The next page of the open cursor (empty when there are no more rows or nothing was opened). */
  async nextRows(tx: TenantTx, limit: number): Promise<Array<Record<string, unknown>>> {
    if (!this.opened.has(tx)) return [];
    return tx.query<Record<string, unknown>>(`fetch forward ${Math.trunc(limit)} from export_rows`);
  }

  async closeRows(tx: TenantTx): Promise<void> {
    if (this.opened.delete(tx)) await tx.query('close export_rows');
  }

  /** The job is Ready: the manifest is stored, the link lives 72 hours from now. */
  async ready(tx: TenantTx, effects: ApprovalEffects, jobId: string, done: ExportReady, now: Date): Promise<ExportJobRow> {
    const expiresAt = new Date(now.getTime() + EXPORT_LINK_TTL_MS);
    const [row] = await tx.query<JobDbRow>(
      `update machvon.tenant_export_job set status = 'Ready', manifest_storage_key = $2, manifest_sha256 = $3, file_count = $4::int, total_bytes = $5::bigint, row_counts = $6::jsonb, snapshot_at = $7::timestamptz,
              ready_at = $8::timestamptz, expires_at = $9::timestamptz, snapshot_tenant_status = $10, version = version + 1
        where id = $1::uuid and status = 'Running' returning ${COLUMNS}`,
      [jobId, done.manifestStorageKey, done.manifestSha256, done.fileCount, done.totalBytes, JSON.stringify(done.rowCounts), done.snapshotAt.toISOString(), now.toISOString(), expiresAt.toISOString(), done.tenantStatus],
    );
    if (row === undefined) throw new DomainError('EXPORT_STATE_INVALID', 409);
    const job = jobOf(row);
    await effects.audit({ action: 'tenant.export_ready', resourceType: RESOURCE_TYPE, resourceId: job.id, classification: 'CONFIDENTIAL', diff: { files: done.fileCount, bytes: done.totalBytes, tables: Object.keys(done.rowCounts).length, expires_at: expiresAt.toISOString() } });
    await effects.emit({
      aggregateType: RESOURCE_TYPE,
      aggregateId: job.id,
      aggregateVersion: job.version,
      eventKey: `tenant_export:${job.id}:ready`,
      type: TENANT_EXPORT_READY_EVENT,
      schemaVersion: 1,
      payload: { export_id: job.id, files: done.fileCount, expires_at: expiresAt.toISOString() },
    });
    return job;
  }

  /** The job could not be made: it ends as Failed with the class of the failure (never its message: it may hold data). */
  async fail(tx: TenantTx, effects: ApprovalEffects, jobId: string, errorCode: string): Promise<void> {
    const [row] = await tx.query<JobDbRow>(`update machvon.tenant_export_job set status = 'Failed', error_code = $2, version = version + 1 where id = $1::uuid and status in ('Requested', 'Running') returning ${COLUMNS}`, [jobId, errorCode]);
    if (row === undefined) return;
    await effects.audit({ action: 'tenant.export_failed', resourceType: RESOURCE_TYPE, resourceId: jobId, classification: 'CONFIDENTIAL', diff: { error_code: errorCode } });
  }

  /**
   * One download of a file of a Ready export, with the paths the manifest lists. The export must be Ready (409 EXPORT_STATE_INVALID) and its link not over (422 EXPORT_EXPIRED); a path the manifest does not list is
   * not found. When every path has been downloaded the export is Delivered, and that is what lets the tenant be archived.
   */
  async recordDownload(tx: TenantTx, effects: ApprovalEffects, jobId: string, path: string, requiredPaths: readonly string[], now: Date): Promise<ExportJobRow> {
    const [locked] = await tx.query<JobDbRow>(`select ${COLUMNS} from machvon.tenant_export_job where id = $1::uuid for update`, [jobId]);
    if (locked === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const job = jobOf(locked);
    if (job.status === 'Delivered') {
      // Delivered exports stay downloadable until their link ends.
      if (job.expiresAt !== null && job.expiresAt.getTime() <= now.getTime()) throw new DomainError('EXPORT_EXPIRED', 422);
      return job;
    }
    if (job.status === 'Expired' || (job.status === 'Ready' && job.expiresAt !== null && job.expiresAt.getTime() <= now.getTime())) throw new DomainError('EXPORT_EXPIRED', 422);
    if (job.status !== 'Ready') throw new DomainError('EXPORT_STATE_INVALID', 409, job.status);
    if (!requiredPaths.includes(path)) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const downloaded = job.filesDownloaded.includes(path) ? job.filesDownloaded : [...job.filesDownloaded, path];
    const complete = requiredPaths.every((required) => downloaded.includes(required));
    const [row] = await tx.query<JobDbRow>(
      complete
        ? `update machvon.tenant_export_job set files_downloaded = $2::text[], status = 'Delivered', delivered_at = $3::timestamptz, downloaded_at = $3::timestamptz, version = version + 1 where id = $1::uuid returning ${COLUMNS}`
        : `update machvon.tenant_export_job set files_downloaded = $2::text[], downloaded_at = coalesce(downloaded_at, $3::timestamptz), version = version + 1 where id = $1::uuid returning ${COLUMNS}`,
      [jobId, downloaded, now.toISOString()],
    );
    const updated = jobOf(row as JobDbRow);
    if (complete) {
      await effects.audit({ action: 'tenant.export_delivered', resourceType: RESOURCE_TYPE, resourceId: jobId, classification: 'CONFIDENTIAL', diff: { files: requiredPaths.length } });
      await effects.emit({
        aggregateType: RESOURCE_TYPE,
        aggregateId: jobId,
        aggregateVersion: updated.version,
        eventKey: `tenant_export:${jobId}:delivered`,
        type: TENANT_EXPORT_DELIVERED_EVENT,
        schemaVersion: 1,
        payload: { export_id: jobId, files: requiredPaths.length },
      });
    }
    return updated;
  }

  /** The pass of the worker for the tenant: a Ready export whose link has ended without a delivery is Expired; tells how many jobs wait or run. */
  async sweep(tx: TenantTx, effects: ApprovalEffects, now: Date): Promise<ExportPassResult> {
    const ended = await tx.query<{ id: string }>("update machvon.tenant_export_job set status = 'Expired', version = version + 1 where status = 'Ready' and expires_at <= $1::timestamptz returning id", [now.toISOString()]);
    for (const job of ended) await effects.audit({ action: 'tenant.export_expired', resourceType: RESOURCE_TYPE, resourceId: job.id, classification: 'CONFIDENTIAL', diff: {} });
    // A job that has been running for hours belongs to a process that is gone: it ends as Failed, and the owner can ask again.
    const stalled = await tx.query<{ id: string }>("update machvon.tenant_export_job set status = 'Failed', error_code = 'Stalled', version = version + 1 where status = 'Running' and requested_at <= $1::timestamptz returning id", [new Date(now.getTime() - STALLED_AFTER_MS).toISOString()]);
    for (const job of stalled) await effects.audit({ action: 'tenant.export_failed', resourceType: RESOURCE_TYPE, resourceId: job.id, classification: 'CONFIDENTIAL', diff: { error_code: 'Stalled' } });
    const [pending] = await tx.query<{ n: string }>("select count(*)::text as n from machvon.tenant_export_job where status in ('Requested', 'Running')");
    return { expired: ended.map((job) => job.id), pending: Number(pending?.n ?? 0) };
  }

  /** The exports that wait for the worker or run: the backlog, counted before the worker drains it. */
  async pendingCount(tx: TenantTx): Promise<number> {
    const [row] = await tx.query<{ n: string }>("select count(*)::text as n from machvon.tenant_export_job where status in ('Requested', 'Running')");
    return Number(row?.n ?? 0);
  }

  /** How many exports the tenant has asked for: the version of the list of its exports (the If-Match of a new request). */
  async count(tx: TenantTx): Promise<number> {
    const [row] = await tx.query<{ n: string }>('select count(*)::text as n from machvon.tenant_export_job');
    return Number(row?.n ?? 0);
  }

  async find(tx: TenantTx, id: string): Promise<ExportJobRow | undefined> {
    const [row] = await tx.query<JobDbRow>(`select ${COLUMNS} from machvon.tenant_export_job where id = $1::uuid`, [id]);
    return row === undefined ? undefined : jobOf(row);
  }

  /** The exports of the tenant, the newest first, a page at a time. */
  async list(tx: TenantTx, filter: { limit: number; after?: { requestedAt: string; id: string } }): Promise<ExportJobRow[]> {
    const rows = await tx.query<JobDbRow>(
      `select ${COLUMNS} from machvon.tenant_export_job where ($2::timestamptz is null or (requested_at, id) < ($2::timestamptz, $3::uuid)) order by requested_at desc, id desc limit $1::int`,
      [filter.limit, filter.after?.requestedAt ?? null, filter.after?.id ?? null],
    );
    return rows.map(jobOf);
  }
}
