import { DomainError, VND_SCALE, asUuid, creditAmount, requirePositiveAmount } from '@machvon/kernel';

/** How a package is chosen (Law on Bidding 22/2023/QH15, Chapter II). The list is a working assumption until legal confirms it (TODOS.md, ST-BID-001). */
export const SELECTION_METHODS = [
  'OPEN_BIDDING',
  'LIMITED_BIDDING',
  'DIRECT_APPOINTMENT',
  'COMPETITIVE_QUOTATION',
  'DIRECT_PURCHASE',
  'SELF_EXECUTION',
  'COMMUNITY_PARTICIPATION',
  'SPECIAL_CASE',
] as const;
export type SelectionMethod = (typeof SELECTION_METHODS)[number];

export const CONTRACT_TYPES = ['LUMP_SUM', 'FIXED_UNIT_PRICE', 'ADJUSTABLE_UNIT_PRICE', 'TIME_BASED', 'MIXED'] as const;
export type PackageContractType = (typeof CONTRACT_TYPES)[number];

export const BIDDING_FORMS = ['ONLINE', 'OFFLINE'] as const;
export type BiddingForm = (typeof BIDDING_FORMS)[number];

export const MAX_PACKAGES = 500;
export const MAX_DURATION_DAYS = 3650;
const MIN_TITLE = 3;
const MAX_TITLE = 500;
const MAX_CODE = 50;
const MAX_LEGAL_BASIS = 2000;
const PERIOD = /^\d{4}-(Q[1-4]|0[1-9]|1[0-2])$/;
const PACKAGE_KEYS: readonly string[] = ['code', 'title', 'budget_vnd', 'method', 'contract_type', 'bidding_form', 'allocation_line_id', 'planned_start_period', 'duration_days'];

/** One package of a plan as it is stored: trimmed text, lower-case ids, a whole amount of VND. */
export interface PackageInput {
  code: string;
  title: string;
  budgetVnd: string;
  method: SelectionMethod;
  contractType: PackageContractType;
  biddingForm: BiddingForm;
  allocationLineId: string;
  plannedStartPeriod: string;
  durationDays: number;
}

export interface NewPlanInput {
  projectId: string;
  title: string;
  legalBasis: string;
  packages: readonly PackageInput[];
}

export interface CheckedPlan extends NewPlanInput {
  totalVnd: string;
}

const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);

const TAB = 9;
const LINE_FEED = 10;
const CARRIAGE_RETURN = 13;
const SPACE = 32;
const DELETE = 127;

/** Whether the text holds a control character; with `lineBreaks`, tabs and line breaks are allowed (a comment may span lines). */
function hasControl(text: string, lineBreaks: boolean): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (lineBreaks && (code === TAB || code === LINE_FEED || code === CARRIAGE_RETURN)) continue;
    if (code < SPACE || code === DELETE) return true;
  }
  return false;
}

/** Text as it is stored: trimmed, within its length, without control characters. */
function textOf(value: unknown, field: string, min: number, max: number): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text.length < min || text.length > max || hasControl(text, false)) throw invalid(field);
  return text;
}

function oneOf<Value extends string>(list: readonly Value[], value: unknown, field: string): Value {
  const found = list.find((candidate) => candidate === value);
  if (found === undefined) throw invalid(field);
  return found;
}

function uuidOf(value: unknown, field: string): string {
  const id = asUuid(value);
  if (id === undefined) throw invalid(field);
  return id;
}

/** An amount of whole VND above zero that the column holds; the digits of the string are exactly what is stored. */
function amountOf(value: unknown, field: string): string {
  try {
    return requirePositiveAmount(value as string, VND_SCALE);
  } catch (error) {
    if (error instanceof DomainError) throw invalid(field);
    throw error;
  }
}

/**
 * Reads the packages out of the body of the command. The contract leaves the items open, so the allowlist is enforced here: a field that is
 * not one of the nine is a fault of the request (FIELD_NOT_ALLOWED), as on every other command, and a value of the wrong shape names its place.
 */
export function readPackages(raw: unknown): PackageInput[] {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_PACKAGES) throw invalid('packages');
  return raw.map((item: unknown, index) => {
    const at = (key: string): string => `packages.${index}.${key}`;
    if (typeof item !== 'object' || item === null || Array.isArray(item)) throw invalid(`packages.${index}`);
    const record = item as Record<string, unknown>;
    const extra = Object.keys(record).find((key) => !PACKAGE_KEYS.includes(key));
    if (extra !== undefined) throw new DomainError('FIELD_NOT_ALLOWED', 400, at(extra));
    const period = record.planned_start_period;
    const duration = record.duration_days;
    if (typeof period !== 'string' || !PERIOD.test(period)) throw invalid(at('planned_start_period'));
    if (typeof duration !== 'number' || !Number.isInteger(duration) || duration < 1 || duration > MAX_DURATION_DAYS) throw invalid(at('duration_days'));
    return {
      code: textOf(record.code, at('code'), 1, MAX_CODE),
      title: textOf(record.title, at('title'), MIN_TITLE, MAX_TITLE),
      budgetVnd: amountOf(record.budget_vnd, at('budget_vnd')),
      method: oneOf(SELECTION_METHODS, record.method, at('method')),
      contractType: oneOf(CONTRACT_TYPES, record.contract_type, at('contract_type')),
      biddingForm: oneOf(BIDDING_FORMS, record.bidding_form, at('bidding_form')),
      allocationLineId: uuidOf(record.allocation_line_id, at('allocation_line_id')),
      plannedStartPeriod: period,
      durationDays: duration,
    };
  });
}

/**
 * The shape of a plan as the store keeps it, with its total: the exact sum of the budgets. A package code appears once (409
 * PACKAGE_CODE_DUPLICATE naming the second one); a total that the column cannot hold is a fault of the request, never a database overflow.
 */
export function checkedPlan(input: NewPlanInput): CheckedPlan {
  const seen = new Set<string>();
  let totalVnd = '0';
  input.packages.forEach((pack, index) => {
    if (seen.has(pack.code)) throw new DomainError('PACKAGE_CODE_DUPLICATE', 409, `packages.${index}.code`);
    seen.add(pack.code);
    try {
      totalVnd = creditAmount(totalVnd, pack.budgetVnd, VND_SCALE);
    } catch (error) {
      if (error instanceof DomainError) throw invalid(`packages.${index}.budget_vnd`);
      throw error;
    }
  });
  return {
    projectId: uuidOf(input.projectId, 'project_id'),
    title: textOf(input.title, 'title', MIN_TITLE, MAX_TITLE),
    legalBasis: textOf(input.legalBasis, 'legal_basis', MIN_TITLE, MAX_LEGAL_BASIS),
    packages: input.packages,
    totalVnd,
  };
}

const MAX_COMMENT = 2000;

/** The words that go with a decision, trimmed; empty is `undefined`. */
export function commentOf(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw invalid('comment');
  const text = value.trim();
  if (text === '') return undefined;
  if (text.length > MAX_COMMENT || hasControl(text, true)) throw invalid('comment');
  return text;
}
