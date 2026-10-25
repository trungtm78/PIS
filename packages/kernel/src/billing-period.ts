import type { PlanBillingCycle } from './plan-catalogue.ts';

const DAY_MS = 86_400_000;

/** How many months a billing period of this cycle spans. A contract-term subscription is billed by the year (the term itself is not modelled yet). */
export function cycleMonths(cycle: PlanBillingCycle): number {
  switch (cycle) {
    case 'MONTHLY':
      return 1;
    case 'QUARTERLY':
      return 3;
    case 'ANNUAL':
    case 'CONTRACT_TERM':
      return 12;
  }
}

const parseDay = (value: string): { year: number; month: number; day: number } => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) throw new RangeError(`not a calendar day: ${value}`);
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) throw new RangeError(`not a calendar day: ${value}`);
  return { year, month, day };
};

const dayText = (time: number): string => new Date(time).toISOString().slice(0, 10);
const dayNumber = (value: string): number => {
  const { year, month, day } = parseDay(value);
  return Date.UTC(year, month - 1, day) / DAY_MS;
};

/** The day `months` after `anchor`, counted from the anchor itself, and the last day of the month when the month is shorter (31 January plus a month is 28 February). */
export function addMonthsClamped(anchor: string, months: number): string {
  const { year, month, day } = parseDay(anchor);
  const total = year * 12 + (month - 1) + months;
  const [targetYear, targetMonth] = [Math.floor(total / 12), total % 12];
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  return dayText(Date.UTC(targetYear, targetMonth, Math.min(day, lastDay)));
}

export function addDays(day: string, days: number): string {
  return dayText((dayNumber(day) + days) * DAY_MS);
}

export interface BillingPeriod {
  /** The first day of the period. */
  start: string;
  /** The last day of the period, which belongs to it (periods are counted with both ends). */
  end: string;
}

/**
 * The `index`th period of a subscription from its billing anchor (0 is the first): each starts where the one before ended and is counted from the
 * anchor, so a subscription anchored on the 31st does not drift to the 28th for good after a short month.
 */
export function billingPeriod(anchor: string, cycle: PlanBillingCycle, index: number): BillingPeriod {
  const months = cycleMonths(cycle);
  return { start: addMonthsClamped(anchor, months * index), end: addDays(addMonthsClamped(anchor, months * (index + 1)), -1) };
}

/** The period of the subscription that holds `today`; undefined before the anchor. */
export function billingPeriodAt(anchor: string, cycle: PlanBillingCycle, today: string): BillingPeriod | undefined {
  if (today < anchor) return undefined;
  const months = cycleMonths(cycle);
  const { year: ay, month: am } = parseDay(anchor);
  const { year: ty, month: tm } = parseDay(today);
  // The index can only be the guess or one less: the day of the month decides within the month the guess lands in.
  let index = Math.floor(((ty - ay) * 12 + (tm - am)) / months);
  while (index > 0 && billingPeriod(anchor, cycle, index).start > today) index -= 1;
  while (billingPeriod(anchor, cycle, index).end < today) index += 1;
  return billingPeriod(anchor, cycle, index);
}

/** The days of a period, both ends counted. */
export function daysInPeriod(period: BillingPeriod): number {
  return dayNumber(period.end) - dayNumber(period.start) + 1;
}

export interface Proration {
  /** Whole VND, rounded down, as text. */
  amountVnd: string;
  /** The days of the period that have passed, today not counted (SAS.md BR-SAS-08). */
  usedDays: number;
  /** The days left, today counted. */
  remainingDays: number;
  totalDays: number;
}

const VND = /^[0-9]{1,24}$/;

/**
 * What to charge now for moving to a dearer plan inside the period (SAS.md BR-SAS-08): the difference of the prices for the days that are left,
 * `floor((new - old) * remaining / days)` in whole VND, so the customer is never charged a fraction and never more than the difference.
 * Only an upgrade has a proration; a plan that costs the same or less costs nothing now (and never gives money back mid-period).
 */
export function prorationOf(input: { oldPriceVnd: string; newPriceVnd: string; today: string; period: BillingPeriod }): Proration {
  if (!VND.test(input.oldPriceVnd) || !VND.test(input.newPriceVnd)) throw new RangeError('a price is whole VND, not negative');
  const totalDays = daysInPeriod(input.period);
  const usedDays = Math.min(Math.max(dayNumber(input.today) - dayNumber(input.period.start), 0), totalDays);
  const remainingDays = totalDays - usedDays;
  const difference = BigInt(input.newPriceVnd) - BigInt(input.oldPriceVnd);
  const amount = difference <= 0n ? 0n : (difference * BigInt(remainingDays)) / BigInt(totalDays);
  return { amountVnd: amount.toString(), usedDays, remainingDays, totalDays };
}
