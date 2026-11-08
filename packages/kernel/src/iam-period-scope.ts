import { activeGrants } from './effective-access.ts';
import type { EffectiveAccess } from './effective-access.ts';
import { DomainError } from './errors.ts';
import { permissionMatches } from './permission.ts';

/**
 * The reporting period as a limit on authority (IAM-2): a role grant or a delegation can be limited to given report periods, so that the holder acts only on the reports of those periods. A grant without a period scope is not
 * limited (the behaviour that existed before this rule). A period is written as the report layout writes it: `2026-M03` (month), `2026-Q3` (quarter), `2026-H1` (half year), `2026` (year). A scope entry covers its own period
 * and every period inside it (`2026-Q3` covers `2026-M07`); a day (`2026-07-15`, an as-of report) is only ever the thing that is asked about and is covered when its month is.
 */

/** The most period codes one scope holds. */
export const MAX_PERIOD_SCOPE_CODES = 24;

const PERIOD_CODE = /^(\d{4})(?:-(?:M(0[1-9]|1[0-2])|Q([1-4])|H([12])))?$/;
const DAY_CODE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** The months a period spans, counted from year 0 (`year * 12 + month - 1`), both ends included. */
interface MonthRange {
  first: number;
  last: number;
}

function monthIndex(year: number, month: number): number {
  return year * 12 + month - 1;
}

function rangeOfPeriod(code: string): MonthRange | undefined {
  const match = PERIOD_CODE.exec(code);
  if (match === null) return undefined;
  const year = Number(match[1]);
  if (year < 1900 || year > 2999) return undefined;
  if (match[2] !== undefined) return { first: monthIndex(year, Number(match[2])), last: monthIndex(year, Number(match[2])) };
  if (match[3] !== undefined) return { first: monthIndex(year, (Number(match[3]) - 1) * 3 + 1), last: monthIndex(year, Number(match[3]) * 3) };
  if (match[4] !== undefined) return { first: monthIndex(year, (Number(match[4]) - 1) * 6 + 1), last: monthIndex(year, Number(match[4]) * 6) };
  return { first: monthIndex(year, 1), last: monthIndex(year, 12) };
}

function rangeOfDay(code: string): MonthRange | undefined {
  const match = DAY_CODE.exec(code);
  if (match === null) return undefined;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  if (year < 1900 || year > 2999 || date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return undefined;
  return { first: monthIndex(year, month), last: monthIndex(year, month) };
}

/** Whether the text is a period a scope can name: a month, a quarter, a half year or a year. */
export function isScopePeriodCode(code: string): boolean {
  return rangeOfPeriod(code) !== undefined;
}

/** Whether the text is a period or a day that can be asked about. */
export function isReportPeriodCode(code: string): boolean {
  return rangeOfPeriod(code) !== undefined || rangeOfDay(code) !== undefined;
}

export interface PeriodScopeDefect {
  field: string;
  code: 'REQUIRED' | 'MALFORMED' | 'DUPLICATE' | 'TOO_MANY' | 'OVERLAP';
}

/** Every defect of a list of period codes; none when it is valid. A code that another of the list already covers is a defect too (the list says one thing once). */
export function validatePeriodCodes(codes: readonly string[], field = 'period_codes'): PeriodScopeDefect[] {
  const defects: PeriodScopeDefect[] = [];
  if (codes.length === 0) return [{ field, code: 'REQUIRED' }];
  if (codes.length > MAX_PERIOD_SCOPE_CODES) defects.push({ field, code: 'TOO_MANY' });
  const seen = new Set<string>();
  codes.forEach((code, index) => {
    const name = `${field}[${index}]`;
    if (!isScopePeriodCode(code)) defects.push({ field: name, code: 'MALFORMED' });
    else if (seen.has(code)) defects.push({ field: name, code: 'DUPLICATE' });
    else if (codes.some((other, otherIndex) => otherIndex !== index && other !== code && isScopePeriodCode(other) && periodCovered([other], code))) defects.push({ field: name, code: 'OVERLAP' });
    seen.add(code);
  });
  return defects;
}

/** The codes sorted and without repeats, the way they are stored. */
export function normalisePeriodCodes(codes: readonly string[]): string[] {
  return [...new Set(codes)].sort();
}

/** Whether one of the scope entries covers the period or day asked about. A text that is no period is never covered. */
export function periodCovered(scope: readonly string[], code: string): boolean {
  const wanted = rangeOfPeriod(code) ?? rangeOfDay(code);
  if (wanted === undefined) return false;
  return scope.some((entry) => {
    const range = rangeOfPeriod(entry);
    return range !== undefined && range.first <= wanted.first && wanted.last <= range.last;
  });
}

/** The range of months two calendar days (`YYYY-MM-DD`) span; undefined when either is not a day. */
function rangeOfDays(startsOn: string, endsOn: string): MonthRange | undefined {
  const start = rangeOfDay(startsOn);
  const end = rangeOfDay(endsOn);
  if (start === undefined || end === undefined || endsOn < startsOn) return undefined;
  return { first: start.first, last: end.last };
}

/**
 * Whether the scope covers a reporting period given by its first and last day (the calendar of the reports: a week, a month): every month the period touches must lie inside one scope entry. A week that crosses the end of
 * a quarter is covered by a year or by both quarters' parent, not by one quarter alone.
 */
export function periodCoveredByDays(scope: readonly string[], startsOn: string, endsOn: string): boolean {
  const wanted = rangeOfDays(startsOn, endsOn);
  if (wanted === undefined) return false;
  return scope.some((entry) => {
    const range = rangeOfPeriod(entry);
    return range !== undefined && range.first <= wanted.first && wanted.last <= range.last;
  });
}

/** Like `periodAllowed`, for a period given by its days. */
export function periodAllowedForDays(access: EffectiveAccess, now: Date, permission: string, startsOn: string, endsOn: string): boolean {
  const holding = activeGrants(access, now).filter((grant) => grant.permissions.some((held) => permissionMatches(held, permission)));
  if (holding.length === 0) return true;
  return holding.some((grant) => grant.periodCodes === undefined || grant.periodCodes === null || periodCoveredByDays(grant.periodCodes, startsOn, endsOn));
}

/** 403 `PERIOD_SCOPE_DENIED` when the access is limited to other periods than the one of the report (given by its first and last day). */
export function assertPeriodAllowedForDays(access: EffectiveAccess, now: Date, permission: string, startsOn: string, endsOn: string): void {
  if (!periodAllowedForDays(access, now, permission, startsOn, endsOn)) throw new DomainError('PERIOD_SCOPE_DENIED', 403, 'period');
}

/**
 * The periods two limits leave when both apply: what one covers inside the other. `undefined` (no limit) is the whole of time, so the other limit stays as it is; an empty result means that nothing is left.
 */
export function intersectPeriodCodes(left: readonly string[] | null | undefined, right: readonly string[] | null | undefined): string[] | undefined {
  if (left === null || left === undefined) return right === null || right === undefined ? undefined : normalisePeriodCodes(right);
  if (right === null || right === undefined) return normalisePeriodCodes(left);
  const inside = [...left.filter((code) => periodCovered(right, code)), ...right.filter((code) => periodCovered(left, code))];
  return normalisePeriodCodes(inside);
}

/**
 * Whether the access allows the permission for a report of the period: some active grant that holds the permission is either not limited by period or covers it. When no grant holds the permission at all this says
 * `true`, because the question of who may do it at all is the scope check's, not this one's.
 */
export function periodAllowed(access: EffectiveAccess, now: Date, permission: string, period: string): boolean {
  const holding = activeGrants(access, now).filter((grant) => grant.permissions.some((held) => permissionMatches(held, permission)));
  if (holding.length === 0) return true;
  return holding.some((grant) => grant.periodCodes === undefined || grant.periodCodes === null || periodCovered(grant.periodCodes, period));
}

/** 403 `PERIOD_SCOPE_DENIED` when the access is limited to other periods than the one of the report. */
export function assertPeriodAllowed(access: EffectiveAccess, now: Date, permission: string, period: string): void {
  if (!periodAllowed(access, now, permission, period)) throw new DomainError('PERIOD_SCOPE_DENIED', 403, 'period');
}

/** 422 `PERIOD_SCOPE_INVALID` naming the first field, with every defect as a member of the problem. */
export function assertValidPeriodCodes(codes: readonly string[], field = 'period_codes'): void {
  const defects = validatePeriodCodes(codes, field);
  if (defects.length > 0) throw new DomainError('PERIOD_SCOPE_INVALID', 422, defects[0]?.field, { extensions: { defects } });
}
