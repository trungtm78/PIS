import { isVnd, millionsInput, millionsText } from '../model';
import { BUCKETS } from '../plan-model';
import type { Bucket } from '../plan-model';
import { ADJUSTMENT_MONTH, BUDGET_LEVELS, MONTHS, REASON_MAX, monthOf, vndOfTyped } from '../schedule-model';
import type { BudgetLevel } from '../schedule-model';

/**
 * CAP-12 and CAP-13: the estimate of the disbursement of a year, entered month by month with the assumption it rests on (ST-CAP-012, CAP 3.1 F7, BR-CAP-08). An estimate is a promise like a registration: it is shown beside what
 * was registered and what the Treasury paid, and never added to it. The year-end estimate (EAC) is not worked out here; it is read from DIS, which takes the estimates in force into it.
 */
export const READ_PERMISSION = 'capital.read';
export const EAC_READ_PERMISSION = 'disbursement.read';
export const PLAN_PATH = '/cap/cap-12';
export const ENTRY_PATH = '/cap/cap-13';
export const ASSUMPTION_MAX = 2000;

/** Whether the permission is held, or not yet known: the screen asks for nothing it may not read, and the server judges the scope again. */
export const mayRead = (permissions: readonly string[] | undefined, permission: string): boolean => permissions === undefined || permissions.includes(permission);

/** The address of the other screen of the pair, with the project and the year the person is looking at. */
export const linkTo = (path: string, projectId: string, year: string): string => `${path}?${new URLSearchParams({ project: projectId, year }).toString()}`;

type Raw = Record<string, unknown>;
const asRecord = (value: unknown): Raw | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Raw) : undefined);
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

export type Kind = 'REGISTERED' | 'FORECAST';

/** A monthly line in force: a registration (with what the Treasury paid in its month) or an estimate (with its assumption). */
export interface ScheduleLine {
  id: string;
  kind: Kind;
  month: number;
  bucket: Bucket;
  budgetLevel: BudgetLevel;
  amountVnd: string;
  assumption: string | null;
  revision: number;
  /** What the Treasury paid against a registration; null for an estimate, which has no payment of its own. */
  disbursedVnd: string | null;
}

/** The monthly line as `listDisbursementSchedules` answers it; a weekly commitment, an old revision or a line of another shape is left out. */
export function toScheduleLine(raw: unknown): ScheduleLine | undefined {
  const row = asRecord(raw);
  const id = text(row?.id);
  const bucket = BUCKETS.find((candidate) => candidate === row?.bucket);
  const level = BUDGET_LEVELS.find((candidate) => candidate === row?.budget_level);
  const kind = row?.kind === 'REGISTERED' || row?.kind === 'FORECAST' ? row.kind : undefined;
  const amount = text(row?.amount_vnd);
  const month = row?.month;
  const revision = row?.revision;
  if (row === undefined || id === undefined || kind === undefined || bucket === undefined || level === undefined || amount === undefined || !isVnd(amount)) return undefined;
  if (row.granularity !== 'MONTH' || row.is_current !== true || typeof revision !== 'number') return undefined;
  if (typeof month !== 'number' || !Number.isInteger(month) || month < 1 || month > ADJUSTMENT_MONTH) return undefined;
  const paid = text(asRecord(row.achievement)?.disbursed_vnd);
  return {
    id,
    kind,
    month,
    bucket,
    budgetLevel: level,
    amountVnd: amount,
    assumption: text(row.assumption) ?? null,
    revision,
    disbursedVnd: kind === 'REGISTERED' ? (paid !== undefined && isVnd(paid) ? paid : '0') : null,
  };
}

// ---- CAP-12: the plan -----------------------------------------------------------------------------------------------------------

/** One month of the plan; a figure is null where nothing was entered for the month (an estimate of zero is a figure, "nothing is expected"). */
export interface PlanRow {
  month: number;
  forecastVnd: string | null;
  registeredVnd: string | null;
  actualVnd: string | null;
  /** The estimate over the registration (positive when more is expected than was registered); null unless both are there. */
  differenceVnd: string | null;
}

const sumOf = (amounts: readonly string[]): string | null => (amounts.length === 0 ? null : amounts.reduce((sum, amount) => sum + BigInt(amount), 0n).toString());
const gapOf = (forecast: string | null, registered: string | null): string | null => (forecast === null || registered === null ? null : (BigInt(forecast) - BigInt(registered)).toString());

/** The thirteen months of the year with the estimates, the registrations and the payments of their source groups added up exactly. */
export function planRows(lines: readonly ScheduleLine[]): PlanRow[] {
  return MONTHS.map((month) => {
    const mine = lines.filter((line) => line.month === month);
    const forecast = sumOf(mine.filter((line) => line.kind === 'FORECAST').map((line) => line.amountVnd));
    const registered = mine.filter((line) => line.kind === 'REGISTERED');
    return {
      month,
      forecastVnd: forecast,
      registeredVnd: sumOf(registered.map((line) => line.amountVnd)),
      actualVnd: sumOf(registered.map((line) => line.disbursedVnd ?? '0')),
      differenceVnd: gapOf(forecast, sumOf(registered.map((line) => line.amountVnd))),
    };
  });
}

/** The year over the months; a column no month has a figure for stays null. */
export function planTotals(rows: readonly PlanRow[]): Omit<PlanRow, 'month'> {
  const forecast = sumOf(rows.flatMap((row) => (row.forecastVnd === null ? [] : [row.forecastVnd])));
  const registered = sumOf(rows.flatMap((row) => (row.registeredVnd === null ? [] : [row.registeredVnd])));
  return { forecastVnd: forecast, registeredVnd: registered, actualVnd: sumOf(rows.flatMap((row) => (row.actualVnd === null ? [] : [row.actualVnd]))), differenceVnd: gapOf(forecast, registered) };
}

/** An amount in millions of dong with its sign, exactly: a difference below zero is written with a minus. */
export function signedMillions(vnd: string, locale: string): string {
  return vnd.startsWith('-') ? `-${millionsText(vnd.slice(1), locale)}` : millionsText(vnd, locale);
}

// ---- CAP-13: the entry ----------------------------------------------------------------------------------------------------------

/** The estimates in force, by month and source group. */
export const estimatesOf = (lines: readonly ScheduleLine[]): ScheduleLine[] =>
  lines
    .filter((line) => line.kind === 'FORECAST')
    .sort((a, b) => a.month - b.month || BUCKETS.indexOf(a.bucket) - BUCKETS.indexOf(b.bucket) || BUDGET_LEVELS.indexOf(a.budgetLevel) - BUDGET_LEVELS.indexOf(b.budgetLevel));

export interface ForecastForm {
  month: string;
  bucket: Bucket;
  budgetLevel: BudgetLevel;
  /** Millions of dong as typed. */
  amount: string;
  assumption: string;
  reason: string;
}

export type ForecastField = keyof ForecastForm;
export type AssumptionProblem = 'required' | 'tooLong' | 'invalidText';

/** What is wrong, by field; a month is only ever missing, an amount missing or not an amount, a reason too long. */
export interface ForecastErrors {
  month?: 'required';
  amount?: 'required' | 'invalidAmount';
  assumption?: AssumptionProblem;
  reason?: 'tooLong';
}

export const EMPTY_FORECAST: ForecastForm = { month: '', bucket: 'CURRENT_YEAR', budgetLevel: 'CENTRAL', amount: '', assumption: '', reason: '' };

const LINE_BREAKS: readonly number[] = [0x09, 0x0a, 0x0d];

/** Whether the text holds a control character; a tab or a line break is not one, as the server judges it. */
function hasControl(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if ((code < 0x20 || code === 0x7f) && !LINE_BREAKS.includes(code)) return true;
  }
  return false;
}

/** What is wrong with an estimate before anything is sent; the server judges the same rules again. An estimate says what it rests on, so the assumption is not optional. */
export function validateForecast(form: ForecastForm, locale: string): ForecastErrors {
  const problems: ForecastErrors = {};
  if (monthOf(form.month) === undefined) problems.month = 'required';
  if (form.amount.trim() === '') problems.amount = 'required';
  else if (vndOfTyped(form.amount, locale) === undefined) problems.amount = 'invalidAmount';
  const assumption = form.assumption.trim();
  if (assumption === '') problems.assumption = 'required';
  else if (assumption.length > ASSUMPTION_MAX) problems.assumption = 'tooLong';
  else if (hasControl(assumption)) problems.assumption = 'invalidText';
  if (form.reason.trim().length > REASON_MAX) problems.reason = 'tooLong';
  return problems;
}

/** The body of `registerDisbursementSchedule` for a form that passed `validateForecast`: a monthly estimate, the amount as exact VND. */
export function forecastBody(form: ForecastForm, projectId: string, year: number, locale: string) {
  const reason = form.reason.trim();
  return {
    project_id: projectId,
    plan_year: year,
    granularity: 'MONTH' as const,
    month: Number(form.month),
    kind: 'FORECAST' as const,
    bucket: form.bucket,
    budget_level: form.budgetLevel,
    amount_vnd: vndOfTyped(form.amount, locale) as string,
    assumption: form.assumption.trim(),
    ...(reason === '' ? {} : { revision_reason: reason }),
  };
}

/** The form of the estimate in force, to change it: the figure and the assumption are offered as they stand. */
export function formOf(line: ScheduleLine, locale: string): ForecastForm {
  return { month: String(line.month), bucket: line.bucket, budgetLevel: line.budgetLevel, amount: millionsInput(line.amountVnd, locale), assumption: line.assumption ?? '', reason: '' };
}
