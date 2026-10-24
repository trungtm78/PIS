import { fileSha256, maskedPreview, planFileImport } from '@machvon/kernel';
import type { PlannedAccepted } from '@machvon/kernel';
import type { FileImportAdapter, ImportEntry } from './file-import-store.ts';
import type { TenantTx } from './tenant-database.ts';

/**
 * The dry run of a file import (NFR-OPERABILITY-06, `docs/file-import.md`): the file is read and every row judged exactly as `FileImportStore.run`
 * will judge it, against what the tenant holds, and nothing is written (no claim of the file, no claim of a row, no quarantine, no outbox event).
 * The answer tells, row by row, whether the import would take it, repeat it, set it against an earlier row, or refuse it and why. A module that wants
 * to tell the person what an import would do before it does it calls this with the adapter it will run with.
 */

export type PreviewStatus = 'VALID' | 'ERROR' | 'DUPLICATE' | 'CONFLICT';

export interface PreviewRow {
  line: number;
  businessKey: string | null;
  status: PreviewStatus;
  /** The reason of a refusal and the field it is about. */
  code?: string;
  field?: string;
  /** What the module would do with a valid row (`outcomeOf` of the adapter), for example ASSIGN or UNCHANGED. */
  outcome?: string;
  /** What a person may see of the row (the mask of the format: nothing personal; without a mask, nothing). */
  preview?: Record<string, string> | null;
}

export interface PreviewCounts {
  total: number;
  valid: number;
  duplicate: number;
  conflict: number;
  errors: number;
}

export interface FileImportPreview {
  fileSha256: string;
  connectorCode: string;
  formatVersion: string;
  /** The same bytes were applied before for this connector: an apply would change nothing (every row would be a repeat). */
  alreadyApplied: boolean;
  counts: PreviewCounts;
  rows: PreviewRow[];
}

/** An adapter that can also say what it would do with a row it accepts. */
export interface PreviewableAdapter<R> extends FileImportAdapter<R> {
  outcomeOf?(tx: TenantTx, entry: ImportEntry<R>): Promise<string>;
}

const byKey = (a: PlannedAccepted<unknown>, b: PlannedAccepted<unknown>): number => (a.row.businessKey < b.row.businessKey ? -1 : a.row.businessKey > b.row.businessKey ? 1 : a.line - b.line);

export async function previewFileImport<R>(tx: TenantTx, adapter: PreviewableAdapter<R>, bytes: Uint8Array, options: { maxRows?: number } = {}): Promise<FileImportPreview> {
  // A file that cannot be read is told as the framework tells it (IMPORT_SCHEMA_INVALID, IMPORT_EMPTY): the caller turns the error into 422.
  const plan = planFileImport(adapter, bytes, options.maxRows);
  const sha = fileSha256(bytes);
  const earlier = await tx.query<{ id: string }>("select id from machvon.file_import where connector_code = $1 and file_sha256 = $2 and status <> 'FAILED'", [adapter.connectorCode, sha]);
  const rows: PreviewRow[] = [];
  for (const planned of plan.rows) {
    if (!planned.accepted) rows.push({ line: planned.line, businessKey: planned.businessKey, status: 'ERROR', code: planned.rejection.code, field: planned.rejection.field, preview: planned.preview });
  }
  // The rows are taken in the order of their keys, as the import takes them, so that of two rows with one key the same one wins here and there.
  const seen = new Map<string, string>();
  for (const planned of plan.rows.filter((row): row is PlannedAccepted<R> => row.accepted).sort(byKey)) {
    const key = planned.row.businessKey;
    const entry: ImportEntry<R> = { line: planned.line, businessKey: key, record: planned.row.record, fields: planned.row.fields, measure: planned.row.measure, rowHash: planned.rowHash };
    const claimed = seen.get(key) ?? (await tx.query<{ row_hash: string }>('select row_hash from machvon.file_import_row where connector_code = $1 and business_key = $2', [adapter.connectorCode, key]))[0]?.row_hash;
    if (claimed !== undefined) {
      rows.push({ line: planned.line, businessKey: key, status: claimed === planned.rowHash ? 'DUPLICATE' : 'CONFLICT', preview: maskedPreview(adapter, planned.values) });
      continue;
    }
    const refusal = adapter.examine === undefined ? undefined : await adapter.examine(tx, entry);
    if (refusal !== undefined) {
      rows.push({ line: planned.line, businessKey: key, status: 'ERROR', code: refusal.code, field: refusal.field, preview: maskedPreview(adapter, planned.values) });
      continue;
    }
    seen.set(key, planned.rowHash);
    rows.push({ line: planned.line, businessKey: key, status: 'VALID', preview: maskedPreview(adapter, planned.values), ...(adapter.outcomeOf === undefined ? {} : { outcome: await adapter.outcomeOf(tx, entry) }) });
  }
  rows.sort((a, b) => a.line - b.line);
  const count = (status: PreviewStatus): number => rows.filter((row) => row.status === status).length;
  return {
    fileSha256: sha,
    connectorCode: adapter.connectorCode,
    formatVersion: adapter.formatVersion,
    alreadyApplied: earlier[0] !== undefined,
    counts: { total: rows.length, valid: count('VALID'), duplicate: count('DUPLICATE'), conflict: count('CONFLICT'), errors: count('ERROR') },
    rows,
  };
}
