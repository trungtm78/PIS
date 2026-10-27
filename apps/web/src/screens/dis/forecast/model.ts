import { ApiError } from '@machvon/api-client';

export const READ_PERMISSION = 'disbursement.read';

type Raw = Record<string, unknown>;
const asRecord = (value: unknown): Raw | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Raw) : undefined);
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const nullableText = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const MONEY = /^-?[0-9]+$/;
const nullableMoney = (value: unknown): string | null => (typeof value === 'string' && MONEY.test(value) ? value : null);

export const SOURCES = ['FORECAST', 'REGISTERED', 'MISSING', 'MIXED'] as const;
export type Source = (typeof SOURCES)[number];
export const COVERAGES = ['COMPLETE', 'PARTIAL', 'NONE'] as const;
export type Coverage = (typeof COVERAGES)[number];

export interface EstimatedMonth {
  month: number;
  amountVnd: string | null;
  source: Source;
}

export interface Estimate {
  disbursedVnd: string | null;
  planTotalVnd: string;
  months: EstimatedMonth[];
  eacVnd: string | null;
  gapVnd: string | null;
  ratioPct: string | null;
  coverage: Coverage;
  reallocationCandidate: boolean | null;
  method: string;
}

export interface ProjectEstimate extends Estimate {
  projectId: string;
  projectCode: string;
  projectName: string;
}

export interface CurvePoint {
  month: number;
  actualVnd: string | null;
  forecastVnd: string | null;
}

export interface Forecast extends Estimate {
  snapshotId: string;
  asOfDate: string;
  cutoffDate: string;
  planYear: number;
  cutoffMonth: number;
  definition: 'PROPOSED_PENDING_SIGNOFF' | 'SIGNED';
  thresholdPct: number;
  curve: CurvePoint[];
  projects: ProjectEstimate[];
  nextCursor: string | undefined;
}

function estimateOf(row: Raw): Estimate | undefined {
  const plan = nullableMoney(row.plan_total_vnd);
  const coverage = COVERAGES.find((candidate) => candidate === row.coverage);
  if (plan === null || coverage === undefined) return undefined;
  const months = (Array.isArray(row.months) ? row.months : []).flatMap((item): EstimatedMonth[] => {
    const month = asRecord(item);
    const source = SOURCES.find((candidate) => candidate === month?.source);
    return month === undefined || typeof month.month !== 'number' || source === undefined ? [] : [{ month: month.month, amountVnd: nullableMoney(month.amount_vnd), source }];
  });
  return {
    disbursedVnd: nullableMoney(row.disbursed_vnd),
    planTotalVnd: plan,
    months,
    eacVnd: nullableMoney(row.eac_vnd),
    gapVnd: nullableMoney(row.gap_vnd),
    ratioPct: nullableText(row.ratio_pct),
    coverage,
    reallocationCandidate: typeof row.reallocation_candidate === 'boolean' ? row.reallocation_candidate : null,
    method: text(row.method) ?? '',
  };
}

export function toForecast(raw: unknown): Forecast | undefined {
  const row = asRecord(raw);
  const total = row === undefined ? undefined : estimateOf(row);
  const snapshotId = text(row?.snapshot_id);
  const cutoffDate = text(row?.treasury_cutoff_date);
  const definition = row?.definition_status === 'SIGNED' ? 'SIGNED' : row?.definition_status === 'PROPOSED_PENDING_SIGNOFF' ? 'PROPOSED_PENDING_SIGNOFF' : undefined;
  if (row === undefined || total === undefined || snapshotId === undefined || cutoffDate === undefined || definition === undefined || typeof row.cutoff_month !== 'number' || typeof row.plan_year !== 'number') return undefined;
  const curve = (Array.isArray(row.curve) ? row.curve : []).flatMap((item): CurvePoint[] => {
    const point = asRecord(item);
    return point === undefined || typeof point.month !== 'number' ? [] : [{ month: point.month, actualVnd: nullableMoney(point.actual_cumulative_vnd), forecastVnd: nullableMoney(point.forecast_cumulative_vnd) }];
  });
  const projects = (Array.isArray(row.projects) ? row.projects : []).flatMap((item): ProjectEstimate[] => {
    const entry = asRecord(item);
    const project = asRecord(entry?.project);
    const estimate = entry === undefined ? undefined : estimateOf(entry);
    const id = text(project?.id);
    return estimate === undefined || id === undefined ? [] : [{ ...estimate, projectId: id, projectCode: text(project?.code) ?? '', projectName: text(project?.name) ?? '' }];
  });
  return {
    ...total,
    snapshotId,
    asOfDate: text(row.as_of_date) ?? '',
    cutoffDate,
    planYear: row.plan_year,
    cutoffMonth: row.cutoff_month,
    definition,
    thresholdPct: typeof row.reallocation_threshold_pct === 'number' ? row.reallocation_threshold_pct : 80,
    curve,
    projects,
    nextCursor: text(row.next_cursor),
  };
}

export interface Geometry {
  width: number;
  height: number;
  actual: string;
  forecast: string;
  plan: { y: number; vnd: string };
  actualPoints: Array<{ x: number; y: number; month: number }>;
  forecastPoints: Array<{ x: number; y: number; month: number }>;
  xTicks: Array<{ x: number; month: number }>;
  yTicks: Array<{ y: number; vnd: string }>;
}

export const CHART = { width: 640, height: 280, left: 72, right: 16, top: 16, bottom: 32 } as const;

/**
 * The geometry of the chart from the numbers of the table, so that the picture and the table cannot disagree: the months along the bottom, the cumulative amount up the side, from zero (or the lowest point, when a refund took the net below it) to the greater of the plan and
 * the highest point. Whole dong are scaled to a float only to be drawn; the numbers that are shown are the strings of the table.
 */
export function chartGeometry(curve: readonly CurvePoint[], planTotalVnd: string): Geometry {
  const months = curve.map((point) => point.month);
  const first = months.length === 0 ? 1 : Math.min(...months);
  const last = months.length === 0 ? 12 : Math.max(...months);
  const values = [Number(planTotalVnd), ...curve.flatMap((point) => [point.actualVnd, point.forecastVnd]).filter((value): value is string => value !== null).map(Number)];
  const top = Math.max(1, ...values);
  const bottom = Math.min(0, ...values);
  const plotWidth = CHART.width - CHART.left - CHART.right;
  const plotHeight = CHART.height - CHART.top - CHART.bottom;
  const x = (month: number): number => CHART.left + (last === first ? 0 : ((month - first) / (last - first)) * plotWidth);
  const y = (vnd: number): number => CHART.top + plotHeight - ((vnd - bottom) / (top - bottom)) * plotHeight;
  const points = (pick: (point: CurvePoint) => string | null): Array<{ x: number; y: number; month: number }> => curve.flatMap((point) => (pick(point) === null ? [] : [{ x: x(point.month), y: y(Number(pick(point))), month: point.month }]));
  // A line is drawn through months that follow each other and stops where a month is not known.
  const pathOf = (pick: (point: CurvePoint) => string | null): string => {
    let path = '';
    let previous: number | undefined;
    for (const point of curve) {
      if (pick(point) === null) {
        previous = undefined;
        continue;
      }
      path += `${previous === undefined ? 'M' : 'L'}${x(point.month).toFixed(1)} ${y(Number(pick(point))).toFixed(1)} `;
      previous = point.month;
    }
    return path.trim();
  };
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((share) => Math.round(bottom + (top - bottom) * share));
  return {
    width: CHART.width,
    height: CHART.height,
    actual: pathOf((point) => point.actualVnd),
    forecast: pathOf((point) => point.forecastVnd),
    plan: { y: y(Number(planTotalVnd)), vnd: planTotalVnd },
    actualPoints: points((point) => point.actualVnd),
    forecastPoints: points((point) => point.forecastVnd),
    xTicks: curve.map((point) => ({ x: x(point.month), month: point.month })),
    yTicks: ticks.map((vnd) => ({ y: y(vnd), vnd: String(vnd) })),
  };
}

export type ForecastProblem = 'notFound' | 'notFrozen' | 'validation' | 'general';
const PROBLEM_BY_CODE: Readonly<Record<string, ForecastProblem>> = { RESOURCE_NOT_FOUND: 'notFound', SNAPSHOT_NOT_FROZEN: 'notFrozen', VALIDATION_FAILED: 'validation', INVALID_REQUEST: 'validation' };
export const describeForecast = (error: unknown): ForecastProblem => (error instanceof ApiError ? (PROBLEM_BY_CODE[error.code] ?? 'general') : 'general');
