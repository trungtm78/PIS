import { ApiError } from '@machvon/api-client';
import { amountText } from './model';

/** The permissions that gate the buttons of the BOQ screen; the server decides again on every request (scope included). */
export const BOQ_MANAGE_PERMISSION = 'boq.manage';
export const BOQ_READ_PERMISSION = 'boq_line.read';

export const BOQ_PATH = '/ctr/ctr-04';

export const ROUNDING_RULES = ['HALF_UP', 'DOWN', 'UP'] as const;
export type RoundingRule = (typeof ROUNDING_RULES)[number];
export const IMPORT_MODES = ['REPLACE', 'APPEND'] as const;
export type ImportMode = (typeof IMPORT_MODES)[number];

/** The members of a line that a BOQ file may carry, as the server takes them; the first five are required. */
export const BOQ_COLUMNS = ['business_key', 'description', 'unit_code', 'quantity', 'unit_price', 'rounding_rule', 'retention_pct', 'milestone_code', 'milestone_due_on', 'party_contractor_id'] as const;
export type BoqColumn = (typeof BOQ_COLUMNS)[number];
const REQUIRED_COLUMNS: readonly string[] = BOQ_COLUMNS.slice(0, 5);

/** The most lines one import carries (the server refuses more) and the largest file the screen reads. */
export const MAX_IMPORT_LINES = 2000;
export const MAX_FILE_BYTES = 5 * 1024 * 1024;

/** The default retention of a line that names none, as the labelled rule `CTR.RETENTION` gives it until the owner of the business confirms it (CXN-EXE-04). */
export const DEFAULT_RETENTION_PCT = '5';

type Raw = Record<string, unknown>;

const asRecord = (value: unknown): Raw | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Raw) : undefined);
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const nullableText = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const whole = (value: unknown): number | undefined => (typeof value === 'number' && Number.isInteger(value) ? value : undefined);

// ---- what the server answers ----------------------------------------------------------------------------------------

/** One line of a BOQ (CTR-04). Amounts and quantities are exact decimal strings; the screen never turns them into numbers. */
export interface BoqLine {
  id: string;
  contractId: string;
  revisionId: string;
  revision: number;
  revisionStatus: string;
  lineNo: number;
  businessKey: string;
  description: string;
  unitCode: string;
  quantity: string;
  unitPrice: string;
  roundingRule: RoundingRule;
  amountVnd: string;
  retentionPct: string;
  milestoneCode: string | null;
  milestoneDueOn: string | null;
  partyName: string | null;
}

const isRule = (value: string | undefined): value is RoundingRule => value !== undefined && (ROUNDING_RULES as readonly string[]).includes(value);

export function toBoqLine(raw: unknown): BoqLine | undefined {
  const row = asRecord(raw);
  if (row === undefined) return undefined;
  const id = text(row.id);
  const revisionId = text(row.contract_revision_id);
  const businessKey = text(row.business_key);
  const amount = text(row.amount_vnd);
  const rule = text(row.rounding_rule);
  const lineNo = whole(row.line_no);
  if (id === undefined || revisionId === undefined || businessKey === undefined || amount === undefined || lineNo === undefined || !isRule(rule)) return undefined;
  return {
    id,
    contractId: text(row.contract_id) ?? '',
    revisionId,
    revision: whole(row.revision) ?? 0,
    revisionStatus: text(row.revision_status) ?? '',
    lineNo,
    businessKey,
    description: text(row.description) ?? '',
    unitCode: text(row.unit_code) ?? '',
    quantity: text(row.quantity) ?? '0',
    unitPrice: text(row.unit_price) ?? '0',
    roundingRule: rule,
    amountVnd: amount,
    retentionPct: text(row.retention_pct) ?? '0',
    milestoneCode: nullableText(row.milestone_code),
    milestoneDueOn: nullableText(row.milestone_due_on),
    partyName: nullableText(row.party_name),
  };
}

/** The lines of a revision in the order of their numbers. */
export const linesOf = (lines: readonly BoqLine[], revisionId: string): BoqLine[] => lines.filter((line) => line.revisionId === revisionId).sort((left, right) => left.lineNo - right.lineNo);

/** A number with a decimal part written the way the language of the screen writes it: the digits are grouped and the string is never turned into a float. */
export function decimalText(value: string, locale: string): string {
  const [integer = '', fraction] = value.split('.');
  const grouped = amountText(integer, locale);
  if (fraction === undefined || !/^\d+$/.test(fraction)) return grouped;
  const separator = new Intl.NumberFormat(locale).formatToParts(1.1).find((part) => part.type === 'decimal')?.value ?? '.';
  return `${grouped}${separator}${fraction}`;
}

/** The comparison of the lines of a revision with its amount (BR-CTR-02), in exact integer arithmetic over whole VND. */
export interface Reconciliation {
  revisionAmount: string;
  linesTotal: string;
  /** Lines minus revision: negative while the BOQ is short of the value. */
  difference: string;
  lineCount: number;
  matches: boolean;
}

const WHOLE = /^-?\d+$/;

export function reconcile(revisionAmount: string, linesTotal: string, lineCount: number): Reconciliation | undefined {
  if (!WHOLE.test(revisionAmount) || !WHOLE.test(linesTotal)) return undefined;
  const difference = BigInt(linesTotal) - BigInt(revisionAmount);
  return { revisionAmount, linesTotal, difference: difference.toString(), lineCount, matches: difference === 0n && lineCount > 0 };
}

/** The sum of the amounts of lines, exact. */
export function totalOf(lines: readonly Pick<BoqLine, 'amountVnd'>[]): string {
  return lines.reduce((sum, line) => sum + (WHOLE.test(line.amountVnd) ? BigInt(line.amountVnd) : 0n), 0n).toString();
}

export const boqLink = (contractId: string, revisionId?: string): string => `${BOQ_PATH}?${new URLSearchParams({ id: contractId, ...(revisionId === undefined ? {} : { revision: revisionId }) }).toString()}`;

// ---- reading a CSV file ------------------------------------------------------------------------------------------------------

export type FileProblem = 'empty' | 'unreadable' | 'tooLarge' | 'tooMany' | 'notCsv' | 'unknownColumn' | 'missingColumn';

export type ParsedFile = { ok: true; lines: Array<Record<string, string>> } | { ok: false; problem: FileProblem; column?: string };

const DELIMITERS = [',', ';', '\t'] as const;

function delimiterOf(firstLine: string): string {
  let best: string = ',';
  let most = 0;
  for (const candidate of DELIMITERS) {
    let count = 0;
    let quoted = false;
    for (const character of firstLine) {
      if (character === '"') quoted = !quoted;
      else if (character === candidate && !quoted) count += 1;
    }
    if (count > most) {
      best = candidate;
      most = count;
    }
  }
  return best;
}

/** RFC 4180 rows: quoted cells may hold the delimiter, line breaks and doubled quotes; blank lines are skipped. Undefined when a quote is never closed. */
function csvRows(source: string): string[][] | undefined {
  const delimiter = delimiterOf(source.split(/\r\n|\n|\r/, 1)[0] ?? '');
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  let touched = false;
  const endCell = (): void => {
    row.push(cell);
    cell = '';
  };
  const endRow = (): void => {
    endCell();
    if (touched || row.some((value) => value !== '')) rows.push(row);
    row = [];
    touched = false;
  };
  for (let index = 0; index < source.length; index += 1) {
    const character = source.charAt(index);
    if (quoted) {
      if (character !== '"') cell += character;
      else if (source.charAt(index + 1) === '"') {
        cell += '"';
        index += 1;
      } else quoted = false;
    } else if (character === '"' && cell === '') {
      quoted = true;
      touched = true;
    } else if (character === delimiter) {
      endCell();
      touched = true;
    } else if (character === '\r' || character === '\n') {
      if (character === '\r' && source.charAt(index + 1) === '\n') index += 1;
      endRow();
    } else cell += character;
  }
  if (quoted) return undefined;
  if (cell !== '' || row.length > 0) endRow();
  return rows;
}

/**
 * Reads the text of a BOQ file into the lines the import takes: the first row names the columns (they must be members of a line, with the
 * five required ones), every cell stays text, an empty cell is left out so the server's defaults apply. It judges only what it can see; the
 * server judges every row again.
 */
export function parseBoqCsv(source: string): ParsedFile {
  const rows = csvRows(source.charCodeAt(0) === 0xfeff ? source.slice(1) : source);
  if (rows === undefined) return { ok: false, problem: 'unreadable' };
  const [head, ...body] = rows;
  if (head === undefined || body.length === 0) return { ok: false, problem: 'empty' };
  const columns = head.map((name) => name.trim());
  const unknown = columns.find((name) => name !== '' && !(BOQ_COLUMNS as readonly string[]).includes(name));
  if (unknown !== undefined) return { ok: false, problem: 'unknownColumn', column: unknown };
  const missing = REQUIRED_COLUMNS.find((name) => !columns.includes(name));
  if (missing !== undefined) return { ok: false, problem: 'missingColumn', column: missing };
  if (body.length > MAX_IMPORT_LINES) return { ok: false, problem: 'tooMany' };
  const lines = body.map((cells) => {
    const line: Record<string, string> = {};
    columns.forEach((name, index) => {
      const cell = cells[index] ?? '';
      if (name !== '' && cell.trim() !== '') line[name] = cell;
    });
    return line;
  });
  return { ok: true, lines };
}

/** SHA-256 of bytes as lower-case hex: the hash of the file, which makes the same file the same import. */
export async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** A file as the bytes the browser holds, through FileReader (which every browser has, in a secure context or not). */
export function readBytes(file: Blob): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(new Error('the file could not be read'));
    reader.readAsArrayBuffer(file);
  });
}

export interface ImportBody {
  mode: ImportMode;
  file_sha256?: string;
  lines: Array<Record<string, string>>;
}

export interface PreparedFile {
  body: ImportBody | undefined;
  problem: FileProblem | undefined;
  column: string | undefined;
  lineCount: number;
}

/** What the screen can tell of a chosen file before anything is sent: the body of the command, or the way the file is unusable. */
export async function prepareFile(file: File, mode: ImportMode): Promise<PreparedFile> {
  const refused = (problem: FileProblem, column?: string): PreparedFile => ({ body: undefined, problem, column, lineCount: 0 });
  if (!/\.(csv|txt)$/i.test(file.name)) return refused('notCsv');
  if (file.size > MAX_FILE_BYTES) return refused('tooLarge');
  let bytes: ArrayBuffer;
  try {
    bytes = await readBytes(file);
  } catch {
    return refused('unreadable');
  }
  let source: string;
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return refused('unreadable');
  }
  const parsed = parseBoqCsv(source);
  if (!parsed.ok) return refused(parsed.problem, parsed.column);
  return { body: { mode, file_sha256: await sha256Hex(bytes), lines: parsed.lines }, problem: undefined, column: undefined, lineCount: parsed.lines.length };
}

// ---- what the import answers -----------------------------------------------------------------------------------------------

export interface ImportResult {
  importId: string;
  duplicate: boolean;
  linesImported: number;
  itemsCreated: number;
  retentionDefaulted: number;
  linesTotal: string;
  revisionAmount: string;
  difference: string;
  balanced: boolean;
}

export function toImportResult(raw: unknown): ImportResult | undefined {
  const row = asRecord(raw);
  const importId = text(row?.import_id);
  const linesTotal = text(row?.lines_total_vnd);
  const revisionAmount = text(row?.revision_amount_vnd);
  const difference = text(row?.difference_vnd);
  if (row === undefined || importId === undefined || linesTotal === undefined || revisionAmount === undefined || difference === undefined) return undefined;
  return {
    importId,
    duplicate: row.duplicate === true,
    linesImported: whole(row.lines_imported) ?? 0,
    itemsCreated: whole(row.items_created) ?? 0,
    retentionDefaulted: whole(row.retention_defaulted) ?? 0,
    linesTotal,
    revisionAmount,
    difference,
    balanced: row.balanced === true,
  };
}

/** A row of the file that cannot be imported: its place among the data rows (0 is the header), the field and the reason the screen has a word for. */
export interface RowFault {
  row: number;
  field: string;
  reason: string;
}

export type ImportReason =
  | 'rows'
  | 'totalMismatch'
  | 'duplicate'
  | 'notDraft'
  | 'stateInvalid'
  | 'versionConflict'
  | 'fileNotClean'
  | 'fileType'
  | 'tooLarge'
  | 'validation'
  | 'notFound'
  | 'denied'
  | 'general';

export interface ImportProblem {
  reason: ImportReason;
  field: string | undefined;
  faults: RowFault[];
  faultRows: number;
  /** For a total that does not match: the lines, the revision and the difference, exact decimal strings in VND. */
  figures: { linesTotal: string; revisionAmount: string; difference: string } | undefined;
  /** For a key the revision already has: the rows of the file that name one. */
  duplicateRows: number[];
}

const REASON_BY_CODE: Readonly<Record<string, ImportReason>> = {
  BOQ_TOTAL_MISMATCH: 'totalMismatch',
  BOQ_LINE_DUPLICATE: 'duplicate',
  REVISION_NOT_DRAFT: 'notDraft',
  CONTRACT_STATE_INVALID: 'stateInvalid',
  VERSION_CONFLICT: 'versionConflict',
  FILE_NOT_CLEAN: 'fileNotClean',
  FILE_TYPE_NOT_ALLOWED: 'fileType',
  PAYLOAD_TOO_LARGE: 'tooLarge',
  VALIDATION_FAILED: 'validation',
  INVALID_REQUEST: 'validation',
  FIELD_NOT_ALLOWED: 'validation',
  RESOURCE_NOT_FOUND: 'notFound',
  SCOPE_DENIED: 'denied',
};

function faultsOf(value: unknown): RowFault[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const row = asRecord(entry);
    const place = whole(row?.row);
    const field = text(row?.field);
    const reason = text(row?.reason);
    return row === undefined || place === undefined || field === undefined || reason === undefined ? [] : [{ row: place, field, reason }];
  });
}

/** Maps the failure of the import to what the screen shows: the faults of the rows when the server listed them, otherwise one sentence. */
export function describeImportProblem(error: unknown): ImportProblem {
  const none: ImportProblem = { reason: 'general', field: undefined, faults: [], faultRows: 0, figures: undefined, duplicateRows: [] };
  if (!(error instanceof ApiError)) return none;
  const faults = faultsOf(error.extensions.errors);
  const reason = REASON_BY_CODE[error.code] ?? 'general';
  const linesTotal = text(error.extensions.lines_total_vnd);
  const revisionAmount = text(error.extensions.revision_amount_vnd);
  const difference = text(error.extensions.difference_vnd);
  return {
    reason: reason === 'validation' && faults.length > 0 ? 'rows' : reason,
    field: error.detail,
    faults,
    faultRows: whole(error.extensions.error_rows) ?? faults.length,
    figures: linesTotal === undefined || revisionAmount === undefined || difference === undefined ? undefined : { linesTotal, revisionAmount, difference },
    duplicateRows: Array.isArray(error.extensions.rows) ? error.extensions.rows.filter((item): item is number => typeof item === 'number') : [],
  };
}
