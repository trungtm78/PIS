import { DomainError } from './errors.ts';
import type { RuleParams } from './governance-rules.ts';

/**
 * The insight over the units, the fund sources and the contractors (G3-10 and G3-11, BI): a heat-map (colour AND the number, never colour alone; a cell with too few projects or contracts is not shown, so no individual
 * can be read out of it, and the totals leave such cells out and say so), the back-test of the early-warning thresholds against what happened in the weeks after (a replay of stored weeks, not a promise, and it changes
 * no live threshold), and the ranking of the units by the trend of their score. Pure and exact; every line and number is a governance rule, unverified until approved; a figure that cannot be told is N/A with its reason.
 */

export const INSIGHT_RULE_TYPE = 'INSIGHT_PARAMS';
export const INSIGHT_RULE_CODE = 'DEFAULT';

export interface InsightParams {
  /** The rate of a unit and a fund source over the pace of the year: green from, amber from (below amber is red). */
  greenRatio: number;
  amberRatio: number;
  /** A cell of fewer projects (or contracts) than this is not shown. */
  minCellCount: number;
  /** The share of the accepted work that was paid, for the contractor views: green from, amber from (percent). */
  ctrGreenPct: number;
  ctrAmberPct: number;
  backtestHorizonWeeks: number;
  /** Points added to the lines of the score (the line where amber begins and where red begins) to make the candidate thresholds. */
  candidateShifts: number[];
  backtestMinPairs: number;
  trendWeeks: number;
  trendTop: number;
}

export const INSIGHT_DEFAULTS: Readonly<Record<string, unknown>> = {
  green_ratio: 0.95,
  amber_ratio: 0.85,
  min_cell_count: 3,
  ctr_green_pct: 90,
  ctr_amber_pct: 70,
  backtest_horizon_weeks: 4,
  candidate_shifts: [-10, -5, 0, 5, 10],
  backtest_min_pairs: 20,
  trend_weeks: 4,
  trend_top: 5,
};

const fail = (field: string): DomainError => new DomainError('GOVERNANCE_RULE_PARAMS_INVALID', 422, field);
function whole(params: RuleParams, field: string, min: number, max: number): number {
  const value = params[field];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw fail(field);
  return value;
}
function real(params: RuleParams, field: string, min: number, max: number): number {
  const value = params[field];
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw fail(field);
  return value;
}

export function insightParamsOf(params: RuleParams): InsightParams {
  const shifts = params.candidate_shifts;
  if (!Array.isArray(shifts) || shifts.length === 0 || shifts.length > 11 || !shifts.every((one) => typeof one === 'number' && Number.isInteger(one) && one >= -50 && one <= 50) || new Set(shifts).size !== shifts.length) throw fail('candidate_shifts');
  const parsed: InsightParams = {
    greenRatio: real(params, 'green_ratio', 0, 5),
    amberRatio: real(params, 'amber_ratio', 0, 5),
    minCellCount: whole(params, 'min_cell_count', 1, 50),
    ctrGreenPct: whole(params, 'ctr_green_pct', 0, 200),
    ctrAmberPct: whole(params, 'ctr_amber_pct', 0, 200),
    backtestHorizonWeeks: whole(params, 'backtest_horizon_weeks', 1, 12),
    candidateShifts: [...(shifts as number[])].sort((left, right) => left - right),
    backtestMinPairs: whole(params, 'backtest_min_pairs', 1, 10_000),
    trendWeeks: whole(params, 'trend_weeks', 1, 12),
    trendTop: whole(params, 'trend_top', 1, 20),
  };
  if (parsed.amberRatio >= parsed.greenRatio) throw fail('amber_ratio');
  if (parsed.ctrAmberPct >= parsed.ctrGreenPct) throw fail('ctr_amber_pct');
  return parsed;
}

// ---- the heat-map -----------------------------------------------------------------------------------------------------------------------------------------------

export const HEAT_VIEWS = ['UNIT_FUND', 'CONTRACTOR_UNIT', 'CONTRACTOR_FUND'] as const;
export type HeatView = (typeof HEAT_VIEWS)[number];
export type HeatBand = 'GREEN' | 'AMBER' | 'RED';
export type HeatNullReason = 'SMALL_CELL' | 'NO_FIGURE' | 'NO_PLAN' | 'NO_DENOMINATOR';

export interface HeatInputCell {
  rowKey: string;
  colKey: string;
  /** Whole dong: what was paid (the Treasury for units and funds, the contract payments for the contractor views); null when there is no figure. */
  numeratorVnd: string | null;
  /** Whole dong: the plan of the Prime Minister (unit and fund) or the accepted work (contractor). */
  denominatorVnd: string;
  /** Projects (unit and fund) or contracts (contractor) in the cell. */
  count: number;
}
export interface HeatCell {
  rowKey: string;
  colKey: string;
  numeratorVnd: string | null;
  denominatorVnd: string | null;
  count: number | null;
  /** The rate as a percent with one decimal; null with the reason when it is not given. */
  ratePct: string | null;
  band: HeatBand | null;
  nullReason: HeatNullReason | null;
}
export interface HeatTotals {
  key: string;
  numeratorVnd: string | null;
  denominatorVnd: string;
  ratePct: string | null;
  cells: number;
  /** Cells of the line that are left out of the total because they are not shown. */
  hidden: number;
}
export interface Heatmap {
  view: HeatView;
  cells: HeatCell[];
  rowTotals: HeatTotals[];
  colTotals: HeatTotals[];
  hiddenCells: number;
}

function percentTenths(numerator: bigint, denominator: bigint): string {
  const tenths = (numerator * 2000n + denominator) / (2n * denominator);
  return `${tenths / 10n}.${tenths % 10n}`;
}

/** The band of a rate: for the units and funds the rate over the pace of the year (green from, amber from), for the contractors the percent paid of the accepted work. */
export function heatBand(view: HeatView, ratePct: string, pacePct: number | null, params: InsightParams): HeatBand | null {
  const rate = Number(ratePct);
  if (view === 'UNIT_FUND') {
    if (pacePct === null || pacePct <= 0) return null;
    const ratio = rate / pacePct;
    return ratio >= params.greenRatio ? 'GREEN' : ratio >= params.amberRatio ? 'AMBER' : 'RED';
  }
  return rate >= params.ctrGreenPct ? 'GREEN' : rate >= params.ctrAmberPct ? 'AMBER' : 'RED';
}

/**
 * The heat-map from the cells of a view: a cell with fewer than the minimum projects (or contracts) shows no figure (SMALL_CELL); a cell with no Treasury figure, no plan or no accepted work says so; a rate is a percent
 * of whole dong with one decimal; the totals of a row and a column are sums of the cells that are shown (not an average of rates) and count the cells that were left out.
 */
export function buildHeatmap(view: HeatView, input: readonly HeatInputCell[], pacePct: number | null, params: InsightParams): Heatmap {
  const cells = input.map((cell): HeatCell => {
    const base = { rowKey: cell.rowKey, colKey: cell.colKey };
    if (cell.count < params.minCellCount) return { ...base, numeratorVnd: null, denominatorVnd: null, count: null, ratePct: null, band: null, nullReason: 'SMALL_CELL' };
    const denominator = BigInt(cell.denominatorVnd);
    const known = { ...base, numeratorVnd: cell.numeratorVnd, denominatorVnd: cell.denominatorVnd, count: cell.count };
    if (cell.numeratorVnd === null) return { ...known, ratePct: null, band: null, nullReason: 'NO_FIGURE' };
    if (denominator <= 0n) return { ...known, ratePct: null, band: null, nullReason: view === 'UNIT_FUND' ? 'NO_PLAN' : 'NO_DENOMINATOR' };
    const ratePct = percentTenths(BigInt(cell.numeratorVnd), denominator);
    return { ...known, ratePct, band: heatBand(view, ratePct, pacePct, params), nullReason: null };
  });
  const totals = (keyOf: (cell: HeatCell) => string): HeatTotals[] => {
    const map = new Map<string, { numerator: bigint | null; denominator: bigint; cells: number; hidden: number }>();
    for (const cell of cells) {
      const key = keyOf(cell);
      const held = map.get(key) ?? { numerator: null, denominator: 0n, cells: 0, hidden: 0 };
      if (cell.nullReason === 'SMALL_CELL') held.hidden += 1;
      else {
        held.cells += 1;
        if (cell.numeratorVnd !== null) held.numerator = (held.numerator ?? 0n) + BigInt(cell.numeratorVnd);
        held.denominator += BigInt(cell.denominatorVnd as string);
      }
      map.set(key, held);
    }
    return [...map.entries()]
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, held]) => ({ key, numeratorVnd: held.numerator === null ? null : held.numerator.toString(), denominatorVnd: held.denominator.toString(), ratePct: held.numerator === null || held.denominator <= 0n ? null : percentTenths(held.numerator, held.denominator), cells: held.cells, hidden: held.hidden }));
  };
  return { view, cells, rowTotals: totals((cell) => cell.rowKey), colTotals: totals((cell) => cell.colKey), hiddenCells: cells.filter((cell) => cell.nullReason === 'SMALL_CELL').length };
}

// ---- the back-test of the early-warning thresholds --------------------------------------------------------------------------------------------------------------

export type ScoreBandName = 'GREEN' | 'AMBER' | 'RED' | 'NO_DATA';
export interface WeekScore {
  unitId: string;
  /** The Monday of the week (`YYYY-MM-DD`). */
  weekStart: string;
  score: number | null;
  band: ScoreBandName;
}

export type BacktestNullReason = 'TOO_FEW_PAIRS' | 'NO_POSITIVE_PREDICTION' | 'NO_OUTCOME';
export interface BacktestCandidate {
  /** The score at or above which the candidate warns. */
  threshold: number;
  /** True when it is the line of the rules in force today (shift 0 of the amber line). */
  isCurrent: boolean;
  shift: number;
  line: 'AMBER' | 'RED';
  pairs: number;
  tp: number;
  fp: number;
  fn: number;
  tn: number;
  precisionPct: string | null;
  recallPct: string | null;
  /** The mean of the weeks between the first warning of a run that ended in red and the red week (units that were warned early); null when none was. */
  meanLeadWeeks: string | null;
  missedUnits: number;
  warnedEarlyUnits: number;
  nullReason: BacktestNullReason | null;
}
export interface Backtest {
  horizonWeeks: number;
  weeksEvaluated: number;
  unitsEvaluated: number;
  pairs: number;
  /** How many of the pairs were followed by a red week inside the horizon (the base rate). */
  positives: number;
  candidates: BacktestCandidate[];
  nullReason: 'TOO_FEW_PAIRS' | null;
}

const addDays = (day: string, days: number): string => new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const pct = (numerator: number, denominator: number): string | null => (denominator === 0 ? null : percentTenths(BigInt(numerator), BigInt(denominator)));

/**
 * Replays the stored weeks against what came after. For each unit and each week with a score, the outcome is "the unit was red in at least one of the next `horizon` weeks"; a candidate threshold warns when the score of
 * the week is at or above it. The pairs are those with a score in the week and the whole horizon stored (a week the horizon of which is not complete yet is not judged); a week with no data in the horizon counts as not red,
 * never as red. The lead time of a unit is the weeks between the first week of the unbroken run of warnings that ended in its first red week and that red week. It is a replay of the past: it does not say the future will do the same
 * and it changes no threshold in force.
 */
export function backtestThresholds(weeks: readonly WeekScore[], lines: { amberFrom: number; redFrom: number }, params: Pick<InsightParams, 'backtestHorizonWeeks' | 'candidateShifts' | 'backtestMinPairs'>): Backtest {
  const horizon = params.backtestHorizonWeeks;
  const byUnit = new Map<string, Map<string, WeekScore>>();
  for (const week of weeks) {
    const held = byUnit.get(week.unitId) ?? new Map<string, WeekScore>();
    held.set(week.weekStart, week);
    byUnit.set(week.unitId, held);
  }
  const latest = weeks.reduce((max, week) => (week.weekStart > max ? week.weekStart : max), '');
  interface Pair {
    unit: string;
    week: string;
    score: number;
    outcome: boolean;
  }
  const pairs: Pair[] = [];
  for (const [unit, held] of byUnit) {
    for (const [week, row] of held) {
      if (row.score === null || addDays(week, 7 * horizon) > latest) continue;
      // A week that was never stored is not observed: it is no outcome, so the pair is left out unless every week of its horizon is on record.
      let outcome = false;
      let observed = true;
      for (let step = 1; step <= horizon; step += 1) {
        const next = held.get(addDays(week, 7 * step));
        if (next === undefined) observed = false;
        else if (next.band === 'RED') outcome = true;
      }
      if (observed) pairs.push({ unit, week, score: row.score, outcome });
    }
  }
  const positives = pairs.filter((pair) => pair.outcome).length;
  const thresholdsOf = (): Array<{ threshold: number; shift: number; line: 'AMBER' | 'RED' }> => {
    const out: Array<{ threshold: number; shift: number; line: 'AMBER' | 'RED' }> = [];
    for (const [line, base] of [['AMBER', lines.amberFrom], ['RED', lines.redFrom]] as const) for (const shift of params.candidateShifts) out.push({ threshold: Math.round((base + shift) * 100) / 100, shift, line });
    return out.sort((left, right) => left.threshold - right.threshold || (left.line < right.line ? -1 : 1));
  };
  const tooFew = pairs.length < params.backtestMinPairs;
  const candidates = thresholdsOf().map((candidate): BacktestCandidate => {
    let tp = 0;
    let fp = 0;
    let fn = 0;
    let tn = 0;
    for (const pair of pairs) {
      const warned = pair.score >= candidate.threshold;
      if (warned && pair.outcome) tp += 1;
      else if (warned) fp += 1;
      else if (pair.outcome) fn += 1;
      else tn += 1;
    }
    // Lead time and missed units: the first red week of each unit and the run of warnings before it.
    const leads: number[] = [];
    let missed = 0;
    for (const [, held] of byUnit) {
      const ordered = [...held.values()].sort((left, right) => (left.weekStart < right.weekStart ? -1 : 1));
      const firstRed = ordered.find((row) => row.band === 'RED');
      if (firstRed === undefined) continue;
      let start = firstRed.weekStart;
      for (let back = 1; ; back += 1) {
        const earlier = held.get(addDays(firstRed.weekStart, -7 * back));
        if (earlier === undefined || earlier.score === null || earlier.score < candidate.threshold) break;
        start = earlier.weekStart;
      }
      const lead = Math.round((Date.parse(`${firstRed.weekStart}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / (7 * 86_400_000));
      if (lead > 0) leads.push(lead);
      else missed += 1;
    }
    const nullReason: BacktestNullReason | null = tooFew ? 'TOO_FEW_PAIRS' : null;
    return {
      threshold: candidate.threshold,
      isCurrent: candidate.shift === 0 && candidate.line === 'AMBER',
      shift: candidate.shift,
      line: candidate.line,
      pairs: pairs.length,
      tp,
      fp,
      fn,
      tn,
      precisionPct: tooFew ? null : pct(tp, tp + fp),
      recallPct: tooFew ? null : pct(tp, tp + fn),
      meanLeadWeeks: leads.length === 0 ? null : (Math.round((leads.reduce((sum, one) => sum + one, 0) / leads.length) * 10) / 10).toFixed(1),
      missedUnits: missed,
      warnedEarlyUnits: leads.length,
      nullReason: nullReason ?? (tp + fp === 0 ? 'NO_POSITIVE_PREDICTION' : positives === 0 ? 'NO_OUTCOME' : null),
    };
  });
  return { horizonWeeks: horizon, weeksEvaluated: new Set(pairs.map((pair) => pair.week)).size, unitsEvaluated: new Set(pairs.map((pair) => pair.unit)).size, pairs: pairs.length, positives, candidates, nullReason: tooFew ? 'TOO_FEW_PAIRS' : null };
}

// ---- the ranking by trend -------------------------------------------------------------------------------------------------------------------------------------

export type TrendNullReason = 'NO_SCORE_NOW' | 'NO_SCORE_BEFORE';
export interface TrendRow {
  unitId: string;
  /** The score now less the score `weeks` weeks before: negative is better (a lower score is a healthier unit), positive is worse. */
  delta: number | null;
  direction: 'IMPROVING' | 'WORSENING' | 'STEADY' | null;
  scoreNow: number | null;
  scoreBefore: number | null;
  nullReason: TrendNullReason | null;
  /** The scores of the weeks in the window, oldest first, null for a week with none. */
  series: Array<number | null>;
  rank: number | null;
}

const round2 = (value: number): number => Math.round(value * 100) / 100;

/**
 * The units ranked by the change of their score between the latest week and `weeks` before it: the most improving first, ties by the code of the unit. A unit with no score at either end has no trend and no position (it is
 * not "steady"); this is the change of the score, not its level, and it says so.
 */
export function trendRanking(weeks: readonly WeekScore[], latestWeek: string, trendWeeks: number, codeOf: (unitId: string) => string): TrendRow[] {
  const byUnit = new Map<string, Map<string, WeekScore>>();
  for (const week of weeks) {
    const held = byUnit.get(week.unitId) ?? new Map<string, WeekScore>();
    held.set(week.weekStart, week);
    byUnit.set(week.unitId, held);
  }
  const rows = [...byUnit.entries()].map(([unitId, held]): TrendRow => {
    const now = held.get(latestWeek)?.score ?? null;
    const before = held.get(addDays(latestWeek, -7 * trendWeeks))?.score ?? null;
    const series = Array.from({ length: trendWeeks + 1 }, (_, index) => held.get(addDays(latestWeek, -7 * (trendWeeks - index)))?.score ?? null);
    if (now === null) return { unitId, delta: null, direction: null, scoreNow: null, scoreBefore: before, nullReason: 'NO_SCORE_NOW', series, rank: null };
    if (before === null) return { unitId, delta: null, direction: null, scoreNow: now, scoreBefore: null, nullReason: 'NO_SCORE_BEFORE', series, rank: null };
    const delta = round2(now - before);
    return { unitId, delta, direction: delta < 0 ? 'IMPROVING' : delta > 0 ? 'WORSENING' : 'STEADY', scoreNow: now, scoreBefore: before, nullReason: null, series, rank: null };
  });
  const ranked = rows.filter((row) => row.delta !== null).sort((left, right) => (left.delta as number) - (right.delta as number) || (codeOf(left.unitId) < codeOf(right.unitId) ? -1 : codeOf(left.unitId) > codeOf(right.unitId) ? 1 : 0));
  ranked.forEach((row, index) => {
    row.rank = index + 1;
  });
  return [...ranked, ...rows.filter((row) => row.delta === null).sort((left, right) => (codeOf(left.unitId) < codeOf(right.unitId) ? -1 : 1))];
}
