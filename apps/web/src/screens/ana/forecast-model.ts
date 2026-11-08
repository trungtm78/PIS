import { flag, isRecord, list, nullableNumber, nullableText, text, toInfo } from './common';
import type { AnaInfo } from './common';

export interface Band {
  lowVnd: string;
  centralVnd: string;
  highVnd: string;
}
export interface BandRatios {
  low: string | null;
  central: string | null;
  high: string | null;
}
export interface Needed {
  status: 'NEEDED' | 'REACHED' | 'NA';
  nullReason: string | null;
  remainingVnd: string | null;
  perWeekVnd: string | null;
  speedVnd: string | null;
  multiple: string | null;
  multipleNullReason: string | null;
}
export interface WindowRow {
  weeks: number;
  startDate: string;
  weeklySpeedVnd: string;
  linearYearEndVnd: string;
  seasonalYearEndVnd: string | null;
  seasonalNullReason: string | null;
}
export interface OutlookView {
  nullReason: string | null;
  asOfDate: string | null;
  planYearEnd: string;
  cumulativeVnd: string | null;
  planTotalVnd: string | null;
  remainingDays: number | null;
  projects: number;
  windows: WindowRow[];
  skipped: Array<{ weeks: number; reason: string }>;
  linear: Band | null;
  linearRatioPct: BandRatios | null;
  seasonal: Band | null;
  seasonalRatioPct: BandRatios | null;
  seasonalNullReason: string | null;
  gapVnd: string | null;
  attention: boolean | null;
  needed: Needed;
}
export interface SeriesPoint {
  asOfDate: string;
  cumulativeVnd: string;
}
export interface FundOutlook {
  fundSourceVersionId: string | null;
  code: string | null;
  label: string | null;
  outlook: OutlookView;
}
export interface OutlookReading {
  year: number | null;
  asOfDate: string | null;
  planBasis: 'PM' | 'TOTAL';
  breakdown: 'NONE' | 'FUND';
  nullReason: string | null;
  certificationGate: string | null;
  info: AnaInfo | undefined;
  model: { windowMinWeeks: number; windowMaxWeeks: number; central: string; seasonality: boolean; attentionBelowPct: number };
  whole: OutlookView | null;
  series: SeriesPoint[];
  priorSeries: SeriesPoint[];
  funds: FundOutlook[];
}

const toBand = (raw: unknown): Band | null => (isRecord(raw) && text(raw.central_vnd) !== '' ? { lowVnd: text(raw.low_vnd), centralVnd: text(raw.central_vnd), highVnd: text(raw.high_vnd) } : null);
const toRatios = (raw: unknown): BandRatios | null => (isRecord(raw) ? { low: nullableText(raw.low), central: nullableText(raw.central), high: nullableText(raw.high) } : null);
const toPoints = (raw: unknown): SeriesPoint[] => list(raw).flatMap((one) => (isRecord(one) && text(one.as_of_date) !== '' ? [{ asOfDate: text(one.as_of_date), cumulativeVnd: text(one.cumulative_vnd) }] : []));

function toNeeded(raw: unknown): Needed {
  const record = isRecord(raw) ? raw : {};
  const status = record.status === 'NEEDED' || record.status === 'REACHED' ? record.status : 'NA';
  return {
    status,
    nullReason: nullableText(record.null_reason),
    remainingVnd: nullableText(record.remaining_vnd),
    perWeekVnd: nullableText(record.per_week_vnd),
    speedVnd: nullableText(record.speed_vnd),
    multiple: nullableText(record.multiple),
    multipleNullReason: nullableText(record.multiple_null_reason),
  };
}

export function toOutlookView(raw: unknown): OutlookView | null {
  if (!isRecord(raw)) return null;
  return {
    nullReason: nullableText(raw.null_reason),
    asOfDate: nullableText(raw.as_of_date),
    planYearEnd: text(raw.plan_year_end),
    cumulativeVnd: nullableText(raw.cumulative_vnd),
    planTotalVnd: nullableText(raw.plan_total_vnd),
    remainingDays: nullableNumber(raw.remaining_days),
    projects: nullableNumber(raw.projects) ?? 0,
    windows: list(raw.windows).flatMap((one) =>
      isRecord(one) && typeof one.weeks === 'number'
        ? [{ weeks: one.weeks, startDate: text(one.start_date), weeklySpeedVnd: text(one.weekly_speed_vnd), linearYearEndVnd: text(one.linear_year_end_vnd), seasonalYearEndVnd: nullableText(one.seasonal_year_end_vnd), seasonalNullReason: nullableText(one.seasonal_null_reason) }]
        : [],
    ),
    skipped: list(raw.skipped).flatMap((one) => (isRecord(one) && typeof one.weeks === 'number' ? [{ weeks: one.weeks, reason: text(one.reason) }] : [])),
    linear: toBand(raw.linear),
    linearRatioPct: toRatios(raw.linear_ratio_pct),
    seasonal: toBand(raw.seasonal),
    seasonalRatioPct: toRatios(raw.seasonal_ratio_pct),
    seasonalNullReason: nullableText(raw.seasonal_null_reason),
    gapVnd: nullableText(raw.gap_vnd),
    attention: flag(raw.attention),
    needed: toNeeded(raw.needed),
  };
}

/** The outlook as the screen reads it, or undefined when the answer is not one. */
export function toOutlookReading(raw: unknown): OutlookReading | undefined {
  if (!isRecord(raw) || !isRecord(raw.model)) return undefined;
  const model = raw.model;
  return {
    year: nullableNumber(raw.year),
    asOfDate: nullableText(raw.as_of_date),
    planBasis: raw.plan_basis === 'TOTAL' ? 'TOTAL' : 'PM',
    breakdown: raw.breakdown === 'FUND' ? 'FUND' : 'NONE',
    nullReason: nullableText(raw.null_reason),
    certificationGate: nullableText(raw.certification_gate),
    info: toInfo(raw.info),
    model: { windowMinWeeks: nullableNumber(model.window_min_weeks) ?? 4, windowMaxWeeks: nullableNumber(model.window_max_weeks) ?? 8, central: text(model.central), seasonality: model.seasonality === true, attentionBelowPct: nullableNumber(model.attention_below_pct) ?? 0 },
    whole: toOutlookView(raw.whole),
    series: toPoints(raw.series),
    priorSeries: toPoints(raw.prior_series),
    funds: list(raw.funds).flatMap((one) => {
      const outlook = isRecord(one) ? toOutlookView(one.outlook) : null;
      return isRecord(one) && outlook !== null ? [{ fundSourceVersionId: nullableText(one.fund_source_version_id), code: nullableText(one.code), label: nullableText(one.label), outlook }] : [];
    }),
  };
}

/** The lines of the chart in thousand million dong: the actual cumulative, the three projections from the last actual day to the plan year end, and the plan. */
export interface ChartLine {
  key: 'actual' | 'low' | 'central' | 'high' | 'seasonal' | 'plan';
  points: Array<{ x: string; y: number }>;
}

export function chartLines(reading: OutlookReading): ChartLine[] {
  const whole = reading.whole;
  if (whole === null || reading.series.length === 0 || whole.asOfDate === null) return [];
  const billions = (value: string): number => Number(value) / 1_000_000_000;
  const last = reading.series[reading.series.length - 1] as SeriesPoint;
  const actual = reading.series.map((point) => ({ x: point.asOfDate, y: billions(point.cumulativeVnd) }));
  const lines: ChartLine[] = [{ key: 'actual', points: actual }];
  const ahead = (vnd: string): ChartLine['points'] => [
    { x: last.asOfDate, y: billions(last.cumulativeVnd) },
    { x: whole.planYearEnd, y: billions(vnd) },
  ];
  if (whole.linear !== null) {
    lines.push({ key: 'low', points: ahead(whole.linear.lowVnd) }, { key: 'central', points: ahead(whole.linear.centralVnd) }, { key: 'high', points: ahead(whole.linear.highVnd) });
  }
  if (whole.seasonal !== null) lines.push({ key: 'seasonal', points: ahead(whole.seasonal.centralVnd) });
  if (whole.planTotalVnd !== null) {
    const plan = billions(whole.planTotalVnd);
    const days = [...new Set([...actual.map((point) => point.x), whole.planYearEnd])];
    lines.push({ key: 'plan', points: days.map((x) => ({ x, y: plan })) });
  }
  return lines;
}

export const OUTLOOK_PERMISSION = 'home.read';
export const COMMAND_CENTER_PATH = '/home/home-09';
