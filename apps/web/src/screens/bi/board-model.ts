import type { Metric } from './bi-model';
import type { Dataset } from './dataset-model';
import type { Dashboard, DashboardVersion } from './dashboard-model';

export const BOARD_PATH = '/bi/bi-02';
/** The query parameter that names the dashboard the board is read as. */
export const BOARD_DASHBOARD_PARAM = 'dashboard';

/**
 * The dashboards a board can be tied to: those with a published version. A draft-only (or archived) dashboard has no version that anybody published, so it has nothing to sign off and is not offered (BC.02).
 */
export function boardDashboards(dashboards: readonly Dashboard[]): Dashboard[] {
  return dashboards.filter((dashboard) => dashboard.status === 'PUBLISHED');
}

/**
 * The version a board shows and signs: the published one, the newest if the data ever held more than one. The current version of a dashboard is not it, since a later save makes a draft the current one while the published version stays
 * the one that was approved.
 */
export function publishedVersionOf(dashboard: Pick<Dashboard, 'versions'>): DashboardVersion | undefined {
  return dashboard.versions.filter((version) => version.status === 'PUBLISHED').sort((left, right) => right.revision - left.revision)[0];
}

/** The certified metrics of a version in the order the version names them; a metric that was withdrawn or is unknown to the caller is left out, never shown as a figure. */
export function boardMetricsOf(version: Pick<DashboardVersion, 'metricVersionIds'>, metrics: readonly Metric[]): Metric[] {
  const byId = new Map(metrics.map((metric) => [metric.id, metric]));
  return [...new Set(version.metricVersionIds)].flatMap((id) => {
    const metric = byId.get(id);
    return metric !== undefined && metric.status === 'CERTIFIED' ? [metric] : [];
  });
}

/**
 * Whether a metric belongs to the dataset whose snapshot the board reads. A metric that names its dataset belongs to that one; a metric of the platform (it names none) belongs to the dataset of its own grain.
 * The API refuses a metric over the snapshot of a dataset that is not its own (422 VALIDATION_FAILED), so the board does not ask: 27 of the 28 certified metrics of the public demo are of other datasets (contracts,
 * enterprise classes, project EVM). With no dataset to judge by, the server decides.
 */
export function readsDataset(metric: Pick<Metric, 'datasetId' | 'grain'>, dataset: Pick<Dataset, 'id' | 'grain'> | undefined): boolean {
  if (dataset === undefined) return true;
  return metric.datasetId === null ? metric.grain === dataset.grain : metric.datasetId === dataset.id;
}

/** The snapshot a version can be read at when it pins its dataset versions: frozen, or since superseded by a newer build (the query store serves both). */
const READABLE = ['FROZEN', 'SUPERSEDED'];

/** The datasets the metrics of a board read: the dataset a metric names, else the default one of the board (the first dataset of period snapshots); each once, in the order of the metrics. */
export function datasetIdsOf(metrics: readonly Pick<Metric, 'datasetId'>[], fallback: string | undefined): string[] {
  return [...new Set(metrics.flatMap((metric) => metric.datasetId ?? fallback ?? []))];
}

/**
 * The snapshot a metric of a signed board is read at. A published version that pins its dataset versions (PINNED) was approved on those figures, so each metric is read at the pinned version of its own dataset, frozen or since
 * superseded: a signature never goes with a newer snapshot, a snapshot that a newer build superseded does not take the figures away from the board that was approved on it, and a metric whose dataset has no pinned version here has
 * no figure (undefined), never one from another snapshot.
 */
export function pinnedSnapshotOf<T extends { id: string; datasetId: string; status: string }>(
  metric: Pick<Metric, 'datasetId'>,
  fallback: string | undefined,
  pinnedIds: readonly string[],
  versions: readonly T[],
): T | undefined {
  const datasetId = metric.datasetId ?? fallback;
  return versions.find((one) => one.datasetId === datasetId && pinnedIds.includes(one.id) && READABLE.includes(one.status));
}
