import { DomainError } from './errors.ts';
import { addCalendarDays, } from './land-timers.ts';

/**
 * The settlement clock of a contract (G1-18 of docs/governance-roadmap-10of10.md, CTR 3.2, PAY 3.5): once a contract is completed its settlement file has to be handed in within a number of months that
 * depends on the group of the project (5 months for the large groups and 4 for the small one in the starting rule; both are flagged "not confirmed" until the legal text is checked with the customer).
 * The deadline is configuration (rule type `CONTRACT_SETTLEMENT_DEADLINE`), never a constant of a job or a screen. Everything here is pure: dates are Vietnam calendar days written `YYYY-MM-DD`.
 */

export const CONTRACT_SETTLEMENT_RULE_TYPE = 'CONTRACT_SETTLEMENT_DEADLINE';
export const SETTLEMENT_CLOCK_GROUPS = ['QTQG', 'A', 'B', 'C'] as const;
export type SettlementClockGroup = (typeof SETTLEMENT_CLOCK_GROUPS)[number];
/** What starts the clock. Only the completion of the contract exists today; the list leaves room for the final acceptance without a migration. */
export const SETTLEMENT_CLOCK_STARTS = ['CONTRACT_COMPLETED'] as const;
export type SettlementClockStart = (typeof SETTLEMENT_CLOCK_STARTS)[number];

export interface SettlementDeadlineParams {
  /** Months allowed from the start to the day the settlement file is handed in, by group of the project. */
  months_by_group: Readonly<Record<SettlementClockGroup, number>>;
  /** Months for a project whose group is not known yet (a contract can be completed on a project without a group in a test or an import). */
  default_months: number;
  starts_on: SettlementClockStart;
  /** The clock is "near" when this many days (or fewer) are left. */
  near_days: number;
}

/** The built-in default: 5 months for QTQG, A and B, 4 months for C, near at 30 days (roadmap G1-18; not verified against the legal text). */
export function settlementDeadlineDefaults(): SettlementDeadlineParams {
  return { months_by_group: { QTQG: 5, A: 5, B: 5, C: 4 }, default_months: 5, starts_on: 'CONTRACT_COMPLETED', near_days: 30 };
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);
const months = (value: unknown, field: string): number => {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 60) throw invalid(field);
  return value;
};

/** The params of a `CONTRACT_SETTLEMENT_DEADLINE` rule, checked: a rule that does not say all of it is refused rather than half applied. */
export function settlementDeadlineParams(raw: unknown): SettlementDeadlineParams {
  if (!isRecord(raw)) throw invalid('params');
  const by = raw.months_by_group;
  if (!isRecord(by)) throw invalid('months_by_group');
  const startsOn = raw.starts_on;
  if (typeof startsOn !== 'string' || !(SETTLEMENT_CLOCK_STARTS as readonly string[]).includes(startsOn)) throw invalid('starts_on');
  const near = raw.near_days;
  if (typeof near !== 'number' || !Number.isInteger(near) || near < 1 || near > 120) throw invalid('near_days');
  return {
    months_by_group: { QTQG: months(by.QTQG, 'months_by_group.QTQG'), A: months(by.A, 'months_by_group.A'), B: months(by.B, 'months_by_group.B'), C: months(by.C, 'months_by_group.C') },
    default_months: months(raw.default_months, 'default_months'),
    starts_on: startsOn as SettlementClockStart,
    near_days: near,
  };
}

/** The months the rule gives a project of this group (the default for a group the rule does not know). */
export function settlementMonths(params: SettlementDeadlineParams, group: string | null): number {
  return group !== null && (SETTLEMENT_CLOCK_GROUPS as readonly string[]).includes(group) ? params.months_by_group[group as SettlementClockGroup] : params.default_months;
}

/**
 * The calendar day `count` months after `date`: the same day of the month, or the last day of the month when it has none (31 August plus 6 months is 28 February). No calendar of working days is
 * involved: a deadline in months is a deadline in calendar months.
 */
export function addMonths(date: string, count: number): string {
  if (!Number.isInteger(count) || count < 0 || count > 600) throw invalid('months');
  addCalendarDays(date, 0);
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7)) - 1;
  const day = Number(date.slice(8, 10));
  const total = month + count;
  const targetYear = year + Math.floor(total / 12);
  const targetMonth = total % 12;
  const last = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  return `${String(targetYear).padStart(4, '0')}-${String(targetMonth + 1).padStart(2, '0')}-${String(Math.min(day, last)).padStart(2, '0')}`;
}

/** The last day the settlement file may be handed in: the start plus the months of the rule. The last day itself is not late. */
export const settlementDueOn = (startedOn: string, monthsAllowed: number): string => addMonths(startedOn, monthsAllowed);

const DAY_MS = 86_400_000;
const daysBetween = (from: string, to: string): number => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);

/** The state of a clock: it runs, is near its last day, is past it, or ended (met on time, met late). */
export type SettlementClockState = 'RUNNING' | 'NEAR' | 'OVERDUE' | 'MET' | 'MET_LATE';
/** What is stored: a clock is OPEN until the file is handed in, then MET or MET_LATE for good; NEAR and OVERDUE are read from the day. */
export const STORED_CLOCK_STATES = ['OPEN', 'MET', 'MET_LATE'] as const;
export type StoredClockState = (typeof STORED_CLOCK_STATES)[number];

export interface SettlementClockReading {
  state: SettlementClockState;
  /** Days to the last day: positive before it, zero on it, negative after it; for a clock that ended, the days from the last day to the day it was met (negative when on time). */
  daysLeft: number;
}

/** Where a clock stands on `today`. */
export function settlementClockReading(input: { dueOn: string; today: string; stored: StoredClockState; metOn: string | null; nearDays: number }): SettlementClockReading {
  if (input.stored !== 'OPEN') {
    if (input.metOn === null) throw invalid('met_on');
    return { state: input.stored, daysLeft: daysBetween(input.metOn, input.dueOn) };
  }
  const left = daysBetween(input.today, input.dueOn);
  return { state: left < 0 ? 'OVERDUE' : left <= input.nearDays ? 'NEAR' : 'RUNNING', daysLeft: left };
}

/** The stored state a settlement handed in on `metOn` gives a clock due on `dueOn`. */
export const metStateOf = (metOn: string, dueOn: string): Exclude<StoredClockState, 'OPEN'> => (metOn > dueOn ? 'MET_LATE' : 'MET');

/** The contract statuses that start a clock: the work is complete and the file can be made. */
export const SETTLEMENT_CLOCK_CONTRACT_STATUSES: readonly string[] = ['COMPLETED', 'CLOSED'];
