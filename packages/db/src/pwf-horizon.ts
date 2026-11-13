import { isWorkingDay, processCore } from '@machvon/kernel';
import type { WorkCalendarSource } from '@machvon/kernel';

/**
 * The calendar day that is `count` working days after `from` (before it for a negative `count`; `from` itself for 0), counted on the published calendars the way the colour of a deadline counts them, or null when a year on the way has no published calendar (nothing
 * is guessed). It bounds what a read of tasks has to look at: a task whose working days left are within a line is within the day this gives, whatever the weekdays and holidays of the calendar of the tenant are.
 */
export function workingDayOffset(calendars: WorkCalendarSource | undefined, from: string, count: number): string | null {
  if (calendars === undefined) return null;
  const step = count < 0 ? -1 : 1;
  let remaining = Math.abs(count);
  let cursor = processCore.dayNumber(from);
  for (let scanned = 0; remaining > 0; scanned += 1) {
    if (scanned > processCore.MAX_SCAN_DAYS) return null;
    cursor += step;
    const text = processCore.dayText(cursor);
    const calendar = calendars.forYear(Number(text.slice(0, 4)));
    if (calendar === undefined) return null;
    if (isWorkingDay(calendar, text)) remaining -= 1;
  }
  return processCore.dayText(cursor);
}
