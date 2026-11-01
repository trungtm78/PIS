import { RUN_STATUSES } from '../eval-model';
import type { RunStatus } from '../eval-model';
import { ROUTES } from '../llm-model';
import type { Route } from '../llm-model';

/** LLM-13: the evaluations of models set side by side (ST-LLM-009, LLM F4, UAT-AC459): the runs of one version of one dataset, route by route, with the metrics against the thresholds, the signature and the cost. */
export const RUN_READ_PERMISSION = 'ai_eval_run.read';
export const PROFILE_READ_PERMISSION = 'model_profile_version.read';
export const DATASET_READ_PERMISSION = 'llm.eval.read';

export type Bound = 'min' | 'max';
/** The four metrics of a run, with the side of the threshold on which a run passes (the server judges; this only says how the threshold reads). */
export const METRICS: ReadonlyArray<{ metric: string; bound: Bound }> = [
  { metric: 'citation_precision', bound: 'min' },
  { metric: 'unsupported_claim_rate', bound: 'max' },
  { metric: 'injection_resistance', bound: 'min' },
  { metric: 'schema_valid_rate', bound: 'min' },
];

export interface CompareRun {
  id: string;
  profileId: string;
  datasetId: string;
  route: Route;
  metrics: Record<string, number> | null;
  thresholds: Record<string, number> | null;
  passed: boolean | null;
  failures: string[];
  status: RunStatus;
  costVnd: string;
  startedAt: string | null;
  finishedAt: string | null;
  signedBy: string | null;
  signedAt: string | null;
  signatureComment: string | null;
}

const asRecord = (value: unknown): Record<string, unknown> | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined);
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const nullableText = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const oneOf = <T extends string>(list: readonly T[], value: unknown): T | undefined => list.find((entry) => entry === value);
const numbers = (value: unknown): Record<string, number> | null => {
  const row = asRecord(value);
  return row === undefined ? null : Object.fromEntries(Object.entries(row).filter((entry): entry is [string, number] => typeof entry[1] === 'number' && Number.isFinite(entry[1])));
};

/** A run as the register answers it; a row that does not have the shape is dropped rather than shown half-filled. */
export function toCompareRun(raw: unknown): CompareRun | undefined {
  const row = asRecord(raw);
  const id = text(row?.id);
  const profileId = text(row?.profile_version_id);
  const datasetId = text(row?.dataset_version_id);
  const route = oneOf(ROUTES, row?.route_class);
  const status = oneOf(RUN_STATUSES, row?.review_status);
  if (row === undefined || id === undefined || profileId === undefined || datasetId === undefined || route === undefined || status === undefined) return undefined;
  return {
    id,
    profileId,
    datasetId,
    route,
    metrics: numbers(row.metrics),
    thresholds: numbers(row.thresholds),
    passed: typeof row.passed === 'boolean' ? row.passed : null,
    failures: Array.isArray(row.failures) ? row.failures.filter((entry): entry is string => typeof entry === 'string') : [],
    status,
    costVnd: text(row.cost_vnd) ?? '0',
    startedAt: nullableText(row.started_at),
    finishedAt: nullableText(row.finished_at),
    signedBy: nullableText(row.signed_by),
    signedAt: nullableText(row.signed_at),
    signatureComment: nullableText(row.signature_comment),
  };
}

/** How long the run took, in whole seconds, once it has started and finished. */
export function durationSeconds(run: Pick<CompareRun, 'startedAt' | 'finishedAt'>): number | null {
  if (run.startedAt === null || run.finishedAt === null) return null;
  const span = Date.parse(run.finishedAt) - Date.parse(run.startedAt);
  return Number.isNaN(span) || span < 0 ? null : Math.round(span / 1000);
}

export interface RouteGroup {
  route: Route;
  runs: CompareRun[];
}

/** The runs on one dataset version that still stand (a run that was set aside is not compared), by route in the order of the routes, the latest finished first. */
export function groupByRoute(runs: readonly CompareRun[], datasetId: string): RouteGroup[] {
  return ROUTES.flatMap((route) => {
    const standing = runs.filter((run) => run.datasetId === datasetId && run.route === route && run.status !== 'SUPERSEDED');
    if (standing.length === 0) return [];
    return [{ route, runs: [...standing].sort((left, right) => (right.finishedAt ?? '').localeCompare(left.finishedAt ?? '') || left.id.localeCompare(right.id)) }];
  });
}

export interface MetricCell {
  value: number | null;
  threshold: number | null;
  failed: boolean;
}

/** A metric of a run with the threshold it was judged against; it failed when the run lists it among its failures. */
export function metricCell(run: Pick<CompareRun, 'metrics' | 'thresholds' | 'failures'>, metric: string, bound: Bound): MetricCell {
  return { value: run.metrics?.[metric] ?? null, threshold: run.thresholds?.[`${metric}_${bound}`] ?? null, failed: run.failures.includes(metric) };
}
