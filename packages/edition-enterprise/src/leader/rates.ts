import { DomainError, addSums, rateOfSums } from '@machvon/kernel';
import type { RateBasis, RateFigures, RateSums } from '@machvon/kernel';

/**
 * The disbursement against the annual plan of the leadership dashboard of the enterprise edition (ENT-4d, HSKT BC.02: "ty le giai ngan so voi ke hoach nam theo Tong cong ty / don vi / du an ... so sanh cung ky nam truoc").
 * The levels are the three of the requirement: the whole company, a unit, a project. Every rate is made by `rateOfSums` of the kernel, the code DIS-19 and HOME use, so a rate on this board and the same rate on HOME-09
 * cannot differ by a digit: the rate of a group is the sum of its numerators over the sum of its denominators, never the mean of the rates of the parts. The sums come in through `RateGroupSource`; the default source reads
 * the lines of a frozen snapshot, and the reader of the enterprise snapshot (ENT-3a, `EnterpriseFigureReader`) is adapted to the same shape. Pure: no clock, no database.
 */

export const LEADER_LEVELS = ['COMPANY', 'UNIT', 'PROJECT'] as const;
export type LeaderLevel = (typeof LEADER_LEVELS)[number];

/** Which plan the rate is over: the whole annual plan, or the plan the parent body assigned (the first can pass 100 percent). */
export const LEADER_DENOMINATORS = ['TOTAL', 'PM_ASSIGNED'] as const;
export type LeaderDenominator = (typeof LEADER_DENOMINATORS)[number];

/** What the lines of one group of a snapshot add up to (the shape the database gives `DisSnapshotStore.rateSums`). */
export interface RateGroup {
  id: string | null;
  code: string | null;
  name: string | null;
  sums: RateSums;
}

/** The three cuts of one frozen snapshot: the whole, by unit, by project. */
export interface RateCuts {
  /** The id and the day of the snapshot the cuts are of. */
  snapshotId: string;
  asOfDate: string;
  units: readonly RateGroup[];
  projects: readonly RateGroup[];
}

/** Why a figure of last year is missing. */
export type LastYearReason = 'NO_PRIOR_SNAPSHOT' | 'NOT_IN_PRIOR_SNAPSHOT';
export type RateTrend = 'UP' | 'DOWN' | 'FLAT';

export interface LeaderRateRow {
  level: LeaderLevel;
  id: string | null;
  code: string | null;
  name: string | null;
  projects: number;
  /** The annual plan the rate is over, whole dong. */
  planVnd: string;
  /** What was disbursed, whole dong; null when nothing is booked (never 0). */
  disbursedVnd: string | null;
  /** Percent with four places; null with `nullReason` when it cannot be given. */
  ratePct: string | null;
  nullReason: string | null;
  treasuryCoverage: RateFigures['treasuryCoverage'];
  lastYear: {
    ratePct: string | null;
    disbursedVnd: string | null;
    /** The reason there is no figure of last year, or of its rate. */
    nullReason: string | null;
  };
  /** This rate minus the rate of the same period last year, in percentage points with four places; null when either is missing. */
  deltaPoints: string | null;
  trend: RateTrend | null;
}

export interface LeaderRateBoard {
  denominator: LeaderDenominator;
  snapshotId: string;
  asOfDate: string;
  /** The snapshot of the same period one year before, or null when there is none. */
  priorSnapshotId: string | null;
  priorAsOfDate: string | null;
  company: LeaderRateRow;
  units: LeaderRateRow[];
  projects: LeaderRateRow[];
}

const SCALE = 10_000n;
const PERCENT = /^-?\d+\.\d{4}$/;

/** A percent text with four places to a whole number of ten-thousandths. */
function scaled(text: string): bigint {
  if (!PERCENT.test(text)) throw new DomainError('VALIDATION_FAILED', 422, 'rate');
  const negative = text.startsWith('-');
  const [whole = '0', fraction = '0000'] = (negative ? text.slice(1) : text).split('.');
  const value = BigInt(whole) * SCALE + BigInt(fraction);
  return negative ? -value : value;
}

function unscaled(value: bigint): string {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  return `${negative ? '-' : ''}${absolute / SCALE}.${(absolute % SCALE).toString().padStart(4, '0')}`;
}

/** The difference of two rates in percentage points, exact. */
export function pointsBetween(current: string, previous: string): string {
  return unscaled(scaled(current) - scaled(previous));
}

export function trendOf(points: string | null): RateTrend | null {
  if (points === null) return null;
  const value = scaled(points);
  return value > 0n ? 'UP' : value < 0n ? 'DOWN' : 'FLAT';
}

const BASIS: RateBasis = 'CURRENT_YEAR';

function figuresOf(sums: RateSums, denominator: LeaderDenominator): { figures: RateFigures; ratePct: string | null; planVnd: string } {
  const figures = rateOfSums(sums, BASIS);
  return denominator === 'TOTAL' ? { figures, ratePct: figures.rateTotalPct, planVnd: figures.planTotalVnd } : { figures, ratePct: figures.ratePmPct, planVnd: figures.planPmVnd };
}

function rowOf(level: LeaderLevel, group: Pick<RateGroup, 'id' | 'code' | 'name'>, sums: RateSums, previous: RateSums | 'NO_SNAPSHOT' | 'MISSING', denominator: LeaderDenominator): LeaderRateRow {
  const now = figuresOf(sums, denominator);
  const nullReason = now.ratePct === null ? (now.figures.rateNullReason ?? 'NO_DATA') : null;
  let lastYear: LeaderRateRow['lastYear'];
  if (previous === 'NO_SNAPSHOT') lastYear = { ratePct: null, disbursedVnd: null, nullReason: 'NO_PRIOR_SNAPSHOT' };
  else if (previous === 'MISSING') lastYear = { ratePct: null, disbursedVnd: null, nullReason: 'NOT_IN_PRIOR_SNAPSHOT' };
  else {
    const before = figuresOf(previous, denominator);
    lastYear = { ratePct: before.ratePct, disbursedVnd: before.figures.numeratorVnd, nullReason: before.ratePct === null ? (before.figures.rateNullReason ?? 'NO_DATA') : null };
  }
  const deltaPoints = now.ratePct !== null && lastYear.ratePct !== null ? pointsBetween(now.ratePct, lastYear.ratePct) : null;
  return {
    level,
    id: group.id,
    code: group.code,
    name: group.name,
    projects: now.figures.projects,
    planVnd: now.planVnd,
    disbursedVnd: now.figures.numeratorVnd,
    ratePct: now.ratePct,
    nullReason,
    treasuryCoverage: now.figures.treasuryCoverage,
    lastYear,
    deltaPoints,
    trend: trendOf(deltaPoints),
  };
}

const keyOf = (group: Pick<RateGroup, 'id' | 'code'>): string => group.id ?? `code:${group.code ?? ''}`;

/**
 * The board: the whole company, each unit and each project of the current snapshot, each against the same group of the snapshot of the same period last year. A group that did not exist last year says
 * `NOT_IN_PRIOR_SNAPSHOT`; with no snapshot of last year at all every row says `NO_PRIOR_SNAPSHOT`; neither is ever shown as a rate of 0. The whole company is the sum of the unit groups plus the lines that belong to no unit,
 * which the caller gives as `whole` so that a project with no unit is not lost from the company figure.
 */
export function leaderRateBoard(input: { current: RateCuts; whole: RateSums; previous: (RateCuts & { whole: RateSums }) | undefined; denominator: LeaderDenominator }): LeaderRateBoard {
  const { current, previous, denominator } = input;
  const priorUnits = previous === undefined ? undefined : new Map(previous.units.map((group) => [keyOf(group), group.sums]));
  const priorProjects = previous === undefined ? undefined : new Map(previous.projects.map((group) => [keyOf(group), group.sums]));
  const lookup = (prior: Map<string, RateSums> | undefined, group: RateGroup): RateSums | 'NO_SNAPSHOT' | 'MISSING' => (prior === undefined ? 'NO_SNAPSHOT' : (prior.get(keyOf(group)) ?? 'MISSING'));
  return {
    denominator,
    snapshotId: current.snapshotId,
    asOfDate: current.asOfDate,
    priorSnapshotId: previous?.snapshotId ?? null,
    priorAsOfDate: previous?.asOfDate ?? null,
    company: rowOf('COMPANY', { id: null, code: null, name: null }, input.whole, previous === undefined ? 'NO_SNAPSHOT' : previous.whole, denominator),
    units: current.units.map((group) => rowOf('UNIT', group, group.sums, lookup(priorUnits, group), denominator)),
    projects: current.projects.map((group) => rowOf('PROJECT', group, group.sums, lookup(priorProjects, group), denominator)),
  };
}

/** The whole of a snapshot from its unit groups (used when a source gives the groups only). */
export const wholeOf = (groups: readonly RateGroup[]): RateSums => addSums(groups.map((group) => group.sums));

/** The day one year before a day; 29 February of a leap year becomes 28 February. */
export function sameDayLastYear(asOfDate: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(asOfDate);
  if (match === null || new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))).toISOString().slice(0, 10) !== asOfDate) throw new DomainError('VALIDATION_FAILED', 422, 'as_of_date');
  const year = Number(match[1]) - 1;
  const month = Number(match[2]);
  const day = Number(match[3]);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${String(year).padStart(4, '0')}-${match[2]}-${String(Math.min(day, lastDay)).padStart(2, '0')}`;
}

const DAY_MS = 86_400_000;
/** How far before the same day last year a closing may be and still be the same period (the committee workspace BAN-01 reads last year the same way: a closing on or before that day, within forty days). */
export const PRIOR_WINDOW_DAYS = 40;

/**
 * The snapshot of the same period one year before: the latest candidate whose day is on or before the day one year earlier and not more than `PRIOR_WINDOW_DAYS` before it, so that a closing a few days off the calendar
 * day is the same period and the board agrees with BAN-01. Undefined when none is near enough.
 */
export function priorSnapshotOf<T extends { asOfDate: string }>(asOfDate: string, candidates: readonly T[]): T | undefined {
  const target = Date.parse(`${sameDayLastYear(asOfDate)}T00:00:00Z`);
  let best: T | undefined;
  for (const item of candidates) {
    const distance = (target - Date.parse(`${item.asOfDate}T00:00:00Z`)) / DAY_MS;
    if (distance < 0 || distance >= PRIOR_WINDOW_DAYS) continue;
    if (best === undefined || item.asOfDate > best.asOfDate) best = item;
  }
  return best;
}
