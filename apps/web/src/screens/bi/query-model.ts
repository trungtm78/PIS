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
  if (unit === 'index') return new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(figure.value));
  if (unit === 'percent') return `${new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(figure.value))}%`;
  return /^-?\d+$/.test(figure.value) ? (unit === 'VND' ? `${grouped(figure.value, locale)} ₫` : grouped(figure.value, locale)) : figure.value;
}

/** What the chain of a drill is: the dimensions gone down through, from the first query. */
export interface Step {
  dimension: string;
  /** The label of the group the next step started from; none for the first. */
  from: string | null;
}

export type QueryReason = 'running' | 'changed' | 'timeout' | 'policy' | 'dimension' | 'metric' | 'snapshot' | 'scope' | 'token' | 'expired' | 'invalid' | 'session' | 'general';
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

/** The question was too heavy for the request and became a job (202); this is the run that answers it. */
export interface QueuedQuery {
  runId: string;
}

/** The answer of a query that became a job: 202 ASYNC_JOB with the run of the log, and nothing of the figures. */
export function toQueuedQuery(raw: unknown): QueuedQuery | undefined {
  const row = asRecord(raw);
  return row !== undefined && row.status === 'ASYNC_JOB' && typeof row.run_id === 'string' ? { runId: row.run_id } : undefined;
}

/** How often the run of a job is looked at, and how many times (five minutes in all). */
export const JOB_WAIT = { intervalMs: 5000, attempts: 60 } as const;

/** How a run of the log stands, as the server tells the person who asked it: waiting, running or how it ended (and the code of what went wrong). Nothing of the figures. */
export interface RunState {
  status: string;
  errorCode: string | null;
}

export function toRunState(raw: unknown): RunState | undefined {
  const row = asRecord(raw);
  return row !== undefined && typeof row.status === 'string' ? { status: row.status, errorCode: typeof row.error_code === 'string' ? row.error_code : null } : undefined;
}

/** The job did not end in the time the screen waits: it goes on in the background and the same question gets its answer when it has. */
export class QueryStillRunning extends Error {
  constructor(readonly runId: string) {
    super('the query is still running as a job');
  }
}

/** The job ended without an answer (it was refused, it failed, the database stopped it): the question is not asked again for it. */
export class QueryJobEnded extends Error {
  constructor(
    readonly status: string,
    readonly code: string | null,
  ) {
    super(`the query job ended ${status}`);
  }
}

/** The screen or the session the question was asked for is gone: nothing more is asked in its name. */
export class QueryCancelled extends Error {
  constructor() {
    super('the query was cancelled');
  }
}

/** What waits for a job: how to look at its run, whether the question is still wanted, and how often to look. */
export interface JobWatch {
  poll(runId: string): Promise<unknown>;
  /** The screen is gone, or the member or tenant is another: checked before each request. */
  cancelled(): boolean;
  intervalMs: number;
  attempts: number;
  waitBetweenPolls?: (ms: number) => Promise<void>;
}

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const OPEN_RUN: readonly string[] = ['QUEUED', 'RUNNING'];

/**
 * Asks a question and, when the server makes a job of it (it is too heavy to wait for), looks at the run of the job until it has ended: while it waits or runs the screen waits; when it completed the same question is asked
 * again and is answered from what the job kept; when it ended any other way the reason is given (QueryJobEnded) and no other job is made for it. A job that has not ended in the time given is QueryStillRunning. Nothing is asked
 * once the question is not wanted any more (QueryCancelled): the screen was left, or the member or the tenant changed.
 */
export async function resolveQuery(ask: () => Promise<unknown>, watch: JobWatch): Promise<QueryResult | undefined> {
  const waitBetweenPolls = watch.waitBetweenPolls ?? pause;
  let raw = await ask();
  let queued = toQueuedQuery(raw);
  if (queued === undefined) return toQueryResult(raw);
  for (let attempt = 0; attempt < watch.attempts; attempt += 1) {
    await waitBetweenPolls(watch.intervalMs);
    if (watch.cancelled()) throw new QueryCancelled();
    const state = toRunState(await watch.poll(queued.runId));
    if (state === undefined) throw new Error('the run could not be read');
    if (OPEN_RUN.includes(state.status)) continue;
    if (state.status !== 'COMPLETED') throw new QueryJobEnded(state.status, state.errorCode);
    if (watch.cancelled()) throw new QueryCancelled();
    raw = await ask();
    queued = toQueuedQuery(raw);
    // The answer a job kept may be gone again by the time it is asked for (its hour, a scope that moved): the question is then a job of its own and is waited for in its turn.
    if (queued === undefined) return toQueryResult(raw);
  }
  throw new QueryStillRunning(queued.runId);
}

export function describeQueryProblem(error: unknown): { reason: QueryReason; field: string } {
  if (error instanceof QueryStillRunning) return { reason: 'running', field: '' };
  if (error instanceof QueryJobEnded)
    return { reason: error.status === 'TIMEOUT' ? 'timeout' : error.code === 'SCOPE_CHANGED' ? 'changed' : (REASON_BY_CODE[error.code ?? ''] ?? 'general'), field: '' };
  if (!(error instanceof ApiError)) return { reason: 'general', field: '' };
  return { reason: REASON_BY_CODE[error.code] ?? 'general', field: error.detail ?? '' };
}
