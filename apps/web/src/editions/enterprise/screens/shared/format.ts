import { ApiError } from '@machvon/api-client';
import type { Severity, Tone } from '../../../../ui';

/** The shared words of the two connections of the enterprise edition (HPM and Oracle EBS): time, numbers, shape checks and the reading of a failed command. */

export const MIN_REASON = 10;

const VIETNAM_OFFSET_MS = 7 * 3_600_000;

/** An instant as the people of the screen read it: the Vietnam day and minute ("08/11/2026 14:05"). An unreadable value is shown as it came. */
export function vietnamStamp(instant: string | null | undefined): string {
  if (instant === null || instant === undefined) return '';
  const moment = Date.parse(instant);
  if (Number.isNaN(moment)) return instant;
  const text = new Date(moment + VIETNAM_OFFSET_MS).toISOString();
  return `${text.slice(8, 10)}/${text.slice(5, 7)}/${text.slice(0, 4)} ${text.slice(11, 16)}`;
}

/** A day (`YYYY-MM-DD`) or an instant as a day. */
export function dayText(value: string | null | undefined): string {
  if (value === null || value === undefined) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return `${value.slice(8, 10)}/${value.slice(5, 7)}/${value.slice(0, 4)}`;
  return vietnamStamp(value).slice(0, 10);
}

/** A count or an age with the digits of the locale; an age keeps one decimal at most. */
export function numberText(value: number, locale: string): string {
  return value.toLocaleString(locale, { maximumFractionDigits: 1 });
}

/** An exact decimal string (whole dong, at most two places) with group separators, never through a float: `-1234567.5` is `-1.234.567,5` in Vietnamese. */
export function moneyText(value: string | null | undefined, locale: string): string {
  if (value === null || value === undefined || value === '') return '–';
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value);
  if (match === null) return value;
  const [, sign = '', integer = '0', fraction] = match;
  const groupSeparator = locale === 'vi' ? '.' : ',';
  const decimalSeparator = locale === 'vi' ? ',' : '.';
  const grouped = integer.replace(/\B(?=(\d{3})+(?!\d))/g, groupSeparator);
  return `${sign}${grouped}${fraction === undefined ? '' : `${decimalSeparator}${fraction}`}`;
}

export const asRecord = (value: unknown): Record<string, unknown> | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined);

/** The answer of a read, checked for its shape: a wrong shape is an error of the read (never an empty screen). */
export function shaped<T>(raw: unknown, what: string, arrays: readonly string[], objects: readonly string[]): T {
  const body = asRecord(raw);
  if (body === undefined || arrays.some((key) => !Array.isArray(body[key])) || objects.some((key) => asRecord(body[key]) === undefined)) throw new Error(`unexpected ${what}`);
  return body as unknown as T;
}

/** The severity of an alert as the kit knows it; a word the kit does not know is not drawn as a level. */
export function severityOf(value: string | null | undefined): Severity | null {
  return value === 'URGENT' || value === 'ACTION' || value === 'WATCH' ? value : null;
}

export type HealthKind = 'NEVER' | 'FRESH' | 'AGING' | 'STALE';

const HEALTH_TONE: Readonly<Record<HealthKind, Tone>> = { FRESH: 'success', AGING: 'info', STALE: 'warning', NEVER: 'neutral' };
const HEALTH_ICON: Readonly<Record<HealthKind, string>> = { FRESH: '✓', AGING: '◔', STALE: '⚠', NEVER: '○' };
export const healthKind = (status: string): HealthKind => (status === 'FRESH' ? 'FRESH' : status === 'AGING' ? 'AGING' : status === 'STALE' ? 'STALE' : 'NEVER');
export const healthTone = (status: string): Tone => HEALTH_TONE[healthKind(status)];
export const healthIcon = (status: string): string => HEALTH_ICON[healthKind(status)];

/** The reason of a command, trimmed: null when it is long enough, else why not. */
export function reasonProblem(reason: string, min: number = MIN_REASON): 'EMPTY' | 'SHORT' | null {
  const text = reason.trim();
  if (text === '') return 'EMPTY';
  return text.length < min ? 'SHORT' : null;
}

export type SwitchBlock = 'MODE' | 'RIGHT' | null;

/** Why the switch button is not offered: the workspace is read-only, or the server did not give the caller the command. */
export function switchBlock(maySwitch: boolean, mode: 'FULL' | 'READ_ONLY' | undefined): SwitchBlock {
  if (mode === 'READ_ONLY') return 'MODE';
  return maySwitch ? null : 'RIGHT';
}

// ---- a failed command ----------------------------------------------------------------------------------------------------------------------------------------------

export const failureCode = (error: unknown): string | undefined => (error instanceof ApiError ? error.code : undefined);
export const failureStatus = (error: unknown): number | undefined => (error instanceof ApiError ? error.status : undefined);
export const failureDetail = (error: unknown): string | undefined => (error instanceof ApiError && typeof error.detail === 'string' && error.detail !== '' ? error.detail : undefined);

/** A text member of the problem answer (`missing`, `current_revision`): the server's own safe extension, or undefined. */
export function failureExtension(error: unknown, name: string): unknown {
  return error instanceof ApiError ? error.extensions[name] : undefined;
}

/** The members of a list extension that are words (a list the server did not send is empty). */
export function failureList(error: unknown, name: string): string[] {
  const value = failureExtension(error, name);
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}
