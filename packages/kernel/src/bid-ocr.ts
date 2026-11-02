import { addDecimal, compareDecimal } from './decimal.ts';
import { DomainError } from './errors.ts';

/**
 * The OCR of the pages of a proposal and its review (ST-BID-008, BID 3 F3, BR-BID-06): every page is read with a confidence; a page below the threshold, or one with a table whose stated
 * total is not the sum of its lines, waits for an expert to confirm or correct it, and the financial analysis does not run while any page waits. No figure here is a float: the
 * confidence is a decimal string and the threshold is an integer count of thousandths, the amounts of a table are decimal strings summed exactly.
 */
export const OCR_STATUSES = ['AUTO_ACCEPTED', 'NEEDS_REVIEW', 'CONFIRMED', 'CORRECTED'] as const;
export type OcrStatus = (typeof OCR_STATUSES)[number];

export const OCR_DECISIONS = ['CONFIRMED', 'CORRECTED'] as const;
export type OcrDecision = (typeof OCR_DECISIONS)[number];

/** A page reads with at least this confidence, in thousandths, to be accepted without a person (0.85, an assumption of the module design until the engine is evaluated). */
export const OCR_CONFIDENCE_THRESHOLD = 850;
export const MAX_OCR_NOTE = 1000;
/** The longest text of a page, in bytes, that an engine or a reviewer may put in the store: a page of a bid is a page, not a book. */
export const MAX_OCR_TEXT_BYTES = 1024 * 1024;
export const MAX_OCR_TABLES = 50;
export const MAX_OCR_TABLE_ROWS = 2000;

/** The confidence as the column keeps it: from 0 to 1 with up to four digits after the point. */
const CONFIDENCE = /^(0(\.\d{1,4})?|1(\.0{1,4})?)$/;
/** A money amount as the ledger keeps it: up to 18 whole digits and 8 after the point, signed (a discount is a negative line). */
const AMOUNT = /^-?(0|[1-9]\d{0,17})(\.\d{1,8})?$/;

export interface OcrTableRow {
  label: string;
  amount: string;
}

/** A table the engine read: its lines and the total it states. */
export interface OcrTable {
  rows: OcrTableRow[];
  total: string;
}

const thousandths = (value: number): string => `${Math.floor(value / 1000)}.${String(value % 1000).padStart(3, '0')}`;

/** The threshold as a decimal string, for a reader that shows it. */
export const OCR_CONFIDENCE_THRESHOLD_TEXT = thousandths(OCR_CONFIDENCE_THRESHOLD);

/** Whether `confidence` (a decimal string from 0 to 1) is a value the column keeps. */
export const isConfidence = (confidence: unknown): confidence is string => typeof confidence === 'string' && CONFIDENCE.test(confidence);

/** Whether the confidence of a page is under the threshold, compared exactly. */
export function belowThreshold(confidence: string): boolean {
  if (!isConfidence(confidence)) throw new DomainError('VALIDATION_FAILED', 422, 'ocr_confidence');
  return compareDecimal(confidence, OCR_CONFIDENCE_THRESHOLD_TEXT) < 0;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The tables of a page as the engine wrote them, or undefined when what is kept is not that shape (a table nobody can check is a table nobody may rely on). */
export function parseTables(value: unknown): OcrTable[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_OCR_TABLES) return undefined;
  const tables: OcrTable[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || !Array.isArray(entry.rows) || entry.rows.length > MAX_OCR_TABLE_ROWS || typeof entry.total !== 'string' || !AMOUNT.test(entry.total)) return undefined;
    const rows: OcrTableRow[] = [];
    for (const row of entry.rows) {
      if (!isRecord(row) || typeof row.label !== 'string' || typeof row.amount !== 'string' || !AMOUNT.test(row.amount)) return undefined;
      rows.push({ label: row.label, amount: row.amount });
    }
    tables.push({ rows, total: entry.total });
  }
  return tables;
}

/** Whether the total a table states is not the exact sum of its lines. */
export function tableMismatch(table: OcrTable): boolean {
  const sum = table.rows.reduce((total, row) => addDecimal(total, row.amount), '0');
  return compareDecimal(sum, table.total) !== 0;
}

/** Whether any table of the page does not add up; tables that cannot be read count as not adding up (fail closed). */
export function pageTablesMismatch(tables: unknown): boolean {
  const parsed = parseTables(tables);
  return parsed === undefined || parsed.some(tableMismatch);
}

/** What the engine says about one page. */
export interface OcrReading {
  confidence: string;
  tables: unknown;
}

/** The status a freshly read page starts in: accepted when it is read with confidence and its tables add up, else it waits for a person. */
export function classifyPage(reading: OcrReading): Extract<OcrStatus, 'AUTO_ACCEPTED' | 'NEEDS_REVIEW'> {
  return belowThreshold(reading.confidence) || pageTablesMismatch(reading.tables) ? 'NEEDS_REVIEW' : 'AUTO_ACCEPTED';
}

export interface GatePage {
  id: string;
  pageIndex: number;
  status: OcrStatus;
}

export interface FinancialGate {
  ready: boolean;
  /** The pages that hold the financial analysis back, in page order. */
  blocked: Array<{ id: string; pageIndex: number }>;
}

/** The financial analysis of a proposal is ready to run only when no page of it waits for a person; it names the pages that wait, in the order the pages were given. */
export function financialGate(pages: readonly GatePage[]): FinancialGate {
  const blocked = pages.filter((page) => page.status === 'NEEDS_REVIEW').map((page) => ({ id: page.id, pageIndex: page.pageIndex }));
  return { ready: blocked.length === 0, blocked };
}

export interface OcrReviewInput {
  decision: unknown;
  correctedTextObjectKey?: unknown;
  note?: unknown;
}

/**
 * What a review of a page makes of it. Only a page that waits for a person is reviewed (409 OCR_STATE_INVALID); a correction names the corrected text and a confirmation does
 * not (422), and the note, when there is one, is short.
 */
export function checkReview(current: OcrStatus, input: OcrReviewInput): OcrDecision {
  if (current !== 'NEEDS_REVIEW') throw new DomainError('OCR_STATE_INVALID', 409, undefined, { extensions: { review_status: current } });
  const decision = OCR_DECISIONS.find((candidate) => candidate === input.decision);
  if (decision === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'decision');
  const hasKey = input.correctedTextObjectKey !== undefined && input.correctedTextObjectKey !== null;
  if (decision === 'CORRECTED' && (typeof input.correctedTextObjectKey !== 'string' || input.correctedTextObjectKey === ''))
    throw new DomainError('VALIDATION_FAILED', 422, 'corrected_text_object_key');
  if (decision === 'CONFIRMED' && hasKey) throw new DomainError('VALIDATION_FAILED', 422, 'corrected_text_object_key');
  if (input.note !== undefined && input.note !== null && (typeof input.note !== 'string' || input.note.length > MAX_OCR_NOTE)) throw new DomainError('VALIDATION_FAILED', 422, 'note');
  return decision;
}
