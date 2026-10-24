import { DomainError, addDecimal, canonicalJson, compareDecimal, multiplyDecimal, roundDecimal, sha256Hex } from '@machvon/kernel';
import { calendarDate } from './ctr-contract-store.ts';

/** The ways a line of a BOQ may be rounded to whole VND (BR-CTR-02): half up by default, down or up when the contract says so. */
export const BOQ_ROUNDING_RULES = ['HALF_UP', 'DOWN', 'UP'] as const;
export type BoqRoundingRule = (typeof BOQ_ROUNDING_RULES)[number];

/** The most lines one import carries: the body of a command is limited, and a larger BOQ is imported in several APPEND passes. */
export const MAX_BOQ_LINES = 2000;
/** The row errors an answer names; the count of the rows with an error is always whole. */
export const MAX_ROW_ERRORS = 100;

/**
 * The retention of a line that does not name one (BR-CTR-09): the rule `CTR.RETENTION` is a working assumption until the owner of the
 * business confirms it (CXN-EXE-04), so the figure is labelled and every answer says how many lines took it.
 */
export const BOQ_RETENTION_RULE = { key: 'CTR.RETENTION', defaultPct: '5.0000', awaitingConfirmation: true, cxn: 'CXN-EXE-04' } as const;

/** The members of a line the import accepts; any other member is refused, whatever it holds. */
export const BOQ_LINE_FIELDS = [
  'business_key',
  'description',
  'unit_code',
  'quantity',
  'unit_price',
  'rounding_rule',
  'retention_pct',
  'milestone_code',
  'milestone_due_on',
  'party_contractor_id',
] as const;

/** Why a row cannot be imported: a stable word the screen translates, never the value that was typed. */
export type BoqRowReason =
  | 'notAnObject'
  | 'notAllowed'
  | 'required'
  | 'tooLong'
  | 'invalidText'
  | 'invalidNumber'
  | 'tooPrecise'
  | 'tooLarge'
  | 'invalidRounding'
  | 'invalidPercent'
  | 'invalidDate'
  | 'invalidId'
  | 'duplicateKey'
  | 'amountTooLarge'
  | 'unitUnknown'
  | 'unitChanged'
  | 'partyUnknown';

/** A fault of one row: its place among the data rows (the first is 1), the field and the reason. */
export interface BoqRowError {
  row: number;
  field: string;
  reason: BoqRowReason;
}

/** A line as it is stored: the texts trimmed, the numbers exact and normalised, the amount already rounded by the rule of the line. */
export interface BoqLine {
  businessKey: string;
  description: string;
  unitCode: string;
  /** Exact decimal strings: at most six digits after the point, written without trailing zeros. */
  quantity: string;
  unitPrice: string;
  roundingRule: BoqRoundingRule;
  /** A percentage with four digits after the point. */
  retentionPct: string;
  /** True when the line named no retention and took the default of the rule. */
  retentionDefaulted: boolean;
  milestoneCode: string | null;
  milestoneDueOn: string | null;
  partyContractorId: string | null;
  /** Whole VND, an exact decimal string. */
  amountVnd: string;
}

const MAX_KEY = 100;
const MAX_DESCRIPTION = 2000;
const MAX_MILESTONE = 100;
const MAX_AMOUNT_DIGITS = 24;
const UNIT_CODE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,49}$/;
const NUMBER = /^(0|[1-9]\d*)(\.\d+)?$/;
const MAX_INTEGER_DIGITS = 18;
const MAX_FRACTION_DIGITS = 6;
const PERCENT = /^(?:100(?:\.0{1,4})?|[1-9]?\d(?:\.\d{1,4})?)$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DELETE_CODE = 127;
const SPACE_CODE = 32;

/** Whether a text holds a control character (a line break, a tab, a NUL): none belongs in a key, a wording or a milestone. */
const hasControl = (text: string): boolean => [...text].some((character) => (character.codePointAt(0) ?? SPACE_CODE) < SPACE_CODE || character.codePointAt(0) === DELETE_CODE);

type Raw = Record<string, unknown>;

/** The value of a number without the zeros after the point that carry nothing (`1234.500000` is `1234.5`, `3.000000` is `3`). */
export function plainDecimal(value: string): string {
  return value.includes('.') ? value.replace(/\.?0+$/, '') : value;
}

/** A percentage as the four digits after the point it is stored with. */
export function percentText(value: string): string {
  const [whole = '0', fraction = ''] = value.split('.');
  return `${whole}.${fraction.padEnd(4, '0')}`;
}

/**
 * The amount of a line in whole VND: the exact product of the quantity and the unit price, rounded once by the rule of the line (BR-CTR-02).
 * 3 x 1,234.5 is 3,703.5, which is 3,704 half up or up and 3,703 down. No float is involved at any step.
 */
export function boqLineAmount(quantity: string, unitPrice: string, rule: BoqRoundingRule): string {
  return roundDecimal(multiplyDecimal(quantity, unitPrice), 0, rule);
}

/** The sum of the amounts of lines, exactly. */
export function boqTotal(amounts: readonly string[]): string {
  return amounts.reduce((total, amount) => addDecimal(total, amount), '0');
}

/** The comparison of the lines of a revision with the amount of the revision (BR-CTR-02: the difference is zero). */
export interface BoqReconciliation {
  revisionAmountVnd: string;
  linesTotalVnd: string;
  /** The lines minus the revision: negative while the BOQ is short of the value, positive when it is above it. */
  differenceVnd: string;
  lineCount: number;
  matches: boolean;
}

export function reconciliationOf(revisionAmountVnd: string, linesTotalVnd: string, lineCount: number): BoqReconciliation {
  const difference = addDecimal(linesTotalVnd, `-${revisionAmountVnd}`);
  return { revisionAmountVnd, linesTotalVnd, differenceVnd: difference, lineCount, matches: compareDecimal(difference, '0') === 0 };
}

/** BOQ_TOTAL_MISMATCH with the three figures the screen shows; the revision cannot leave the draft until the lines add up to its value. */
export function totalMismatch(reconciliation: Pick<BoqReconciliation, 'revisionAmountVnd' | 'linesTotalVnd' | 'differenceVnd'>): DomainError {
  return new DomainError('BOQ_TOTAL_MISMATCH', 422, 'lines', {
    extensions: { lines_total_vnd: reconciliation.linesTotalVnd, revision_amount_vnd: reconciliation.revisionAmountVnd, difference_vnd: reconciliation.differenceVnd },
  });
}

/** The hash that stands for lines that came without a file: the same lines in the same order always give the same one. */
export function linesHash(lines: readonly BoqLine[]): string {
  return sha256Hex(canonicalJson(lines.map((line) => ({ ...line, retentionDefaulted: undefined }))));
}

// ---- reading one row ---------------------------------------------------------------------------------------------------------

type Fail = (field: string, reason: BoqRowReason) => undefined;

function textOf(row: Raw, field: string, max: number, required: boolean, fail: Fail): string | null | undefined {
  const value = row[field];
  if (value === undefined || value === null) return required ? fail(field, 'required') : null;
  if (typeof value !== 'string') return fail(field, 'invalidText');
  const text = value.trim();
  if (text === '') return required ? fail(field, 'required') : null;
  if (hasControl(text)) return fail(field, 'invalidText');
  if (text.length > max) return fail(field, 'tooLong');
  return text;
}

/** A non-negative number with at most six digits after the point and eighteen before it, as a string: a JSON number is refused, it cannot be exact. */
function numberOf(row: Raw, field: string, fail: Fail): string | undefined {
  const value = row[field];
  if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) return fail(field, 'required');
  if (typeof value !== 'string') return fail(field, 'invalidNumber');
  const text = value.trim();
  if (!NUMBER.test(text)) return fail(field, 'invalidNumber');
  const [whole = '', fraction = ''] = text.split('.');
  if (fraction.length > MAX_FRACTION_DIGITS) return fail(field, 'tooPrecise');
  if (whole.length > MAX_INTEGER_DIGITS) return fail(field, 'tooLarge');
  return plainDecimal(text);
}

function roundingOf(row: Raw, fail: Fail): BoqRoundingRule | undefined {
  const value = row.rounding_rule;
  if (value === undefined || value === null || value === '') return 'HALF_UP';
  return typeof value === 'string' && (BOQ_ROUNDING_RULES as readonly string[]).includes(value) ? (value as BoqRoundingRule) : fail('rounding_rule', 'invalidRounding');
}

function retentionOf(row: Raw, fail: Fail): { pct: string; defaulted: boolean } | undefined {
  const value = row.retention_pct;
  if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) return { pct: BOQ_RETENTION_RULE.defaultPct, defaulted: true };
  if (typeof value !== 'string' || !PERCENT.test(value.trim())) return fail('retention_pct', 'invalidPercent');
  return { pct: percentText(value.trim()), defaulted: false };
}

function dateOf(row: Raw, fail: Fail): string | null | undefined {
  const value = row.milestone_due_on;
  if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) return null;
  if (typeof value !== 'string') return fail('milestone_due_on', 'invalidDate');
  try {
    return calendarDate(value.trim(), 'milestone_due_on');
  } catch {
    return fail('milestone_due_on', 'invalidDate');
  }
}

function partyOf(row: Raw, fail: Fail): string | null | undefined {
  const value = row.party_contractor_id;
  if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) return null;
  if (typeof value !== 'string' || !UUID.test(value.trim())) return fail('party_contractor_id', 'invalidId');
  return value.trim().toLowerCase();
}

function unitOf(row: Raw, fail: Fail): string | undefined {
  const text = textOf(row, 'unit_code', 50, true, fail);
  if (text === undefined || text === null) return undefined;
  return UNIT_CODE.test(text) ? text : fail('unit_code', 'invalidText');
}

function lineOf(raw: unknown, fail: Fail): BoqLine | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return fail('row', 'notAnObject');
  const row = raw as Raw;
  let clean = true;
  const track: Fail = (field, reason) => {
    clean = false;
    return fail(field, reason);
  };
  for (const name of Object.keys(row)) if (!(BOQ_LINE_FIELDS as readonly string[]).includes(name)) track(name, 'notAllowed');
  const businessKey = textOf(row, 'business_key', MAX_KEY, true, track);
  const description = textOf(row, 'description', MAX_DESCRIPTION, true, track);
  const unitCode = unitOf(row, track);
  const quantity = numberOf(row, 'quantity', track);
  const unitPrice = numberOf(row, 'unit_price', track);
  const roundingRule = roundingOf(row, track);
  const retention = retentionOf(row, track);
  const milestoneCode = textOf(row, 'milestone_code', MAX_MILESTONE, false, track);
  const milestoneDueOn = dateOf(row, track);
  const partyContractorId = partyOf(row, track);
  if (
    !clean ||
    typeof businessKey !== 'string' ||
    typeof description !== 'string' ||
    unitCode === undefined ||
    quantity === undefined ||
    unitPrice === undefined ||
    roundingRule === undefined ||
    retention === undefined ||
    milestoneCode === undefined ||
    milestoneDueOn === undefined ||
    partyContractorId === undefined
  ) {
    return undefined;
  }
  const amountVnd = boqLineAmount(quantity, unitPrice, roundingRule);
  if (amountVnd.length > MAX_AMOUNT_DIGITS) return fail('unit_price', 'amountTooLarge');
  return {
    businessKey,
    description,
    unitCode,
    quantity,
    unitPrice,
    roundingRule,
    retentionPct: retention.pct,
    retentionDefaulted: retention.defaulted,
    milestoneCode,
    milestoneDueOn,
    partyContractorId,
    amountVnd,
  };
}

/** The key a row names, when it names one that can be read. */
function keyOf(entry: unknown): string | undefined {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return undefined;
  const value = (entry as Raw).business_key;
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

export interface ParsedBoqLines {
  lines: BoqLine[];
  /** The first MAX_ROW_ERRORS faults, in the order of the rows. */
  errors: BoqRowError[];
  /** The number of rows with at least one fault. */
  errorRows: number;
}

/**
 * Reads the lines of an import: every row is judged, none is skipped at the first fault, so the person fixes the file once. The count of
 * lines is the only fault that is not a row's: an empty import or one above MAX_BOQ_LINES is 422 on `lines`. A key used twice in the
 * import is a fault of the second row. Nothing is written by this function.
 */
export function parseBoqLines(raw: unknown): ParsedBoqLines {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_BOQ_LINES) throw new DomainError('VALIDATION_FAILED', 422, 'lines');
  const lines: BoqLine[] = [];
  const errors: BoqRowError[] = [];
  const faulty = new Set<number>();
  const seen = new Set<string>();
  raw.forEach((entry: unknown, index) => {
    const row = index + 1;
    const fail: Fail = (field, reason) => {
      faulty.add(row);
      if (errors.length < MAX_ROW_ERRORS) errors.push({ row, field, reason });
      return undefined;
    };
    // A row claims its key even when another field of it is wrong, so a key used twice is reported in the same pass.
    const key = keyOf(entry);
    const repeated = key !== undefined && seen.has(key);
    if (key !== undefined) seen.add(key);
    const line = lineOf(entry, fail);
    if (repeated) fail('business_key', 'duplicateKey');
    if (line !== undefined && !repeated) lines.push(line);
  });
  return { lines, errors, errorRows: faulty.size };
}

/** 422 VALIDATION_FAILED on `lines` with the row errors the screen lists. */
export function rowErrorsProblem(parsed: Pick<ParsedBoqLines, 'errors' | 'errorRows'>): DomainError {
  return new DomainError('VALIDATION_FAILED', 422, 'lines', { extensions: { errors: parsed.errors, error_rows: parsed.errorRows } });
}
