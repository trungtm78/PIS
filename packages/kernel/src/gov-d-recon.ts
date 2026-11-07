import { DomainError } from './errors.ts';

/**
 * Daily reconciliation with the Treasury and the cross-total control (lane D, G4-4 and G4-5 of docs/governance-roadmap-10of10.md). Pure: the comparison of the books with the Treasury statement of one day, by project code and
 * fund; the rule that decides whether a difference becomes an item with an owner; the day it is due, counted in working days; and the control that says whether the three ways of adding up the disbursed money (by unit, by
 * fund, by project) agree, and which one does not. The thresholds are read through `GovernancePolicyPort` (type `RECONCILIATION_POLICY`); the numbers below are only the built-in default that the kernel registry also carries,
 * a starting value that nobody confirmed (a screen says so).
 */

/** The type of rule that carries the thresholds of the daily reconciliation. */
export const RECONCILIATION_POLICY_TYPE = 'RECONCILIATION_POLICY';
export const RECONCILIATION_POLICY_CODE = 'DEFAULT';

export interface ReconPolicy {
  /** A difference strictly above this many dong opens an item. */
  thresholdVnd: number;
  /** When present, a difference strictly above this percent of the larger of the two sides opens an item too. */
  thresholdPct: number | null;
  /** Working days an owner has to explain or resolve an item. */
  dueDays: number;
  /** Days after the statement day that a missing statement still counts as late rather than not yet due. */
  partialAfterDays: number;
}

/** The built-in default (same numbers as the registry of rule types, `registerIntegrityRules`): used only when the registry cannot answer. */
export const TREASURY_RECON_FALLBACK: ReconPolicy = { thresholdVnd: 1_000_000, thresholdPct: null, dueDays: 3, partialAfterDays: 1 };

const wholeNumber = (value: unknown, min: number, max: number, field: string): number => {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw new DomainError('VALIDATION_FAILED', 422, field);
  return value;
};

/** Reads the params of a `RECONCILIATION_POLICY` rule; whatever does not fit is 422 naming the field (never a silent default). */
export function parseReconPolicy(params: Record<string, unknown>): ReconPolicy {
  const pct = params.threshold_pct;
  if (pct !== undefined && (typeof pct !== 'number' || !Number.isFinite(pct) || pct < 0 || pct > 100)) throw new DomainError('VALIDATION_FAILED', 422, 'threshold_pct');
  return {
    thresholdVnd: wholeNumber(params.threshold_vnd, 0, 1_000_000_000_000, 'threshold_vnd'),
    thresholdPct: pct === undefined ? null : pct,
    dueDays: wholeNumber(params.due_days, 1, 60, 'due_days'),
    partialAfterDays: wholeNumber(params.partial_after_days, 0, 30, 'partial_after_days'),
  };
}

/** The fund key of money that no fund could be found for (a Treasury transaction that is not matched to a payment, or matched to one without an allocation line). */
export const UNMATCHED_FUND = 'UNMATCHED';

/** What the two sides say for one project and one fund on one day. Both are signed whole dong as text: a refund takes off. */
export interface ReconLine {
  projectId: string;
  projectCode: string;
  fundKey: string;
  fundLabel: string | null;
  /** What the books say was paid that day: the net of the payment requests settled that day, less the refunds booked that day. */
  booksVnd: string;
  /** What the Treasury says: the transactions confirmed that day, a refund taking off. */
  treasuryVnd: string;
  booksCount: number;
  treasuryCount: number;
}

export const RECON_LINE_KINDS = ['TIMING', 'UNMATCHED', 'MISSING_ON_TREASURY', 'MISSING_INTERNAL', 'AMOUNT'] as const;
export type ReconLineKind = (typeof RECON_LINE_KINDS)[number];

/** Treasury minus books. */
export const differenceOf = (line: Pick<ReconLine, 'booksVnd' | 'treasuryVnd'>): bigint => BigInt(line.treasuryVnd) - BigInt(line.booksVnd);

const absolute = (value: bigint): bigint => (value < 0n ? -value : value);

/**
 * What kind of difference a line holds, or null when the two sides are equal to the dong. `UNMATCHED`: the Treasury paid money that no fund could be found for. `MISSING_ON_TREASURY`: the books paid and the Treasury booked
 * nothing that day. `MISSING_INTERNAL`: the Treasury booked and the books have nothing. `AMOUNT`: both have something and the figures differ. `TIMING`: the same amount with the opposite sign stands on the neighbouring day of the same
 * project and fund (a payment that the two sides date one day apart), so the pair nets out and is not a difference to explain.
 */
export function classifyLine(line: ReconLine, neighbours: readonly Pick<ReconLine, 'booksVnd' | 'treasuryVnd'>[] = []): ReconLineKind | null {
  const difference = differenceOf(line);
  if (difference === 0n) return null;
  if (neighbours.some((neighbour) => differenceOf(neighbour) === -difference)) return 'TIMING';
  if (line.fundKey === UNMATCHED_FUND && BigInt(line.treasuryVnd) !== 0n) return 'UNMATCHED';
  const books = BigInt(line.booksVnd);
  const treasury = BigInt(line.treasuryVnd);
  if (treasury === 0n && line.treasuryCount === 0 && books !== 0n) return 'MISSING_ON_TREASURY';
  if (books === 0n && line.booksCount === 0 && treasury !== 0n) return 'MISSING_INTERNAL';
  return 'AMOUNT';
}

/**
 * Whether a line opens an item for an owner: the difference is not a timing pair and is strictly above the threshold in dong (the threshold itself does not open one), or, when the policy has a percentage, strictly above that
 * percent of the larger side. A difference that exactly equals the threshold is accepted without an item and stays on the line.
 */
export function opensItem(line: ReconLine, kind: ReconLineKind | null, policy: ReconPolicy): boolean {
  if (kind === null || kind === 'TIMING') return false;
  const gap = absolute(differenceOf(line));
  if (gap > BigInt(policy.thresholdVnd)) return true;
  if (policy.thresholdPct === null) return false;
  const larger = absolute(BigInt(line.booksVnd)) > absolute(BigInt(line.treasuryVnd)) ? absolute(BigInt(line.booksVnd)) : absolute(BigInt(line.treasuryVnd));
  // gap > pct% of larger, in integers: gap * 10000 > round(pct * 100) * larger
  return gap * 10_000n > BigInt(Math.round(policy.thresholdPct * 100)) * larger && gap > 0n;
}

const DAY_MS = 86_400_000;
export const addDays = (day: string, days: number): string => new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

/** The day an item opened on `from` is due: `dueDays` working days later; `isWorking` is the working calendar (or the week when no calendar is published, which the caller says on the result). */
export function dueOn(from: string, dueDays: number, isWorking: (day: string) => boolean): string {
  let day = from;
  let left = dueDays;
  // Bounded: a calendar with no working day in two years is a broken calendar, never an endless loop.
  for (let guard = 0; left > 0 && guard < 800; guard += 1) {
    day = addDays(day, 1);
    if (isWorking(day)) left -= 1;
  }
  if (left > 0) throw new DomainError('CALENDAR_NOT_EFFECTIVE', 422, 'due_days');
  return day;
}

/** The week as a calendar: Monday to Friday work (used only when no work calendar is published for the year; the result says "assumed"). */
export const isWeekday = (day: string): boolean => {
  const weekday = new Date(Date.parse(`${day}T00:00:00Z`)).getUTCDay();
  return weekday !== 0 && weekday !== 6;
};

export const RECON_RUN_STATUSES = ['COMPLETE', 'PARTIAL'] as const;
export type ReconRunStatus = (typeof RECON_RUN_STATUSES)[number];
export const RECON_PARTIAL_REASONS = ['STATEMENT_MISSING', 'SOURCE_UNREADABLE'] as const;
export type ReconPartialReason = (typeof RECON_PARTIAL_REASONS)[number];

/**
 * The state of a run: a day whose statement is not in (a working day with no applied statement file and no Treasury transaction that day) is PARTIAL, never "no difference"; so is a day whose sources could not be read.
 * A day that is not a working day and has nothing from the Treasury has nothing to compare and is COMPLETE with no line. `lateByDays` is how far the day is behind today.
 */
export function runStatusOf(input: { statementPresent: boolean; workingDay: boolean; transactions: number; sourceReadable: boolean }): { status: ReconRunStatus; reason: ReconPartialReason | null } {
  if (!input.sourceReadable) return { status: 'PARTIAL', reason: 'SOURCE_UNREADABLE' };
  if (!input.statementPresent && input.transactions === 0 && input.workingDay) return { status: 'PARTIAL', reason: 'STATEMENT_MISSING' };
  return { status: 'COMPLETE', reason: null };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// Cross-total control (G4-5): the disbursed money added up by unit, by fund and by project must be one number.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

export const CROSS_TOTAL_DIMENSIONS = ['UNIT', 'FUND', 'PROJECT'] as const;
export type CrossTotalDimension = (typeof CROSS_TOTAL_DIMENSIONS)[number];

export interface CrossTotalKey {
  key: string;
  label: string | null;
  vnd: string;
}

/** The total of one dimension and the keys it is made of (the unit, the fund or the project each part is for). */
export interface DimensionTotal {
  totalVnd: string;
  keys: readonly CrossTotalKey[];
  /** The source of the figures, said on the screen (a snapshot, the ledger of the Treasury, the payments). */
  source: string;
}

export interface CrossTotalResult {
  /** True only when the three totals are equal to the dong. A figure that is not published is never shown as an official indicator. */
  published: boolean;
  totals: Record<CrossTotalDimension, string>;
  /** The dimensions that disagree with the others: the one that stands alone when two agree, all three when none do; empty when published. */
  disagreeing: CrossTotalDimension[];
  /** The dimensions that agree with each other and were taken as the reference (the larger group of equal totals). */
  agreeing: CrossTotalDimension[];
  /** For each disagreeing dimension, how far its total is from the reference (signed, dimension minus reference); null when no two agree. */
  offsetVnd: Partial<Record<CrossTotalDimension, string | null>>;
}

/**
 * Whether the three totals agree and, when they do not, which dimension is the one that disagrees: the two that are equal are the reference and the third is named; with three different totals nothing can be taken as the
 * reference and all three are named. Never rounds: the totals are whole dong and equal means equal to the dong.
 */
export function crossTotal(dimensions: Record<CrossTotalDimension, DimensionTotal>): CrossTotalResult {
  const totals = { UNIT: dimensions.UNIT.totalVnd, FUND: dimensions.FUND.totalVnd, PROJECT: dimensions.PROJECT.totalVnd };
  const groups = new Map<string, CrossTotalDimension[]>();
  for (const dimension of CROSS_TOTAL_DIMENSIONS) groups.set(totals[dimension], [...(groups.get(totals[dimension]) ?? []), dimension]);
  const biggest = [...groups.values()].sort((left, right) => right.length - left.length)[0] ?? [];
  if (groups.size === 1) return { published: true, totals, disagreeing: [], agreeing: [...CROSS_TOTAL_DIMENSIONS], offsetVnd: {} };
  if (biggest.length === 2) {
    const reference = BigInt(totals[biggest[0] as CrossTotalDimension]);
    const odd = CROSS_TOTAL_DIMENSIONS.filter((dimension) => !biggest.includes(dimension));
    return { published: false, totals, disagreeing: odd, agreeing: biggest, offsetVnd: Object.fromEntries(odd.map((dimension) => [dimension, (BigInt(totals[dimension]) - reference).toString()])) };
  }
  return { published: false, totals, disagreeing: [...CROSS_TOTAL_DIMENSIONS], agreeing: [], offsetVnd: Object.fromEntries(CROSS_TOTAL_DIMENSIONS.map((dimension) => [dimension, null])) };
}

export interface KeyGap {
  key: string;
  label: string | null;
  leftVnd: string;
  rightVnd: string;
  gapVnd: string;
}

/** The keys on which two dimensions that share a key (the projects of the unit view and of the project view) differ, the largest gap first, at most `limit` (the top 20 of the screen). */
export function keyGaps(left: readonly CrossTotalKey[], right: readonly CrossTotalKey[], limit = 20): KeyGap[] {
  const leftBy = new Map(left.map((entry) => [entry.key, entry]));
  const rightBy = new Map(right.map((entry) => [entry.key, entry]));
  const gaps: KeyGap[] = [];
  for (const key of new Set([...leftBy.keys(), ...rightBy.keys()])) {
    const a = leftBy.get(key);
    const b = rightBy.get(key);
    const gap = BigInt(a?.vnd ?? '0') - BigInt(b?.vnd ?? '0');
    if (gap !== 0n) gaps.push({ key, label: a?.label ?? b?.label ?? null, leftVnd: a?.vnd ?? '0', rightVnd: b?.vnd ?? '0', gapVnd: gap.toString() });
  }
  return gaps.sort((x, y) => (absolute(BigInt(y.gapVnd)) > absolute(BigInt(x.gapVnd)) ? 1 : absolute(BigInt(y.gapVnd)) < absolute(BigInt(x.gapVnd)) ? -1 : x.key.localeCompare(y.key))).slice(0, Math.max(0, limit));
}

/** Sums the keys of a dimension into its total (whole dong). */
export const sumKeys = (keys: readonly CrossTotalKey[]): string => keys.reduce((sum, entry) => sum + BigInt(entry.vnd), 0n).toString();
