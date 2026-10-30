import { createHash } from 'node:crypto';
import { csvLine, guarded } from './dis-export.ts';
import { DomainError } from './errors.ts';

/**
 * The records of the contractors for the national database (ST-CTR-015, CTR 3.6, UAT-AC315, UAT-PLAN-18, CXN-EXE-01): the approved evaluations and the confirmed violations of a period, written as one file whose SHA-256 is the
 * key of the batch, so the same request gives the same file and the same batch. There is no interface to the national system (the adapter is PROPOSED and its API is MISSING): the file is submitted by hand and the receipt number
 * is written down. Pure functions of their input.
 */

export const CONTRACTOR_EXPORT_SCOPES = ['PERFORMANCE', 'VIOLATION', 'BOTH'] as const;
export type ContractorExportScope = (typeof CONTRACTOR_EXPORT_SCOPES)[number];
export const CONTRACTOR_EXPORT_FORMATS = ['CSV', 'JSON'] as const;
export type ContractorExportFormat = (typeof CONTRACTOR_EXPORT_FORMATS)[number];

/** What the adapter to the national system is today: a file is proposed and there is no API to call (CXN-EXE-01). */
export const EXPORT_ADAPTER = { state: 'PROPOSED', api: 'MISSING', cxn: 'CXN-EXE-01' } as const;

/**
 * The columns of the file, in order: the column format of the national database is pending (CXN-EXE-01), so the map of columns is one place to change, and the key of a column is what the JSON carries. A cell that does not apply to
 * a kind of record (a score of a violation) is empty.
 */
export const CONTRACTOR_EXPORT_COLUMNS = [
  'record_type',
  'contractor_tax_identifier',
  'contractor_name',
  'contract_code',
  'evaluation_kind',
  'period_label',
  'revision',
  'score_quality',
  'score_schedule',
  'score_safety_env',
  'score_cooperation',
  'score_financial',
  'overall_score',
  'rating',
  'approved_on',
  'violation_kind',
  'severity',
  'occurred_on',
  'penalty_kind',
  'penalty_amount_vnd',
  'decision_document_version_id',
  'confirmed_on',
] as const;
export type ContractorExportColumn = (typeof CONTRACTOR_EXPORT_COLUMNS)[number];

/** Money and scores are written as text; a record is a row of the columns above, with the key that orders it. */
export type ContractorExportRecord = Readonly<Partial<Record<ContractorExportColumn, string>>> & { readonly record_type: 'EVALUATION' | 'VIOLATION'; readonly sort: string; readonly contractId: string };

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
/** A period of the file is at most five years: more is not a period of reporting. */
export const MAX_PERIOD_DAYS = 5 * 366;
const DAY_MS = 86_400_000;
const REFERENCE_MAX = 100;

const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);

function calendarDate(raw: unknown, field: string): string {
  const matched = typeof raw === 'string' ? DATE.exec(raw) : null;
  const [year, month, day] = matched === null ? [] : matched.slice(1, 4).map(Number);
  const date = matched === null ? undefined : new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 1));
  if (matched === null || date === undefined || date.getUTCFullYear() !== year || date.getUTCMonth() !== (month ?? 0) - 1 || date.getUTCDate() !== day) throw invalid(field);
  return matched[0];
}

const daysBetween = (from: string, to: string): number => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);

export interface ExportRequest {
  scope: ContractorExportScope;
  periodFrom: string;
  periodTo: string;
  format: ContractorExportFormat;
}

/** What an export asks for: what to put in it, the days it covers (the start not after the end, at most five years) and the format. */
export function assertExportRequest(raw: { scope?: unknown; period_from?: unknown; period_to?: unknown; format?: unknown }): ExportRequest {
  const scope = CONTRACTOR_EXPORT_SCOPES.find((candidate) => candidate === raw.scope);
  if (scope === undefined) throw invalid('scope');
  const format = CONTRACTOR_EXPORT_FORMATS.find((candidate) => candidate === raw.format);
  if (format === undefined) throw invalid('format');
  const periodFrom = calendarDate(raw.period_from, 'period_from');
  const periodTo = calendarDate(raw.period_to, 'period_to');
  if (periodFrom > periodTo || daysBetween(periodFrom, periodTo) > MAX_PERIOD_DAYS) throw invalid('period_to');
  return { scope, periodFrom, periodTo, format };
}

export interface Submission {
  ref: string;
  on: string;
}

/** The receipt of a submission made by hand: the number the national system gave, and the day it was made (not after today, a Vietnam calendar day). */
export function assertSubmission(raw: { submitted_ref?: unknown; submitted_on?: unknown }, today: string): Submission {
  const ref = typeof raw.submitted_ref === 'string' ? raw.submitted_ref.normalize('NFC').trim() : '';
  if (ref === '' || ref.length > REFERENCE_MAX) throw invalid('submitted_ref');
  const on = calendarDate(raw.submitted_on, 'submitted_on');
  if (on > today) throw invalid('submitted_on');
  return { ref, on };
}

export interface ExportFile {
  bytes: Uint8Array;
  sha256: string;
  rows: number;
  contentType: string;
  /** The contracts whose records are in the file, each once, in order: who may read the file is judged against them. */
  contractIds: string[];
}

const isNumericColumn = (column: ContractorExportColumn): boolean => /^(score_|overall_score|revision|penalty_amount_vnd)/.test(column);

/**
 * The file of the records, the same bytes for the same records: the rows are in the order of their sort key and nothing in the file says when it was made. A CSV is UTF-8 with a byte-order mark and CRLF lines, and a text
 * cell that begins like a formula is quoted so that a spreadsheet never reads it as one; the JSON is a list of objects that carry only the columns that apply to the kind of record.
 */
export function buildContractorExport(records: readonly ContractorExportRecord[], format: ContractorExportFormat): ExportFile {
  const ordered = [...records].sort((a, b) => (a.sort < b.sort ? -1 : a.sort > b.sort ? 1 : 0));
  let text: string;
  if (format === 'CSV') {
    const lines = [csvLine([...CONTRACTOR_EXPORT_COLUMNS]), ...ordered.map((record) => csvLine(CONTRACTOR_EXPORT_COLUMNS.map((column) => guarded(record[column] ?? '', isNumericColumn(column)))))];
    text = `\uFEFF${lines.join('\r\n')}\r\n`;
  } else {
    text = `${JSON.stringify(ordered.map((record) => Object.fromEntries(CONTRACTOR_EXPORT_COLUMNS.flatMap((column) => (record[column] === undefined ? [] : [[column, record[column]]])))))}\n`;
  }
  const bytes = new Uint8Array(Buffer.from(text, 'utf8'));
  return { bytes, sha256: createHash('sha256').update(bytes).digest('hex'), rows: ordered.length, contentType: format === 'CSV' ? 'text/csv' : 'application/json', contractIds: [...new Set(ordered.map((record) => record.contractId))].sort() };
}
