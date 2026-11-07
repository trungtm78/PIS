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
