import { ApiError } from '@machvon/api-client';
import { isVnd, vndOfMillions } from './model';
import { BUCKETS } from './plan-model';
import type { ScheduleBucket } from './plan-model';

/** The permission that gates the registration; the server decides again under the scope of the project. */
export const REGISTER_SCHEDULE_PERMISSION = 'capital.schedule.register';
export const SCHEDULE_PATH = '/cap/cap-08';

/** Month 13 is the adjustment period that follows the year (January of the next year). */
export const ADJUSTMENT_MONTH = 13;
export const MONTHS: readonly number[] = Array.from({ length: ADJUSTMENT_MONTH }, (_, index) => index + 1);
export const REASON_MAX = 2000;
export const MIN_YEAR = 1990;
export const MAX_YEAR = 2100;
export const BUDGET_LEVELS = ['CENTRAL', 'LOCAL'] as const;
export type BudgetLevel = (typeof BUDGET_LEVELS)[number];
/** The stages of a project that take capital, as the server judges them (PIPELINE to SUSPENDED); a project in another stage registers nothing. */
export const SCHEDULABLE_STATUSES: readonly string[] = ['PIPELINE', 'BUDGETED', 'IMPLEMENTATION', 'SUSPENDED'];

type Raw = Record<string, unknown>;
const asRecord = (value: unknown): Raw | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Raw) : undefined);
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

/** A current monthly registration, with what the Treasury paid in its month. */
export interface ScheduleItem {
  id: string;
  month: number;
  bucket: ScheduleBucket;
  budgetLevel: BudgetLevel;
  amountVnd: string;
  ctmtqgSubsetVnd: string | null;
  revision: number;
  disbursedVnd: string;
}

/** The monthly registration as `listDisbursementSchedules` answers it; anything that is not one (a forecast, a week) is left out. */
export function toScheduleItem(raw: unknown): ScheduleItem | undefined {
  const row = asRecord(raw);
  const id = text(row?.id);
  const month = row?.month;
  const bucket = text(row?.bucket);
  const level = text(row?.budget_level);
  const amount = text(row?.amount_vnd);
  const revision = row?.revision;
  if (row === undefined || id === undefined || row.kind !== 'REGISTERED' || row.granularity !== 'MONTH' || row.is_current !== true) return undefined;
  if (typeof month !== 'number' || !Number.isInteger(month) || month < 1 || month > ADJUSTMENT_MONTH) return undefined;
  if (bucket === undefined || !(BUCKETS as readonly string[]).includes(bucket) || level === undefined || !(BUDGET_LEVELS as readonly string[]).includes(level)) return undefined;
  if (amount === undefined || !isVnd(amount) || typeof revision !== 'number') return undefined;
  const subset = text(row.ctmtqg_subset_vnd);
  const paid = text(asRecord(row.achievement)?.disbursed_vnd);
  return {
    id,
    month,
    bucket: bucket as ScheduleBucket,
    budgetLevel: level as BudgetLevel,
    amountVnd: amount,
    ctmtqgSubsetVnd: subset !== undefined && isVnd(subset) ? subset : null,
    revision,
    disbursedVnd: paid !== undefined && isVnd(paid) ? paid : '0',
  };
}

/** One month of the year: what is registered for each source group (both budget levels together), and what was paid. */
export interface MonthRow {
  month: number;
  byBucket: Record<ScheduleBucket, string>;
  registeredVnd: string;
  disbursedVnd: string;
  /** The paid over the registered, to four decimals; null when nothing is registered (the screen says there is no registration). */
  rate: string | null;
}

/** The paid over the registered to four decimals, half up and exact (BigInt, never a float); null when nothing was registered. */
export function rateOf(disbursedVnd: string, registeredVnd: string): string | null {
  const registered = BigInt(registeredVnd);
  if (registered === 0n) return null;
  const scaled = (BigInt(disbursedVnd) * 20000n + registered) / (registered * 2n);
  return `${scaled / 10000n}.${(scaled % 10000n).toString().padStart(4, '0')}`;
}

/** The thirteen months of the year, each with the registrations of its source groups added up exactly. */
export function monthRows(items: readonly ScheduleItem[]): MonthRow[] {
  return MONTHS.map((month) => {
    const mine = items.filter((item) => item.month === month);
    const byBucket = Object.fromEntries(BUCKETS.map((bucket) => [bucket, mine.filter((item) => item.bucket === bucket).reduce((sum, item) => sum + BigInt(item.amountVnd), 0n).toString()])) as Record<ScheduleBucket, string>;
    const registered = mine.reduce((sum, item) => sum + BigInt(item.amountVnd), 0n).toString();
    const disbursed = mine.reduce((sum, item) => sum + BigInt(item.disbursedVnd), 0n).toString();
    return { month, byBucket, registeredVnd: registered, disbursedVnd: disbursed, rate: rateOf(disbursed, registered) };
  });
}

/** The total of the year over the months: registered, paid and the rate of the whole. */
export function yearTotal(rows: readonly MonthRow[]): { registeredVnd: string; disbursedVnd: string; rate: string | null } {
  const registered = rows.reduce((sum, row) => sum + BigInt(row.registeredVnd), 0n).toString();
  const disbursed = rows.reduce((sum, row) => sum + BigInt(row.disbursedVnd), 0n).toString();
  return { registeredVnd: registered, disbursedVnd: disbursed, rate: rateOf(disbursed, registered) };
}

/** The rate as a percentage in the language of the person ("0.3750" is 37,50 %); only for display, the rate itself stays the exact text. */
export function ratePercent(rate: string, locale: string): string {
  return new Intl.NumberFormat(locale, { style: 'percent', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(rate));
}

/** The current registration of a key, when there is one: the form shows what the next save replaces. */
export const currentOf = (items: readonly ScheduleItem[], month: number, bucket: ScheduleBucket, level: BudgetLevel): ScheduleItem | undefined =>
  items.find((item) => item.month === month && item.bucket === bucket && item.budgetLevel === level);

// ---- the form ------------------------------------------------------------------------------------------------------------

export interface RegistrationForm {
  month: string;
  bucket: ScheduleBucket;
  budgetLevel: BudgetLevel;
  /** Millions of dong as typed. */
  amount: string;
  /** The part of the amount that belongs to a national target programme, in millions of dong as typed; empty means none. */
  ctmtqg: string;
  reason: string;
}

export type RegistrationField = keyof RegistrationForm;
export type RegistrationProblem = 'required' | 'invalidAmount' | 'subsetExceeds' | 'tooLong';

export const EMPTY_REGISTRATION: RegistrationForm = { month: '', bucket: 'CURRENT_YEAR', budgetLevel: 'CENTRAL', amount: '', ctmtqg: '', reason: '' };

/** Millions of dong typed by a person, to exact VND; zero is a registration too ("nothing planned this month"), unlike on the screens that allocate capital. */
export function vndOfTyped(input: string, locale: string): string | undefined {
  const typed = input.trim();
  return /^0+$/.test(typed) ? '0' : vndOfMillions(typed, locale);
}

export const monthOf = (value: string): number | undefined => (/^\d{1,2}$/.test(value) && Number(value) >= 1 && Number(value) <= ADJUSTMENT_MONTH ? Number(value) : undefined);

/** What is wrong with a registration before anything is sent; the server judges the same rules again. */
export function validateRegistration(form: RegistrationForm, locale: string): Partial<Record<RegistrationField, RegistrationProblem>> {
  const problems: Partial<Record<RegistrationField, RegistrationProblem>> = {};
  if (monthOf(form.month) === undefined) problems.month = 'required';
  const amount = form.amount.trim() === '' ? undefined : vndOfTyped(form.amount, locale);
  if (form.amount.trim() === '') problems.amount = 'required';
  else if (amount === undefined) problems.amount = 'invalidAmount';
  if (form.ctmtqg.trim() !== '') {
    const subset = vndOfTyped(form.ctmtqg, locale);
    if (subset === undefined) problems.ctmtqg = 'invalidAmount';
    else if (amount !== undefined && BigInt(subset) > BigInt(amount)) problems.ctmtqg = 'subsetExceeds';
  }
  if (form.reason.trim().length > REASON_MAX) problems.reason = 'tooLong';
  return problems;
}

/** The body of `registerDisbursementSchedule` for a form that passed `validateRegistration`: a monthly registration, the amounts as exact VND. */
export function registrationBody(form: RegistrationForm, projectId: string, year: number, locale: string) {
  const subset = form.ctmtqg.trim() === '' ? undefined : vndOfTyped(form.ctmtqg, locale);
  const reason = form.reason.trim();
  return {
    project_id: projectId,
    plan_year: year,
    granularity: 'MONTH' as const,
    month: Number(form.month),
    kind: 'REGISTERED' as const,
    bucket: form.bucket,
    budget_level: form.budgetLevel,
    amount_vnd: vndOfTyped(form.amount, locale) as string,
    ...(subset === undefined ? {} : { ctmtqg_subset_vnd: subset }),
    ...(reason === '' ? {} : { revision_reason: reason }),
  };
}

/** The year the person typed, or undefined when it is not a year the server takes. */
export function yearOf(value: string): number | undefined {
  const year = /^\d{4}$/.test(value.trim()) ? Number(value.trim()) : undefined;
  return year !== undefined && year >= MIN_YEAR && year <= MAX_YEAR ? year : undefined;
}

export type ScheduleProblem = 'subset' | 'periodLocked' | 'yearLocked' | 'stage' | 'denied' | 'notFound' | 'validation' | 'general';

const PROBLEM_BY_CODE: Readonly<Record<string, ScheduleProblem>> = {
  SUBSET_EXCEEDS_PARENT: 'subset',
  PERIOD_LOCKED: 'periodLocked',
  FISCAL_YEAR_LOCKED: 'yearLocked',
  PROJECT_STAGE_INVALID: 'stage',
  SCOPE_DENIED: 'denied',
  RESOURCE_NOT_FOUND: 'notFound',
  VALIDATION_FAILED: 'validation',
  INVALID_REQUEST: 'validation',
  FIELD_NOT_ALLOWED: 'validation',
};

/** Maps the failure of the registration to what the screen says. */
export function describeScheduleProblem(error: unknown): ScheduleProblem {
  if (!(error instanceof ApiError)) return 'general';
  return PROBLEM_BY_CODE[error.code] ?? (error.status === 403 ? 'denied' : 'general');
}
