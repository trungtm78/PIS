import { flag, isRecord, list, nullableNumber, nullableText, text, toInfo } from './common';
import type { AnaInfo } from './common';

export const HEAT_PATH = '/bi/bi-29';
export const BACKTEST_PATH = '/bi/bi-30';
export const HEAT_VIEWS = ['UNIT_FUND', 'CONTRACTOR_UNIT', 'CONTRACTOR_FUND'] as const;
export type HeatView = (typeof HEAT_VIEWS)[number];
export type Band = 'GREEN' | 'AMBER' | 'RED';

export interface Label {
  key: string;
  code: string | null;
  label: string;
  none: boolean;
}
export interface Cell {
  rowKey: string;
  colKey: string;
  numeratorVnd: string | null;
  denominatorVnd: string | null;
  count: number | null;
  ratePct: string | null;
  band: Band | null;
  nullReason: string | null;
}
export interface Total {
  key: string;
  label: string | null;
  numeratorVnd: string | null;
  denominatorVnd: string;
  ratePct: string | null;
  cells: number;
  hidden: number;
}
export interface Heatmap {
  view: HeatView;
  snapshotId: string | null;
  asOfDate: string | null;
  pacePct: number | null;
  certificationGate: string | null;
  nullReason: string | null;
  params: { greenRatio: number; amberRatio: number; minCellCount: number; ctrGreenPct: number; ctrAmberPct: number };
  info: AnaInfo | undefined;
  rows: Label[];
  cols: Label[];
  cells: Cell[];
  rowTotals: Total[];
  colTotals: Total[];
  hiddenCells: number;
}
export interface Candidate {
  threshold: number;
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
  meanLeadWeeks: string | null;
  missedUnits: number;
  warnedEarlyUnits: number;
  nullReason: string | null;
}
export interface Backtest {
  asOfDate: string | null;
  nullReason: string | null;
  horizonWeeks: number;
  weeksEvaluated: number;
  unitsEvaluated: number;
  pairs: number;
  positives: number;
  minPairs: number;
  lines: { amberFrom: number; redFrom: number; unverified: boolean };
  info: AnaInfo | undefined;
  candidates: Candidate[];
}
export interface TrendUnit {
  unitId: string;
  code: string;
  name: string;
  rank: number | null;
  delta: number | null;
  direction: 'IMPROVING' | 'WORSENING' | 'STEADY' | null;
  scoreNow: number | null;
  scoreBefore: number | null;
  nullReason: string | null;
  series: Array<number | null>;
}
export interface Trend {
  asOfDate: string | null;
  weekStart: string | null;
  nullReason: string | null;
  trendWeeks: number;
  top: number;
  info: AnaInfo | undefined;
  improving: TrendUnit[];
  worsening: TrendUnit[];
  units: TrendUnit[];
}

const bandOf = (raw: unknown): Band | null => (raw === 'GREEN' || raw === 'AMBER' || raw === 'RED' ? raw : null);
const labelOf = (raw: unknown): Label[] => list(raw).flatMap((one) => (isRecord(one) && text(one.key) !== '' ? [{ key: text(one.key), code: nullableText(one.code), label: text(one.label), none: one.none === true }] : []));
const totalOf = (raw: unknown): Total[] => list(raw).flatMap((one) => (isRecord(one) && text(one.key) !== '' ? [{ key: text(one.key), label: nullableText(one.label), numeratorVnd: nullableText(one.numerator_vnd), denominatorVnd: text(one.denominator_vnd), ratePct: nullableText(one.rate_pct), cells: nullableNumber(one.cells) ?? 0, hidden: nullableNumber(one.hidden) ?? 0 }] : []));

export function toHeatmap(raw: unknown): Heatmap | undefined {
  if (!isRecord(raw) || !isRecord(raw.params) || !Array.isArray(raw.cells)) return undefined;
  const view = HEAT_VIEWS.find((one) => one === raw.view);
  if (view === undefined) return undefined;
  return {
    view,
    snapshotId: nullableText(raw.snapshot_id),
    asOfDate: nullableText(raw.as_of_date),
    pacePct: nullableNumber(raw.pace_pct),
    certificationGate: nullableText(raw.certification_gate),
    nullReason: nullableText(raw.null_reason),
    params: { greenRatio: nullableNumber(raw.params.green_ratio) ?? 0, amberRatio: nullableNumber(raw.params.amber_ratio) ?? 0, minCellCount: nullableNumber(raw.params.min_cell_count) ?? 0, ctrGreenPct: nullableNumber(raw.params.ctr_green_pct) ?? 0, ctrAmberPct: nullableNumber(raw.params.ctr_amber_pct) ?? 0 },
    info: toInfo(raw.info),
    rows: labelOf(raw.rows),
    cols: labelOf(raw.cols),
    cells: raw.cells.flatMap((one) =>
      isRecord(one) && text(one.row_key) !== '' ? [{ rowKey: text(one.row_key), colKey: text(one.col_key), numeratorVnd: nullableText(one.numerator_vnd), denominatorVnd: nullableText(one.denominator_vnd), count: nullableNumber(one.count), ratePct: nullableText(one.rate_pct), band: bandOf(one.band), nullReason: nullableText(one.null_reason) }] : [],
    ),
    rowTotals: totalOf(raw.row_totals),
    colTotals: totalOf(raw.col_totals),
    hiddenCells: nullableNumber(raw.hidden_cells) ?? 0,
  };
}

export function toBacktest(raw: unknown): Backtest | undefined {
  if (!isRecord(raw) || !isRecord(raw.lines) || !Array.isArray(raw.candidates)) return undefined;
  return {
    asOfDate: nullableText(raw.as_of_date),
    nullReason: nullableText(raw.null_reason),
    horizonWeeks: nullableNumber(raw.horizon_weeks) ?? 0,
    weeksEvaluated: nullableNumber(raw.weeks_evaluated) ?? 0,
    unitsEvaluated: nullableNumber(raw.units_evaluated) ?? 0,
    pairs: nullableNumber(raw.pairs) ?? 0,
    positives: nullableNumber(raw.positives) ?? 0,
    minPairs: nullableNumber(raw.min_pairs) ?? 0,
    lines: { amberFrom: nullableNumber(raw.lines.amber_from) ?? 0, redFrom: nullableNumber(raw.lines.red_from) ?? 0, unverified: flag(raw.lines.score_unverified) === true },
    info: toInfo(raw.info),
    candidates: raw.candidates.flatMap((one) =>
      isRecord(one) && (one.line === 'AMBER' || one.line === 'RED')
        ? [
            {
              threshold: nullableNumber(one.threshold) ?? 0,
              isCurrent: one.is_current === true,
              shift: nullableNumber(one.shift) ?? 0,
              line: one.line,
              pairs: nullableNumber(one.pairs) ?? 0,
              tp: nullableNumber(one.tp) ?? 0,
              fp: nullableNumber(one.fp) ?? 0,
              fn: nullableNumber(one.fn) ?? 0,
              tn: nullableNumber(one.tn) ?? 0,
              precisionPct: nullableText(one.precision_pct),
              recallPct: nullableText(one.recall_pct),
              meanLeadWeeks: nullableText(one.mean_lead_weeks),
              missedUnits: nullableNumber(one.missed_units) ?? 0,
              warnedEarlyUnits: nullableNumber(one.warned_early_units) ?? 0,
              nullReason: nullableText(one.null_reason),
            },
          ]
        : [],
    ),
  };
}

const trendUnits = (raw: unknown): TrendUnit[] =>
  list(raw).flatMap((one) =>
    isRecord(one) && text(one.unit_id) !== ''
      ? [
          {
            unitId: text(one.unit_id),
            code: text(one.code),
            name: text(one.name),
            rank: nullableNumber(one.rank),
            delta: nullableNumber(one.delta),
            direction: one.direction === 'IMPROVING' || one.direction === 'WORSENING' || one.direction === 'STEADY' ? one.direction : null,
            scoreNow: nullableNumber(one.score_now),
            scoreBefore: nullableNumber(one.score_before),
            nullReason: nullableText(one.null_reason),
            series: list(one.series).map((value) => nullableNumber(value)),
          },
        ]
      : [],
  );

export function toTrend(raw: unknown): Trend | undefined {
  if (!isRecord(raw) || !Array.isArray(raw.units)) return undefined;
  return {
    asOfDate: nullableText(raw.as_of_date),
    weekStart: nullableText(raw.week_start),
    nullReason: nullableText(raw.null_reason),
    trendWeeks: nullableNumber(raw.trend_weeks) ?? 0,
    top: nullableNumber(raw.top) ?? 0,
    info: toInfo(raw.info),
    improving: trendUnits(raw.improving),
    worsening: trendUnits(raw.worsening),
    units: trendUnits(raw.units),
  };
}
