import { ApiError } from '@machvon/api-client';
import { badgeOf } from './dataset-model';
import type { Badge } from './dataset-model';

export const QUERY_PERMISSION = 'bi.query';
export const WORKBENCH_PATH = '/bi/bi-09';
export const BOARD_PATH = '/bi/bi-02';

/** The dimensions of the disbursement dataset, in the order the screen offers them. */
export const DIMENSIONS = ['unit', 'fund_source', 'project', 'budget_level', 'bucket'] as const;
export type Dimension = (typeof DIMENSIONS)[number];

type Raw = Record<string, unknown>;
const asRecord = (value: unknown): Raw | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Raw) : undefined);
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const nullable = (value: unknown): string | null => (typeof value === 'string' ? value : null);

export type NullReason = 'NO_DATA' | 'NOT_APPLICABLE';

export interface Figure {
  value: string | null;
  numerator: string | null;
  denominator: string | null;
  nullReason: NullReason | null;
}

export interface Group extends Figure {
  key: string | null;
  label: string;
  unclassified: boolean;
  drillToken: string | null;
}

export interface QueryResult {
  metricId: string;
  metricCode: string;
  unit: string;
  aggregationType: string;
  asOfPeriod: string;
  snapshotId: string;
  badge: Badge;
  excludedQuarantineRows: number;
  feedsCertified: boolean;
  newDataAvailable: boolean;
  scopeLabel: 'YOUR_SCOPE' | 'FULL_TENANT';
  servedFromCache: boolean;
  builtAt: string;
  dimension: string | null;
  total: Figure;
  reconcilesToParent: boolean;
  nonAdditiveReason: string | null;
  truncated: boolean;
  children: Group[];
  drillToken: string;
}

const reasonOf = (value: unknown): NullReason | null => (value === 'NO_DATA' || value === 'NOT_APPLICABLE' ? value : null);

function figureOf(raw: unknown): Figure | undefined {
  const row = asRecord(raw);
  if (row === undefined) return undefined;
  return { value: nullable(row.value), numerator: nullable(row.numerator), denominator: nullable(row.denominator), nullReason: reasonOf(row.null_reason) };
}

/** The answer of a query or of a drill as the screens read it; an answer that lacks what they need is not drawn, never guessed. */
export function toQueryResult(raw: unknown): QueryResult | undefined {
  const row = asRecord(raw);
  const metric = asRecord(row?.metric);
  const total = figureOf(row?.total);
  const scope = asRecord(row?.scope);
  const badge = badgeOf(text(row?.quality_badge));
  const children = Array.isArray(row?.children) ? row.children : undefined;
  if (row === undefined || metric === undefined || total === undefined || badge === undefined || children === undefined) return undefined;
  const asOf = text(row.as_of_period);
  const snapshot = text(row.snapshot_id);
  const token = text(row.drill_token);
  const metricId = text(metric.id);
  if (asOf === undefined || snapshot === undefined || token === undefined || metricId === undefined) return undefined;
  const groups: Group[] = [];
  for (const item of children) {
    const group = asRecord(item);
    const figure = figureOf(item);
    if (group === undefined || figure === undefined) return undefined;
    const key = nullable(group.key);
    groups.push({ ...figure, key, label: text(group.label) ?? key ?? '', unclassified: group.unclassified === true, drillToken: nullable(group.drill_token) });
  }
  return {
    metricId,
    metricCode: text(metric.code) ?? '',
    unit: text(metric.unit) ?? '',
    aggregationType: text(metric.aggregation_type) ?? '',
    asOfPeriod: asOf,
    snapshotId: snapshot,
    badge,
    excludedQuarantineRows: typeof row.excluded_quarantine_rows === 'number' ? row.excluded_quarantine_rows : 0,
    feedsCertified: row.feeds_certified !== false,
    newDataAvailable: row.new_data_available === true,
    scopeLabel: scope?.label === 'FULL_TENANT' ? 'FULL_TENANT' : 'YOUR_SCOPE',
    servedFromCache: row.served_from_cache === true,
    builtAt: text(row.built_at) ?? '',
    dimension: nullable(row.dimension),
    total,
    reconcilesToParent: row.reconciles_to_parent !== false,
    nonAdditiveReason: nullable(row.non_additive_reason),
    truncated: row.truncated === true,
    children: groups,
    drillToken: token,
  };
}

const grouped = (digits: string, locale: string): string => new Intl.NumberFormat(locale).format(BigInt(digits));

/** A figure as it is written: money in dong, a ratio in percent, a count as a number; no figure is "no data" (or "not applicable"), never 0. */
export function formatFigure(figure: Figure, unit: string, locale: string, words: { noData: string; notApplicable: string }): string {
  if (figure.value === null) return figure.nullReason === 'NOT_APPLICABLE' ? words.notApplicable : words.noData;
  if (unit === 'percent') return `${new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(figure.value))}%`;
  return /^-?\d+$/.test(figure.value) ? (unit === 'VND' ? `${grouped(figure.value, locale)} ₫` : grouped(figure.value, locale)) : figure.value;
}

/** What the chain of a drill is: the dimensions gone down through, from the first query. */
export interface Step {
  dimension: string;
  /** The label of the group the next step started from; none for the first. */
  from: string | null;
}

export type QueryReason = 'policy' | 'dimension' | 'metric' | 'snapshot' | 'scope' | 'token' | 'expired' | 'invalid' | 'session' | 'general';
const REASON_BY_CODE: Readonly<Record<string, QueryReason>> = {
  ACCESS_POLICY_MISSING: 'policy',
  DIMENSION_NOT_IN_DATASET: 'dimension',
  METRIC_NOT_CERTIFIED: 'metric',
  SNAPSHOT_NOT_FOUND: 'snapshot',
  SCOPE_DENIED: 'scope',
  DRILL_TOKEN_INVALID: 'token',
  SNAPSHOT_EXPIRED: 'expired',
  VALIDATION_FAILED: 'invalid',
  FIELD_NOT_ALLOWED: 'invalid',
  INVALID_REQUEST: 'invalid',
  SESSION_EXPIRED: 'session',
};

export function describeQueryProblem(error: unknown): { reason: QueryReason; field: string } {
  if (!(error instanceof ApiError)) return { reason: 'general', field: '' };
  return { reason: REASON_BY_CODE[error.code] ?? 'general', field: error.detail ?? '' };
}
