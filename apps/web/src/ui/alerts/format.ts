const ZONE = 'Asia/Ho_Chi_Minh';
const DAY_MS = 86_400_000;

const parts = (date: Date, options: Intl.DateTimeFormatOptions): Record<string, string> =>
  Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: ZONE, hourCycle: 'h23', ...options }).formatToParts(date).map((part) => [part.type, part.value]));

/** The calendar day (YYYY-MM-DD) of a moment in Vietnam. */
export function todayOf(now: Date = new Date()): string {
  const p = parts(now, { year: 'numeric', month: '2-digit', day: '2-digit' });
  return `${p.year}-${p.month}-${p.day}`;
}

/** "09/11" from "2026-11-09". */
export function dayMonth(day: string): string {
  const [, month, date] = day.split('-');
  return `${date ?? ''}/${month ?? ''}`;
}

/** "HH:MM" of an ISO moment in Vietnam; empty when the moment is not valid. */
export function clock(moment: string | Date): string {
  const date = typeof moment === 'string' ? new Date(moment) : moment;
  if (Number.isNaN(date.getTime())) return '';
  const p = parts(date, { hour: '2-digit', minute: '2-digit' });
  return `${p.hour}:${p.minute}`;
}

/** "HH:MM dd/MM" of an ISO moment in Vietnam. */
export function clockAndDay(moment: string): string {
  const date = new Date(moment);
  if (Number.isNaN(date.getTime())) return '';
  return `${clock(date)} ${dayMonth(todayOf(date))}`;
}

/** Whole days from `from` to `to` (both YYYY-MM-DD); negative when `to` is earlier. */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

/** The ISO moment of 08:00 in Vietnam on a day (YYYY-MM-DD). */
export function morningOf(day: string): string {
  return new Date(`${day}T08:00:00+07:00`).toISOString();
}

/** The day after `day`. */
export function nextDay(day: string): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10);
}

const camel = (value: string): string => value.toLowerCase().replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase());
/** The last part of the key of the words of a severity, a lifecycle and a source (alerts.severity.urgent, alerts.lifecycle.inProgress, alerts.source.siteDiary). */
export const severitySuffix = (severity: string): string => camel(severity);
export const lifecycleSuffix = (lifecycle: string): string => camel(lifecycle);
export const sourceSuffix = (source: string): string => camel(source);

/** The day `count` days after `day` (negative: before), YYYY-MM-DD. */
export function addDays(day: string, count: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + count * DAY_MS).toISOString().slice(0, 10);
}

/** The last day whose 08:00 (Vietnam) is not after `limit`: the furthest day a picker may offer when a command refuses anything past `limit`. */
export function lastMorningBefore(limit: Date): string {
  const day = todayOf(limit);
  return Date.parse(morningOf(day)) <= limit.getTime() ? day : addDays(day, -1);
}

/** The last moment of a day in Vietnam. */
export function endOfDay(day: string): Date {
  return new Date(`${day}T23:59:59+07:00`);
}

/** The words of a reason code (WAITING_INFORMATION → waitingInformation), the last part of the key of its label. */
export const reasonSuffix = (code: string): string => camel(code);
