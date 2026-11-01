export const RUN_STATUSES = ['QUEUED', 'RUNNING', 'COMPLETED', 'DENIED', 'FAILED', 'TIMEOUT', 'CANCELLED'] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];
export const RUN_MODES = ['SYNC', 'ASYNC_JOB'] as const;
export type RunMode = (typeof RUN_MODES)[number];
export const LOG_PAGE_SIZE = 50;
/** The permission the log is read with (the administrator of BI). */
export const LOG_PERMISSION = 'bi.admin.read';

type Raw = Record<string, unknown>;
const isRecord = (value: unknown): value is Raw => typeof value === 'object' && value !== null && !Array.isArray(value);
const nullableNumber = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const nullableText = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/** A line of the log: how long a query took, what it cost and where it was answered from; the figures it answered are not in it, and neither is what it asked. */
export interface QueryRun {
  id: string;
  requestedBy: string;
  metricVersionIds: string[];
  asOfPeriod: string;
  mode: RunMode;
  status: RunStatus;
  servedFromCache: boolean;
  durationMs: number | null;
  rowCount: number | null;
  estimatedCost: number | null;
  errorCode: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface RunPage {
  items: QueryRun[];
  nextCursor: string | undefined;
}

export function toRun(raw: unknown): QueryRun | undefined {
  if (!isRecord(raw) || typeof raw.id !== 'string' || typeof raw.created_at !== 'string' || typeof raw.as_of_period !== 'string') return undefined;
  const status = RUN_STATUSES.find((candidate) => candidate === raw.status);
  const mode = RUN_MODES.find((candidate) => candidate === raw.mode);
  if (status === undefined || mode === undefined) return undefined;
  return {
    id: raw.id,
    requestedBy: typeof raw.requested_by === 'string' ? raw.requested_by : '',
    metricVersionIds: Array.isArray(raw.metric_version_ids) ? raw.metric_version_ids.filter((id): id is string => typeof id === 'string') : [],
    asOfPeriod: raw.as_of_period,
    mode,
    status,
    servedFromCache: raw.served_from_cache === true,
    durationMs: nullableNumber(raw.duration_ms),
    rowCount: nullableNumber(raw.row_count),
    estimatedCost: nullableNumber(raw.estimated_cost),
    errorCode: nullableText(raw.error_code),
    createdAt: raw.created_at,
    finishedAt: nullableText(raw.finished_at),
  };
}

/** A page of the log as the server gave it: a line that is not one is left out, and a cursor that is not text is none. */
export function toRunPage(raw: unknown): RunPage {
  const items = isRecord(raw) && Array.isArray(raw.items) ? raw.items.flatMap((item) => toRun(item) ?? []) : [];
  return { items, nextCursor: isRecord(raw) && typeof raw.next_cursor === 'string' ? raw.next_cursor : undefined };
}

/** What the administrator narrows the log by: a state, and a period (blank is all). */
export interface RunFilter {
  status: RunStatus | '';
  period: string;
}

export const EMPTY_RUN_FILTER: RunFilter = { status: '', period: '' };

/** The query of the read for a filter: only what is chosen is sent, and the period without its blanks. */
export function filterQuery(filter: RunFilter): Record<string, string> {
  const period = filter.period.trim();
  return { ...(filter.status === '' ? {} : { status: filter.status }), ...(period === '' ? {} : { as_of_period: period }) };
}

/** The value under which `share` of the durations lie (the nearest rank), or none when no run has ended with a duration. */
export function percentile(durations: readonly number[], share: number): number | undefined {
  if (durations.length === 0) return undefined;
  const sorted = [...durations].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(share * sorted.length) - 1))];
}

export interface RunSummary {
  runs: number;
  fromCache: number;
  jobs: number;
  p95Ms: number | undefined;
}

/** The runs on the screen in numbers: how many, how many from the cache, how many were jobs and the p95 of the durations of those that ended. */
export function summarise(runs: readonly QueryRun[]): RunSummary {
  return {
    runs: runs.length,
    fromCache: runs.filter((run) => run.servedFromCache).length,
    jobs: runs.filter((run) => run.mode === 'ASYNC_JOB').length,
    p95Ms: percentile(
      runs.flatMap((run) => (run.durationMs === null ? [] : [run.durationMs])),
      0.95,
    ),
  };
}
