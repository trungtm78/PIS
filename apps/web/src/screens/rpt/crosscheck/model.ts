import type { components } from '@machvon/contracts';
import { ApiError } from '@machvon/api-client';

/** The pure parts of RPT-09 (ENT-4a, CN.04): the period asked for, the words of a number, the checks of an explanation and the reading of a refusal. */

export type Crosscheck = components['schemas']['RptCrosscheck'];
export type Finding = components['schemas']['RptCrosscheckFinding'];
export type Term = components['schemas']['RptCrosscheckTerm'];
export type Skip = components['schemas']['RptCrosscheckSkip'];
export type Explanation = components['schemas']['RptCrosscheckExplanation'];

export const REASON_MIN = 20;
export const REASON_MAX = 2000;

export interface PeriodChoice {
  kind: 'MONTH' | 'QUARTER';
  year: number;
  index: number;
}

/** The period of the address (`?kind=QUARTER&year=2026&index=4`); today's month when the address says nothing sound. */
export function periodFromSearch(search: URLSearchParams, today: Date): PeriodChoice {
  const kind = search.get('kind') === 'QUARTER' ? 'QUARTER' : 'MONTH';
  const year = Number(search.get('year'));
  const index = Number(search.get('index'));
  const max = kind === 'QUARTER' ? 4 : 12;
  if (Number.isInteger(year) && year >= 1900 && year <= 2999 && Number.isInteger(index) && index >= 1 && index <= max && search.get('year') !== null) return { kind, year, index };
  const month = today.getUTCMonth() + 1;
  return { kind, year: today.getUTCFullYear(), index: kind === 'QUARTER' ? Math.ceil(month / 3) : month };
}

/** The draft the screen was opened from, when the address names a well-formed id. */
export function draftFromSearch(search: URLSearchParams): string | undefined {
  const id = search.get('draft');
  return id !== null && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) ? id : undefined;
}

/** A whole number written with the separator of the language; a decimal text (a rate) keeps its point; null stays empty. */
export function figureText(value: string | null, unit: Finding['unit'], thousands: string): string {
  if (value === null) return '–';
  if (unit === 'PCT') return `${value} %`;
  const negative = value.startsWith('-');
  const digits = negative ? value.slice(1) : value;
  if (!/^\d+$/.test(digits)) return value;
  return `${negative ? '-' : ''}${digits.replace(/\B(?=(\d{3})+(?!\d))/g, thousands)}`;
}

/** The difference with its sign: a plus for a figure above what was expected. */
export function differenceText(value: string, unit: Finding['unit'], thousands: string): string {
  const text = figureText(value, unit, thousands);
  return value.startsWith('-') || value === '0' ? text : `+${text}`;
}

export const reasonProblem = (reason: string): 'short' | 'long' | 'edges' | undefined => {
  if (reason !== reason.trim()) return 'edges';
  if (reason.length < REASON_MIN) return 'short';
  if (reason.length > REASON_MAX) return 'long';
  return undefined;
};

/** The findings that stop the release of the draft, then the other open ones, then the explained ones; each group in the order the server gave. */
export function sortFindings(findings: readonly Finding[]): Finding[] {
  const rank = (one: Finding): number => (one.blocks_release === true ? 0 : one.status === 'OPEN' && one.severity === 'BLOCKING' ? 1 : one.status === 'OPEN' ? 2 : 3);
  return findings.map((one, at) => ({ one, at })).sort((a, b) => rank(a.one) - rank(b.one) || a.at - b.at).map((entry) => entry.one);
}

/** The word of a server enum in the keys of the catalogue: `PVN_MONTHLY` is `pvnMonthly`. */
export const camel = (value: string): string => value.toLowerCase().replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());

export interface Refusal {
  code: string;
  status: number;
  blocking: number | undefined;
}

export function refusalOf(error: unknown): Refusal {
  if (error instanceof ApiError) {
    const count = error.extensions.blocking_count;
    return { code: error.code, status: error.status, blocking: typeof count === 'number' ? count : undefined };
  }
  return { code: 'UNKNOWN', status: 0, blocking: undefined };
}
