import { DomainError, NOOP_METRICS, maskedPreview, planFileImport } from '@machvon/kernel';
import type { MetricsSink } from '@machvon/kernel';
import { DEFAULT_ITEM_DUE_SECONDS, normalizeUuid, openItem } from './file-import-item-store.ts';
import { FILE_IMPORT_DIFFERENCE_EVENT, FileImportStore } from './file-import-store.ts';
import { IntegrationCursorStore } from './integration-cursor-store.ts';
import { timestampKey } from './keyset.ts';
import { enqueueOutbox } from './outbox.ts';
import { createTreasuryStatementAdapter } from './pay-treasury-statement-adapter.ts';
import { TREASURY_CONNECTOR_CODE, TREASURY_FILE_PROVIDER, TREASURY_FORMAT_VERSION, createTreasuryStatementFormat } from './pay-treasury-statement-format.ts';
import type { TreasuryColumnMap } from './pay-treasury-statement-format.ts';
import type { TenantTx } from './tenant-database.ts';

/** The counter of the rows of a statement by what became of them: NEW, DUPLICATE, CONFLICT or ERROR (PAY 11, `pay_treasury_import_rows{outcome}`). */
export const TREASURY_IMPORT_ROWS_METRIC = 'pay_treasury_import_rows';
/** The position of the connector that statement imports keep (`integration_cursor.source_scope`). */
export const TREASURY_CURSOR_SCOPE = 'DEFAULT';
/** A row refused for a gap in master data that a person can close: the item that opens is theirs to work, and the corrected file takes the row. */
const MASTER_DATA_GAPS: ReadonlySet<string> = new Set(['CROSSWALK_MISSING', 'PROJECT_NOT_FOUND', 'CROSSWALK_TARGET_INVALID']);
/** The most rows an import page shows; a file has at most 5,000 and the counts above them are always exact. */
const ROW_PAGE = 500;

export type TreasuryImportSourceKind = 'STATEMENT_FILE' | 'EXPORT_FILE';
export type TreasuryImportStatus = 'APPLIED' | 'PARTIALLY_APPLIED';
export type TreasuryRowOutcome = 'NEW' | 'DUPLICATE' | 'CONFLICT' | 'ERROR';

export interface TreasuryImportInput {
  /** The file exactly as stored; its SHA-256 is its identity. */
  bytes: Uint8Array;
  fileObjectKey: string;
  /** The hash that the upload recorded (HASH_MISMATCH when the stored bytes differ). */
  expectedSha256: string;
  sourceKind: TreasuryImportSourceKind;
  /** The statement date the person states; a file does not have to carry one. */
  statementDate?: string | undefined;
  importedBy: string;
  correlationId: string;
  /** A name for the file when the caller has one; the upload keeps none, so the default is made of the hash. */
  fileName?: string | undefined;
  columns?: Partial<TreasuryColumnMap> | undefined;
  now?: Date;
  metrics?: MetricsSink | undefined;
}

export interface TreasuryImportCounts {
  total: number;
  new: number;
  duplicate: number;
  conflict: number;
  error: number;
}

export interface TreasuryImportResult {
  /** APPLIED or PARTIALLY_APPLIED for a file read now, ALREADY_IMPORTED for bytes taken before (nothing was written). */
  outcome: TreasuryImportStatus | 'ALREADY_IMPORTED';
  importId: string;
  fileSha256: string;
  counts: TreasuryImportCounts;
  /** The items that this call opened (conflicts, and rows refused for a gap in master data). */
  differencesOpened: number;
  /** The exact sum, in VND, of the transactions this call created. */
  appliedAmountVnd: string;
}

export interface TreasuryImportView {
  id: string;
  provider: string;
  sourceKind: TreasuryImportSourceKind;
  fileName: string;
  fileSha256: string;
  statementDate: string | null;
  status: TreasuryImportStatus;
  counts: TreasuryImportCounts;
  importedBy: string;
  /** The display name of the person, or null when the directory does not know them. */
  importedByName: string | null;
  importedAt: string;
  /** The import time to the microsecond (UTC): the ordering key of the list and its cursor. */
  importedAtKey: string;
}

export interface TreasuryImportRowView {
  rowNo: number;
  businessKey: string;
  outcome: TreasuryRowOutcome;
  errorCode: string | null;
  treasuryTransactionId: string | null;
  rawMasked: Record<string, string>;
}

export interface TreasuryImportItemView {
  id: string;
  code: string;
  businessKey: string;
  line: number;
  expected: string | null;
  actual: string | null;
  difference: string | null;
  ownerMembershipId: string;
  ownerName: string | null;
  dueAt: string;
  status: 'OPEN' | 'RESOLVED';
}

/** The state of the connector, for the screen that shows the adapter badge. */
export interface TreasuryConnectorView {
  connectorCode: string;
  formatVersion: string;
  /** PROPOSED until the agency confirms the layout; the platform never verifies a format on its own authority. */
  adapterStatus: string;
  status: string;
  lastErrorCode: string | null;
  lastSuccessAt: string | null;
}

export interface TreasuryTotals {
  /** The business keys ever applied. */
  rows: number;
  /** The exact sum of their amounts, in VND. */
  amountVnd: string;
  openDifferences: number;
}

interface HeaderSql {
  id: string;
  provider: string;
  source_kind: TreasuryImportSourceKind;
  file_name: string;
  file_sha256: string;
  statement_date: string | null;
  status: TreasuryImportStatus;
  row_total: number;
  row_new: number;
  row_duplicate: number;
  row_conflict: number;
  row_error: number;
  imported_by: string;
  imported_by_name: string | null;
  imported_at: string;
  imported_at_key: string;
}

const ISO = `'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'`;
const HEADER = `select i.id, i.provider, i.source_kind, i.file_name, i.file_sha256, i.statement_date::text as statement_date, i.status, i.row_total, i.row_new, i.row_duplicate, i.row_conflict,
  i.row_error, i.imported_by, d.display_name as imported_by_name, to_char(i.imported_at at time zone 'UTC', ${ISO}) as imported_at, ${timestampKey('i.imported_at')} as imported_at_key
  from machvon.treasury_import i left join machvon.tenant_user_directory d on d.tenant_id = i.tenant_id and d.membership_id = i.imported_by`;
const TENANT = "nullif(current_setting('app.tenant_id', true), '')::uuid";

const countsOf = (row: HeaderSql): TreasuryImportCounts => ({ total: row.row_total, new: row.row_new, duplicate: row.row_duplicate, conflict: row.row_conflict, error: row.row_error });

const viewOf = (row: HeaderSql): TreasuryImportView => ({
  id: row.id,
  provider: row.provider,
  sourceKind: row.source_kind,
  fileName: row.file_name,
  fileSha256: row.file_sha256,
  statementDate: row.statement_date,
  status: row.status,
  counts: countsOf(row),
  importedBy: row.imported_by,
  importedByName: row.imported_by_name,
  importedAt: row.imported_at,
  importedAtKey: row.imported_at_key,
});

interface RowDraft {
  row_no: number;
  business_key: string;
  row_hash: string;
  outcome: TreasuryRowOutcome;
  error_code: string | null;
  treasury_transaction_id: string | null;
  raw_masked: Record<string, string>;
}

/**
 * The Treasury statement import (ST-PAY-006, PAY 3.3 step 3, NFR-OPERABILITY-06). The file is read by the idempotent core of ST-KERNEL-070
 * (the file by its SHA-256, each row by its business key and hash, the quarantine, the items with an owner) through the Treasury adapter; this
 * store adds what is PAY's own: the import header and one line per row of the file with what became of it, the work items of the PAY
 * register for a row that came back with other content, and the totals that a repeated file cannot move. Everything runs in the tenant
 * transaction of the caller, so a defect leaves nothing and the same file can be tried again.
 */
export class PayTreasuryImportStore {
  private readonly core = new FileImportStore();
  private readonly cursors = new IntegrationCursorStore();

  async import(tx: TenantTx, input: TreasuryImportInput): Promise<TreasuryImportResult> {
    const metrics = input.metrics ?? NOOP_METRICS;
    const now = input.now ?? new Date();
    const importedBy = normalizeUuid(input.importedBy, 'imported_by');
    // The connector of a tenant that has none yet is created with the baseline ones, so its position is always kept.
    await this.cursors.ensureDefaults(tx, importedBy);
    const adapter = createTreasuryStatementAdapter({ actor: importedBy, ...(input.columns === undefined ? {} : { columns: input.columns }) });
    const run = await this.core.run(tx, {
      adapter,
      bytes: input.bytes,
      fileObjectKey: input.fileObjectKey,
      expectedSha256: input.expectedSha256,
      importedBy,
      fallbackOwnerId: importedBy,
      correlationId: input.correlationId,
      cursorScope: TREASURY_CURSOR_SCOPE,
      now,
      metrics,
    });
    if (run.outcome === 'FAILED') throw new DomainError('TREASURY_IMPORT_SCHEMA_INVALID', 422, 'file');
    if (run.outcome === 'ALREADY_IMPORTED') {
      const earlier = await this.find(tx, run.importId);
      if (earlier === undefined) throw new Error('a statement was imported before without its header');
      return { outcome: 'ALREADY_IMPORTED', importId: run.importId, fileSha256: earlier.fileSha256, counts: earlier.counts, differencesOpened: 0, appliedAmountVnd: '0' };
    }
    const counts: TreasuryImportCounts = { total: run.counts.total, new: run.counts.applied, duplicate: run.counts.duplicate, conflict: run.counts.conflict, error: run.counts.quarantined };
    const status: TreasuryImportStatus = counts.error > 0 || counts.conflict > 0 ? 'PARTIALLY_APPLIED' : 'APPLIED';
    const sha = input.expectedSha256;
    await tx.query(
      `insert into machvon.treasury_import
         (tenant_id, id, provider, source_kind, file_name, file_sha256, file_object_key, statement_date, row_total, row_new, row_duplicate, row_conflict, row_error,
          status, imported_by, imported_at, created_by)
       values (${TENANT}, $1::uuid, $2, $3, $4, $5, $6, $7::date, $8, $9, $10, $11, $12, $13, $14::uuid, $15::timestamptz, $14::uuid)`,
      [
        run.importId,
        TREASURY_FILE_PROVIDER,
        input.sourceKind,
        (input.fileName ?? `statement-${sha.slice(0, 12)}`).slice(0, 200),
        sha,
        input.fileObjectKey.trim(),
        input.statementDate ?? null,
        counts.total,
        counts.new,
        counts.duplicate,
        counts.conflict,
        counts.error,
        status,
        importedBy,
        now.toISOString(),
      ],
    );
    await this.recordRows(tx, run.importId, input.bytes, importedBy, input.columns);
    await this.mirrorConflicts(tx, run.importId, importedBy);
    const gaps = await this.openGapItems(tx, run.importId, importedBy, input.correlationId, now);
    for (const [outcome, count] of [['NEW', counts.new], ['DUPLICATE', counts.duplicate], ['CONFLICT', counts.conflict], ['ERROR', counts.error]] as const) {
      for (let counted = 0; counted < count; counted += 1) metrics.increment(TREASURY_IMPORT_ROWS_METRIC, { outcome });
    }
    const added = await this.core.totals(tx, TREASURY_CONNECTOR_CODE, run.importId);
    return { outcome: status, importId: run.importId, fileSha256: sha, counts, differencesOpened: run.counts.differencesOpened + gaps, appliedAmountVnd: added.measure };
  }

  /** The imports of the tenant, the newest first; the cursor is the import time to the microsecond and the id of the last one. */
  async list(tx: TenantTx, request: { limit: number; after: { code: string; id: string } | undefined }): Promise<TreasuryImportView[]> {
    const rows = await tx.query<HeaderSql>(
      `${HEADER}
        where ($1::text is null or (${timestampKey('i.imported_at')}, i.id) < ($1::text, $2::uuid))
        order by i.imported_at desc, i.id desc limit $3`,
      [request.after?.code ?? null, request.after?.id ?? null, request.limit],
    );
    return rows.map(viewOf);
  }

  /** One import with its counts; undefined when the tenant has none with this id. */
  async find(tx: TenantTx, id: string): Promise<TreasuryImportView | undefined> {
    const rows = await tx.query<HeaderSql>(`${HEADER} where i.id = $1::uuid`, [normalizeUuid(id, 'id')]);
    return rows[0] === undefined ? undefined : viewOf(rows[0]);
  }

  /** The lines of an import in the order of the file, at most one page; the counts of the header are always those of the whole file. */
  async rows(tx: TenantTx, importId: string): Promise<{ rows: TreasuryImportRowView[]; truncated: boolean }> {
    const found = await tx.query<RowDraft>(
      `select row_no, business_key, row_hash, outcome, error_code, treasury_transaction_id, raw_masked from machvon.treasury_import_row
        where import_id = $1::uuid order by row_no limit $2`,
      [normalizeUuid(importId, 'import_id'), ROW_PAGE + 1],
    );
    return {
      rows: found.slice(0, ROW_PAGE).map((row) => ({ rowNo: row.row_no, businessKey: row.business_key, outcome: row.outcome, errorCode: row.error_code, treasuryTransactionId: row.treasury_transaction_id, rawMasked: row.raw_masked })),
      truncated: found.length > ROW_PAGE,
    };
  }

  /** The items that the import opened: a row that came back with other content, and a row refused for a gap in master data. */
  async items(tx: TenantTx, importId: string): Promise<TreasuryImportItemView[]> {
    const found = await tx.query<{
      id: string;
      code: string;
      business_key: string;
      line: number;
      expected_value: string | null;
      actual_value: string | null;
      difference: string | null;
      owner_membership_id: string;
      owner_name: string | null;
      due_at: string;
      status: 'OPEN' | 'RESOLVED';
    }>(
      `select r.id, r.code, r.business_key, r.line, r.expected_value, r.actual_value, r.difference, r.owner_membership_id, d.display_name as owner_name,
              to_char(r.due_at at time zone 'UTC', ${ISO}) as due_at, r.status
         from machvon.file_import_reconciliation_item r
         left join machvon.tenant_user_directory d on d.tenant_id = r.tenant_id and d.membership_id = r.owner_membership_id
        where r.import_id = $1::uuid order by r.line, r.code`,
      [normalizeUuid(importId, 'import_id')],
    );
    return found.map((item) => ({
      id: item.id,
      code: item.code,
      businessKey: item.business_key,
      line: item.line,
      expected: item.expected_value,
      actual: item.actual_value,
      difference: item.difference,
      ownerMembershipId: item.owner_membership_id,
      ownerName: item.owner_name,
      dueAt: item.due_at,
      status: item.status,
    }));
  }

  /** Where the connector stands: the layout version, the verdict on the adapter (PROPOSED), the state and the last error. */
  async connector(tx: TenantTx): Promise<TreasuryConnectorView> {
    const [cursor] = await tx.query<{ adapter_status: string; status: string; last_error_code: string | null; last_success_at: string | null }>(
      `select adapter_status, status, last_error_code, to_char(last_success_at at time zone 'UTC', ${ISO}) as last_success_at
         from machvon.integration_cursor where connector_code = $1 and source_scope = $2`,
      [TREASURY_CONNECTOR_CODE, TREASURY_CURSOR_SCOPE],
    );
    return {
      connectorCode: TREASURY_CONNECTOR_CODE,
      formatVersion: TREASURY_FORMAT_VERSION,
      adapterStatus: cursor?.adapter_status ?? 'PROPOSED',
      status: cursor?.status ?? 'ACTIVE',
      lastErrorCode: cursor?.last_error_code ?? null,
      lastSuccessAt: cursor?.last_success_at ?? null,
    };
  }

  /** The certified totals of the statements: every business key once, a quarantined row never, a repeated file nothing more. */
  async totals(tx: TenantTx, importId?: string): Promise<TreasuryTotals> {
    const totals = await this.core.totals(tx, TREASURY_CONNECTOR_CODE, importId);
    return { rows: totals.rows, amountVnd: totals.measure, openDifferences: totals.openDifferences };
  }

  /**
   * One line per row of the file with what became of it. The core already decided: the row is NEW when this import claimed its key on this
   * line, a DUPLICATE when the key was claimed with the same hash, a CONFLICT when it was claimed with another, and an ERROR when it is in
   * the quarantine. This reads the facts back and writes the PAY view of them; it decides nothing.
   */
  private async recordRows(tx: TenantTx, importId: string, bytes: Uint8Array, actor: string, columns: Partial<TreasuryColumnMap> | undefined): Promise<void> {
    const format = createTreasuryStatementFormat(columns === undefined ? {} : { columns });
    const plan = planFileImport(format, bytes);
    const quarantined = new Map(
      (
        await tx.query<{ line: number; business_key: string | null; error_code: string; masked_preview: Record<string, string> | null; row_hash: string }>(
          'select line, business_key, error_code, masked_preview, row_hash from machvon.file_import_quarantine where import_id = $1::uuid',
          [importId],
        )
      ).map((row) => [row.line, row]),
    );
    const keys = plan.rows.flatMap((planned) => (planned.accepted ? [planned.row.businessKey] : []));
    const claimed = new Map(
      (
        await tx.query<{ business_key: string; row_hash: string; first_import_id: string; first_line: number }>(
          'select business_key, row_hash, first_import_id, first_line from machvon.file_import_row where connector_code = $1 and business_key = any($2::text[])',
          [TREASURY_CONNECTOR_CODE, keys],
        )
      ).map((row) => [row.business_key, row]),
    );
    const transactions = new Map(
      (await tx.query<{ external_id: string; id: string }>('select external_id, id from machvon.treasury_transaction where provider = $1 and external_id = any($2::text[])', [TREASURY_FILE_PROVIDER, keys])).map((row) => [
        row.external_id,
        row.id,
      ]),
    );
    const drafts: RowDraft[] = plan.rows.map((planned): RowDraft => {
      const refused = quarantined.get(planned.line);
      if (refused !== undefined) {
        return { row_no: planned.line, business_key: refused.business_key ?? `line:${planned.line}`, row_hash: refused.row_hash, outcome: 'ERROR', error_code: refused.error_code, treasury_transaction_id: null, raw_masked: refused.masked_preview ?? {} };
      }
      if (!planned.accepted) throw new Error('a refused statement row is missing from the quarantine');
      const key = planned.row.businessKey;
      const first = claimed.get(key);
      if (first === undefined) throw new Error('an accepted statement row was never claimed');
      const outcome: TreasuryRowOutcome = first.first_import_id === importId && first.first_line === planned.line ? 'NEW' : first.row_hash === planned.rowHash ? 'DUPLICATE' : 'CONFLICT';
      return {
        row_no: planned.line,
        business_key: key,
        row_hash: planned.rowHash,
        outcome,
        error_code: null,
        treasury_transaction_id: transactions.get(key) ?? null,
        raw_masked: maskedPreview(format, planned.row.fields) ?? {},
      };
    });
    await tx.query(
      `insert into machvon.treasury_import_row (tenant_id, id, import_id, row_no, business_key, row_hash, outcome, error_code, treasury_transaction_id, raw_masked, created_by)
       select ${TENANT}, gen_random_uuid(), $1::uuid, d.row_no, d.business_key, d.row_hash, d.outcome, d.error_code, d.treasury_transaction_id, d.raw_masked, $2::uuid
         from jsonb_to_recordset($3::jsonb) as d(row_no int, business_key text, row_hash text, outcome text, error_code text, treasury_transaction_id uuid, raw_masked jsonb)`,
      [importId, actor, JSON.stringify(drafts)],
    );
  }

  /**
   * A row that came back with other content leaves the original as it is and opens DUPLICATE_CONFLICT in the core. The PAY register of
   * differences has the same item, with the transaction it is about and the two amounts, owned by the same person and due at the same time.
   */
  private async mirrorConflicts(tx: TenantTx, importId: string, actor: string): Promise<void> {
    await tx.query(
      `insert into machvon.reconciliation_item
         (tenant_id, id, project_id, treasury_transaction_id, import_row_id, kind, internal_amount_vnd, confirmed_amount_vnd, owner_membership_id, due_at, status, created_by, updated_by)
       select ${TENANT}, gen_random_uuid(), t.project_id, t.id, r.id, 'DUPLICATE_CONFLICT', item.expected_value::numeric, item.actual_value::numeric, item.owner_membership_id, item.due_at, 'OPEN', $2::uuid, $2::uuid
         from machvon.file_import_reconciliation_item item
         join machvon.treasury_transaction t on t.provider = $3 and t.external_id = item.business_key
         join machvon.treasury_import_row r on r.import_id = item.import_id and r.business_key = item.business_key and r.outcome = 'CONFLICT'
        where item.import_id = $1::uuid and item.code = 'DUPLICATE_CONFLICT'
       on conflict (tenant_id, treasury_transaction_id, kind) where treasury_transaction_id is not null and status in ('OPEN', 'EXPLAINED') do nothing
       returning id`,
      [importId, actor, TREASURY_FILE_PROVIDER],
    );
  }

  /**
   * A row refused because the tenant lacks a mapping or a project is work for a person (map the code, register the project), so it becomes an
   * item with an owner and a due time, the importer by default. A row that is simply malformed has nobody to fix it but whoever supplies the next file.
   */
  private async openGapItems(tx: TenantTx, importId: string, owner: string, correlationId: string, now: Date): Promise<number> {
    const refused = await tx.query<{ line: number; business_key: string | null; error_code: string; field: string; row_hash: string; masked_preview: Record<string, string> | null }>(
      'select line, business_key, error_code, field, row_hash, masked_preview from machvon.file_import_quarantine where import_id = $1::uuid and business_key is not null order by line',
      [importId],
    );
    let opened = 0;
    for (const row of refused) {
      if (!MASTER_DATA_GAPS.has(row.error_code) || row.business_key === null) continue;
      const shown = row.masked_preview?.[row.field];
      const item = await openItem(tx, {
        importId,
        line: row.line,
        connectorCode: TREASURY_CONNECTOR_CODE,
        businessKey: row.business_key,
        difference: { code: row.error_code, detail: shown === undefined ? row.field : `${row.field} ${shown}` },
        rowHash: row.row_hash,
        ownerId: owner,
        now,
        dueAfterSeconds: DEFAULT_ITEM_DUE_SECONDS,
      });
      if (!item.created) continue;
      opened += 1;
      await enqueueOutbox(tx, {
        aggregateType: 'file_import_reconciliation_item',
        aggregateId: item.id,
        aggregateVersion: 1,
        type: FILE_IMPORT_DIFFERENCE_EVENT,
        schemaVersion: 1,
        payload: { import_id: importId, connector_code: TREASURY_CONNECTOR_CODE, code: row.error_code, owner_membership_id: owner, due_at: item.dueAt },
        eventKey: `file-import-item:${item.id}`,
        correlationId,
      });
    }
    return opened;
  }
}
