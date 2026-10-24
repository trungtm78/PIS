import { dayOf, isoOf } from './reporting-calendar.ts';

/**
 * The period a piece of dated legal data applies in. Both ends are days of the Vietnam calendar and both are INCLUSIVE: `until` is the
 * last day the data applies, `null` means it has no end yet. (Master data uses an exclusive end; the permit module speaks in last days
 * because a permit and the regulation behind it are written that way: "valid until 31 December".)
 */
export interface EffectivePeriod {
  from: string;
  until: string | null;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Whether the text is a calendar day that exists, written `YYYY-MM-DD`. */
export const isIsoDate = (value: string): boolean => ISO_DATE.test(value) && isoOf(dayOf(value)) === value;

/** The day after (or before, with a negative count) a day. */
export const shiftDays = (date: string, days: number): string => isoOf(dayOf(date) + days);

/** Whether two periods share at least one day. */
export function periodsOverlap(left: EffectivePeriod, right: EffectivePeriod): boolean {
  return (right.until === null || left.from <= right.until) && (left.until === null || right.from <= left.until);
}
