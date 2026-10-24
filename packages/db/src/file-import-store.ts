import { DUPLICATE_CONFLICT_CODE, DomainError, NOOP_METRICS, assertRejection, maskedPreview, fileSha256, planFileImport } from '@machvon/kernel';
import type { Difference, FileImportFormat, FilePlan, MetricsSink, PlannedAccepted, PlannedRejected, Rejection } from '@machvon/kernel';
import { enqueueOutbox } from './outbox.ts';
import { DEFAULT_ITEM_DUE_SECONDS, isActiveMember, normalizeUuid, openItem } from './file-import-item-store.ts';
import { timestampKey } from './keyset.ts';
import type { TenantTx } from './tenant-database.ts';

/** Counter of the rows a file import refused, by connector and reason. */
export const FILE_IMPORT_QUARANTINED_METRIC = 'file_import_rows_quarantined_total';
/** Counter of the imports that ended, by connector and outcome. */
export const FILE_IMPORT_FINISHED_METRIC = 'file_import_finished_total';
/** The events the outbox carries, so the module that owns the data (and the notifications to an owner) can follow an import. */
export const FILE_IMPORT_COMPLETED_EVENT = 'file_import.completed';
export const FILE_IMPORT_FAILED_EVENT = 'file_import.failed';
export const FILE_IMPORT_DIFFERENCE_EVENT = 'file_import.difference_opened';

const ISO = `'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'`;
const SHA256 = /^[0-9a-f]{64}$/;
const OBJECT_KEY_MAX = 500;
const CURSOR_SCOPE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const TENANT = "nullif(current_setting('app.tenant_id', true), '')::uuid";

/** What the module knows about one accepted row when the framework hands it over. */
export interface ImportEntry<R> {
  line: number;
  businessKey: string;
  record: R;
  fields: Readonly<Record<string, string>>;
  measure: string | undefined;
  rowHash: string;
}

export interface ApplyContext {
  importId: string;
  line: number;
  businessKey: string;
  rowHash: string;
}

/**
 * A concrete file format plugged into the framework: the pure `FileImportFormat` (read bytes, judge a row) and the two steps that touch
 * the module's own data. A module writes one of these per connector (PAY: the Treasury statement; DIS, CAP, BID, MDM: their files);
 * the framework owns the file identity, the row identity, the quarantine and the reconciliation items.
 */
export interface FileImportAdapter<R> extends FileImportFormat<R> {
  /**
   * Judges an accepted row against what the tenant holds (does the project exist, is the period open). It only reads: a row it refuses
   * goes to quarantine and is not claimed. It is not called for a row seen before.
   */
  examine?(tx: TenantTx, entry: ImportEntry<R>): Promise<Rejection | undefined>;
  /**
   * Writes the row into the module's own tables, in the transaction of the import, once per business key ever. It returns the differences
   * it finds between the row and what the module holds; each one becomes an item with an owner. It throws only for a defect: a bad row is
   * for `judge` or `examine`, and a throw rolls the whole import back.
   */
  apply(tx: TenantTx, entry: ImportEntry<R>, context: ApplyContext): Promise<readonly Difference[]>;
  /** Who owns a difference (the officer of the project, the reconciliation officer). Without an answer the fallback owner of the run takes it. */
  ownerFor?(tx: TenantTx, subject: { code: string; businessKey: string; line: number }): Promise<string | undefined>;
}

export interface RunFileImportInput<R> {
  adapter: FileImportAdapter<R>;
  /** The file exactly as stored. Its SHA-256 is its identity. */
  bytes: Uint8Array;
  /** Where the file is kept (the object storage key of the upload with purpose 'import'). */
  fileObjectKey: string;
  /** The hash that the upload recorded, when the caller has it: a file that does not match it is 422 HASH_MISMATCH. */
  expectedSha256?: string;
  importedBy: string;
  /** Owns every difference that `ownerFor` does not name; an active member of the tenant. */
  fallbackOwnerId: string;
  correlationId: string;
  /** How long an item has to be settled, unless the difference says otherwise. */
  dueAfterSeconds?: number;
  /**
   * The position of the connector (`integration_cursor.source_scope`) to keep in step: the connector must be ACTIVE for the file to be
   * taken, a read file moves its last file and success time, and an unreadable file marks it FAILED until a reset. A tenant without that
   * position row is not affected.
   */
  cursorScope?: string;
  maxRows?: number;
  now?: Date;
  metrics?: MetricsSink;
}

export type FileImportOutcome = 'APPLIED' | 'ALREADY_IMPORTED' | 'FAILED';

export interface FileImportCounts {
  total: number;
  applied: number;
  duplicate: number;
  conflict: number;
  quarantined: number;
  differencesOpened: number;
}

export interface FileImportResult {
  outcome: FileImportOutcome;
  importId: string;
  counts: FileImportCounts;
  /** Why the file could not be read, when the outcome is FAILED (IMPORT_SCHEMA_INVALID, IMPORT_EMPTY). */
  errorCode: string | null;
}

export interface FileImportRecord {
  id: string;
  connectorCode: string;
  formatVersion: string;
  fileSha256: string;
  fileObjectKey: string;
  status: 'IMPORTING' | 'APPLIED' | 'FAILED';
  errorCode: string | null;
  counts: FileImportCounts;
  importedBy: string;
  createdAt: string;
  createdAtKey: string;
  completedAt: string | null;
}

export interface QuarantinedRow {
  id: string;
  line: number;
  businessKey: string | null;
  errorCode: string;
  field: string;
  maskedPreview: Record<string, string> | null;
}

/** The sums that certified totals are made of: every row applied once, never a quarantined row, never a repeat. */
export interface FileImportTotals {
  rows: number;
  /** The exact sum of the measures of those rows, as a decimal string. */
  measure: string;
  /** The items still open for the connector: differences that nobody has settled yet. */
  openDifferences: number;
}

interface ImportSql {
  id: string;
  connector_code: string;
  format_version: string;
  file_sha256: string;
  file_object_key: string;
  status: FileImportRecord['status'];
  error_code: string | null;
  rows_total: number;
  rows_applied: number;
  rows_duplicate: number;
  rows_conflict: number;
  rows_quarantined: number;
  differences_opened: number;
  imported_by: string;
  created_at: string;
  created_at_key: string;
  completed_at: string | null;
}

const SELECT = `select id, connector_code, format_version, file_sha256, file_object_key, status, error_code, rows_total, rows_applied, rows_duplicate, rows_conflict,
  rows_quarantined, differences_opened, imported_by, to_char(created_at at time zone 'UTC', ${ISO}) as created_at, ${timestampKey('created_at')} as created_at_key,
  to_char(completed_at at time zone 'UTC', ${ISO}) as completed_at
  from machvon.file_import`;

const countsOf = (row: ImportSql): FileImportCounts => ({
  total: row.rows_total,
  applied: row.rows_applied,
  duplicate: row.rows_duplicate,
  conflict: row.rows_conflict,
  quarantined: row.rows_quarantined,
  differencesOpened: row.differences_opened,
});

const toRecord = (row: ImportSql): FileImportRecord => ({
  id: row.id,
  connectorCode: row.connector_code,
  formatVersion: row.format_version,
  fileSha256: row.file_sha256,
  fileObjectKey: row.file_object_key,
  status: row.status,
  errorCode: row.error_code,
  counts: countsOf(row),
  importedBy: row.imported_by,
  createdAt: row.created_at,
  createdAtKey: row.created_at_key,
  completedAt: row.completed_at,
});

const byKey = (a: { row: { businessKey: string }; line: number }, b: { row: { businessKey: string }; line: number }): number =>
  a.row.businessKey < b.row.businessKey ? -1 : a.row.businessKey > b.row.businessKey ? 1 : a.line - b.line;

const ZERO_COUNTS: FileImportCounts = { total: 0, applied: 0, duplicate: 0, conflict: 0, quarantined: 0, differencesOpened: 0 };
const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);

/** What the framework knows of a row it has applied before. */
interface ClaimedRow {
  row_hash: string;
  first_import_id: string;
  first_line: number;
  measure: string | null;
}

/**
 * The idempotent file import (ST-KERNEL-070, NFR-OPERABILITY-06). One call takes one file in the caller's tenant transaction:
 *
 * 1. The file is claimed by its SHA-256 for the connector. A file taken before (and not FAILED) answers ALREADY_IMPORTED with the
 *    earlier import and changes nothing; of two calls at once exactly one wins the claim and the other waits for it and answers so.
 * 2. Every row is judged. A row that is refused is quarantined with its line, field and code. A row whose business key was applied before
 *    is skipped when it has the same content (DUPLICATE) and, when the content differs, leaves the original as it is and opens a
 *    DUPLICATE_CONFLICT item (CONFLICT). A new row is claimed by its key, written by the module and counted in the totals.
 * 3. Each difference the module reports becomes an item with an owner and a due time.
 *
 * Everything happens in one transaction, so a defect leaves nothing behind and the same file can be tried again.
 */
export class FileImportStore {
  async run<R>(tx: TenantTx, input: RunFileImportInput<R>): Promise<FileImportResult> {
    const { adapter } = input;
    const metrics = input.metrics ?? NOOP_METRICS;
    const now = input.now ?? new Date();
    const importedBy = normalizeUuid(input.importedBy, 'imported_by');
    const fallbackOwner = normalizeUuid(input.fallbackOwnerId, 'owner_membership_id');
    const objectKey = input.fileObjectKey.trim();
    if (objectKey === '' || objectKey.length > OBJECT_KEY_MAX) throw invalid('file_object_key');
    if (input.cursorScope !== undefined && !CURSOR_SCOPE.test(input.cursorScope)) throw invalid('cursor_scope');
    if (input.dueAfterSeconds !== undefined && (!Number.isInteger(input.dueAfterSeconds) || input.dueAfterSeconds < 0)) throw invalid('due_after_seconds');
    const sha = fileSha256(input.bytes);
    if (input.expectedSha256 !== undefined && (!SHA256.test(input.expectedSha256) || input.expectedSha256 !== sha)) throw new DomainError('HASH_MISMATCH', 422, 'file');
    if (!(await isActiveMember(tx, fallbackOwner))) throw invalid('owner_membership_id');

    if (input.cursorScope !== undefined) await this.requireActiveCursor(tx, adapter.connectorCode, input.cursorScope);

    const claimed = await tx.query<{ id: string }>(
      `insert into machvon.file_import (tenant_id, id, connector_code, format_version, file_sha256, file_object_key, imported_by, created_at)
       values (${TENANT}, gen_random_uuid(), $1, $2, $3, $4, $5::uuid, $6::timestamptz)
       on conflict (tenant_id, connector_code, file_sha256) where status <> 'FAILED' do nothing
       returning id`,
      [adapter.connectorCode, adapter.formatVersion, sha, objectKey, importedBy, now.toISOString()],
    );
    if (claimed[0] === undefined) {
      const [earlier] = await tx.query<ImportSql>(`${SELECT} where connector_code = $1 and file_sha256 = $2 and status <> 'FAILED'`, [adapter.connectorCode, sha]);
      if (earlier === undefined) throw new Error('file import vanished after a key conflict');
      metrics.increment(FILE_IMPORT_FINISHED_METRIC, { connector: adapter.connectorCode, outcome: 'ALREADY_IMPORTED' });
      return { outcome: 'ALREADY_IMPORTED', importId: earlier.id, counts: countsOf(earlier), errorCode: null };
    }
    const importId = claimed[0].id;

    let plan: FilePlan<R>;
    try {
      plan = planFileImport(adapter, input.bytes, input.maxRows);
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
      return this.fail(tx, { importId, adapter, errorCode: error.code, input: { ...input, importedBy }, sha, now, metrics });
    }

    const counts: FileImportCounts = { ...ZERO_COUNTS, total: plan.rows.length };
    const owners = new Map<string, boolean>([[fallbackOwner, true]]);
    const ownerOf = async (subject: { code: string; businessKey: string; line: number }): Promise<string> => {
      const named = adapter.ownerFor === undefined ? undefined : await adapter.ownerFor(tx, subject);
      if (named === undefined) return fallbackOwner;
      const owner = normalizeUuid(named, 'owner_membership_id');
      if (!owners.has(owner)) owners.set(owner, await isActiveMember(tx, owner));
      return owners.get(owner) === true ? owner : fallbackOwner;
    };
    const openDifference = async (difference: Difference, where: { line: number; businessKey: string; rowHash: string }): Promise<void> => {
      const ownerId = await ownerOf({ code: difference.code, businessKey: where.businessKey, line: where.line });
      const item = await openItem(tx, {
        importId,
        line: where.line,
        connectorCode: adapter.connectorCode,
        businessKey: where.businessKey,
        difference,
        rowHash: where.rowHash,
        ownerId,
        now,
        dueAfterSeconds: input.dueAfterSeconds ?? DEFAULT_ITEM_DUE_SECONDS,
      });
      if (!item.created) return;
      counts.differencesOpened += 1;
      await enqueueOutbox(tx, {
        aggregateType: 'file_import_reconciliation_item',
        aggregateId: item.id,
        aggregateVersion: 1,
        type: FILE_IMPORT_DIFFERENCE_EVENT,
        schemaVersion: 1,
        payload: { import_id: importId, connector_code: adapter.connectorCode, code: difference.code, owner_membership_id: ownerId, due_at: item.dueAt },
        eventKey: `file-import-item:${item.id}`,
        correlationId: input.correlationId,
      });
    };

    for (const planned of plan.rows) {
      if (planned.accepted) continue;
      await this.quarantine(tx, importId, planned);
      counts.quarantined += 1;
      metrics.increment(FILE_IMPORT_QUARANTINED_METRIC, { connector: adapter.connectorCode, reason: planned.rejection.code });
    }

    // Rows are claimed in the order of their keys, not of the file: two files that carry the same keys in opposite orders would otherwise
    // each hold a key the other waits for, and the database would end one of them with a deadlock.
    const accepted = plan.rows.filter((planned): planned is PlannedAccepted<R> => planned.accepted).sort(byKey);
    for (const planned of accepted) {
      const entry: ImportEntry<R> = {
        line: planned.line,
        businessKey: planned.row.businessKey,
        record: planned.row.record,
        fields: planned.row.fields,
        measure: planned.row.measure,
        rowHash: planned.rowHash,
      };
      let earlier = await this.claimedRow(tx, adapter.connectorCode, entry.businessKey);
      if (earlier === undefined) {
        const refusal = adapter.examine === undefined ? undefined : await adapter.examine(tx, entry);
        if (refusal !== undefined) {
          assertRejection(refusal);
          await this.quarantine(tx, importId, { line: planned.line, accepted: false, rejection: refusal, businessKey: entry.businessKey, rowHash: entry.rowHash, preview: maskedPreview(adapter, planned.values) });
          counts.quarantined += 1;
          metrics.increment(FILE_IMPORT_QUARANTINED_METRIC, { connector: adapter.connectorCode, reason: refusal.code });
          continue;
        }
        const won = await tx.query<{ id: string }>(
          `insert into machvon.file_import_row (tenant_id, id, connector_code, business_key, row_hash, measure, first_import_id, first_line, created_at)
           values (${TENANT}, gen_random_uuid(), $1, $2, $3, $4::numeric, $5::uuid, $6, $7::timestamptz)
           on conflict (tenant_id, connector_code, business_key) do nothing
           returning id`,
          [adapter.connectorCode, entry.businessKey, entry.rowHash, entry.measure ?? null, importId, entry.line, now.toISOString()],
        );
        if (won[0] !== undefined) {
          const differences = await adapter.apply(tx, entry, { importId, line: entry.line, businessKey: entry.businessKey, rowHash: entry.rowHash });
          counts.applied += 1;
          for (const difference of differences) await openDifference(difference, entry);
          continue;
        }
        // Another import applied this key between the look and the claim; this row is then a repeat of it.
        earlier = await this.claimedRow(tx, adapter.connectorCode, entry.businessKey);
        if (earlier === undefined) throw new Error('file import row vanished after a key conflict');
      }
      if (earlier.row_hash === entry.rowHash) {
        counts.duplicate += 1;
        continue;
      }
      counts.conflict += 1;
      await openDifference(
        {
          code: DUPLICATE_CONFLICT_CODE,
          ...(earlier.measure === null ? {} : { expected: earlier.measure }),
          ...(entry.measure === undefined ? {} : { actual: entry.measure }),
          detail: `first applied in import ${earlier.first_import_id} line ${earlier.first_line}`,
        },
        entry,
      );
    }

    await tx.query(
      `update machvon.file_import
          set status = 'APPLIED', rows_total = $2, rows_applied = $3, rows_duplicate = $4, rows_conflict = $5, rows_quarantined = $6, differences_opened = $7,
              completed_at = $8::timestamptz
        where id = $1::uuid`,
      [importId, counts.total, counts.applied, counts.duplicate, counts.conflict, counts.quarantined, counts.differencesOpened, now.toISOString()],
    );
    if (input.cursorScope !== undefined) {
      await tx.query(
        `update machvon.integration_cursor
            set last_file_sha256 = $3, last_success_at = $5::timestamptz, last_error_code = null, updated_at = $5::timestamptz, updated_by = $4::uuid, version = version + 1
          where connector_code = $1 and source_scope = $2`,
        [adapter.connectorCode, input.cursorScope, sha, importedBy, now.toISOString()],
      );
    }
    await enqueueOutbox(tx, {
      aggregateType: 'file_import',
      aggregateId: importId,
      aggregateVersion: 1,
      type: FILE_IMPORT_COMPLETED_EVENT,
      schemaVersion: 1,
      payload: { connector_code: adapter.connectorCode, rows_total: counts.total, rows_applied: counts.applied, rows_duplicate: counts.duplicate, rows_conflict: counts.conflict, rows_quarantined: counts.quarantined, differences_opened: counts.differencesOpened },
      eventKey: `file-import:${importId}`,
      correlationId: input.correlationId,
    });
    metrics.increment(FILE_IMPORT_FINISHED_METRIC, { connector: adapter.connectorCode, outcome: 'APPLIED' });
    return { outcome: 'APPLIED', importId, counts, errorCode: null };
  }

  async find(tx: TenantTx, id: string): Promise<FileImportRecord | undefined> {
    const rows = await tx.query<ImportSql>(`${SELECT} where id = $1::uuid`, [normalizeUuid(id, 'id')]);
    return rows[0] === undefined ? undefined : toRecord(rows[0]);
  }

  /** The imports of the tenant, the newest first; the cursor is the creation time to the microsecond and the id of the last one. */
  async list(tx: TenantTx, request: { connectorCode?: string; limit: number; after: { key: string; id: string } | undefined }): Promise<FileImportRecord[]> {
    const rows = await tx.query<ImportSql>(
      `${SELECT}
        where ($1::text is null or connector_code = $1)
          and ($2::text is null or (${timestampKey('created_at')}, id) < ($2::text, $3::uuid))
        order by created_at desc, id desc limit $4`,
      [request.connectorCode ?? null, request.after?.key ?? null, request.after?.id ?? null, request.limit],
    );
    return rows.map(toRecord);
  }

  /** The rows an import refused, in the order of the file: each with its line, field and code. */
  async quarantined(tx: TenantTx, importId: string, limit: number): Promise<QuarantinedRow[]> {
    const rows = await tx.query<{ id: string; line: number; business_key: string | null; error_code: string; field: string; masked_preview: Record<string, string> | null }>(
      'select id, line, business_key, error_code, field, masked_preview from machvon.file_import_quarantine where import_id = $1::uuid order by line limit $2',
      [normalizeUuid(importId, 'import_id'), limit],
    );
    return rows.map((row) => ({ id: row.id, line: row.line, businessKey: row.business_key, errorCode: row.error_code, field: row.field, maskedPreview: row.masked_preview }));
  }

  /** The certified totals of a connector, or of what one import added to them. */
  async totals(tx: TenantTx, connectorCode: string, importId?: string): Promise<FileImportTotals> {
    const [sums] = await tx.query<{ n: string; measure: string }>(
      `select count(*)::text as n, trim_scale(coalesce(sum(measure), 0))::text as measure from machvon.file_import_row
        where connector_code = $1 and ($2::uuid is null or first_import_id = $2::uuid)`,
      [connectorCode, importId === undefined ? null : normalizeUuid(importId, 'import_id')],
    );
    const [open] = await tx.query<{ n: string }>("select count(*)::text as n from machvon.file_import_reconciliation_item where connector_code = $1 and status = 'OPEN'", [connectorCode]);
    return { rows: Number(sums?.n ?? 0), measure: sums?.measure ?? '0', openDifferences: Number(open?.n ?? 0) };
  }

  private async claimedRow(tx: TenantTx, connectorCode: string, businessKey: string): Promise<ClaimedRow | undefined> {
    const [row] = await tx.query<ClaimedRow>(
      'select row_hash, first_import_id, first_line, trim_scale(measure)::text as measure from machvon.file_import_row where connector_code = $1 and business_key = $2',
      [connectorCode, businessKey],
    );
    return row;
  }

  private async quarantine(tx: TenantTx, importId: string, row: PlannedRejected): Promise<void> {
    await tx.query(
      `insert into machvon.file_import_quarantine (tenant_id, id, import_id, line, business_key, error_code, field, row_hash, masked_preview)
       values (${TENANT}, gen_random_uuid(), $1::uuid, $2, $3, $4, $5, $6, $7::jsonb)`,
      [importId, row.line, row.businessKey, row.rejection.code, row.rejection.field, row.rowHash, row.preview === null ? null : JSON.stringify(row.preview)],
    );
  }

  /** The position of a connector that file imports keep in step: it must be ACTIVE, and it is locked so imports of one connector take turns. */
  private async requireActiveCursor(tx: TenantTx, connectorCode: string, sourceScope: string): Promise<void> {
    const [cursor] = await tx.query<{ status: string }>('select status from machvon.integration_cursor where connector_code = $1 and source_scope = $2 for update', [connectorCode, sourceScope]);
    if (cursor !== undefined && cursor.status !== 'ACTIVE') throw new DomainError('STAGE_TRANSITION_DENIED', 409, 'connector');
  }

  /** A file that cannot be read ends its try as FAILED, with the reason, and marks the connector; a later try of the same bytes is allowed. */
  private async fail<R>(
    tx: TenantTx,
    context: { importId: string; adapter: FileImportAdapter<R>; errorCode: string; input: RunFileImportInput<R>; sha: string; now: Date; metrics: MetricsSink },
  ): Promise<FileImportResult> {
    const { importId, adapter, errorCode, input, sha, now, metrics } = context;
    await tx.query("update machvon.file_import set status = 'FAILED', error_code = $2, completed_at = $3::timestamptz where id = $1::uuid", [importId, errorCode, now.toISOString()]);
    if (input.cursorScope !== undefined) {
      await tx.query(
        `update machvon.integration_cursor
            set status = 'FAILED', last_error_code = $3, updated_at = $5::timestamptz, updated_by = $4::uuid, version = version + 1
          where connector_code = $1 and source_scope = $2`,
        [adapter.connectorCode, input.cursorScope, errorCode, input.importedBy, now.toISOString()],
      );
    }
    await enqueueOutbox(tx, {
      aggregateType: 'file_import',
      aggregateId: importId,
      aggregateVersion: 1,
      type: FILE_IMPORT_FAILED_EVENT,
      schemaVersion: 1,
      payload: { connector_code: adapter.connectorCode, error_code: errorCode, file_sha256: sha },
      eventKey: `file-import:${importId}`,
      correlationId: input.correlationId,
    });
    metrics.increment(FILE_IMPORT_FINISHED_METRIC, { connector: adapter.connectorCode, outcome: 'FAILED' });
    return { outcome: 'FAILED', importId, counts: ZERO_COUNTS, errorCode };
  }
}
