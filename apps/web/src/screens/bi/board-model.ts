import type { Metric } from './bi-model';
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
 * The snapshots a board may be read at. A board that follows the latest data (not tied to a dashboard, or a published version with the policy LATEST_FROZEN) is read at a frozen snapshot. A version that pins its dataset versions
 * (PINNED) was signed on those figures, so it is read at the pinned ones only, frozen or since superseded by a newer build (the query store serves both): a signature never goes with a newer snapshot, and a pinned snapshot
 * that was superseded does not take the figures away from the board that was approved on it.
 */
export function snapshotsOf<T extends { id: string; status: string }>(versions: readonly T[], published: Pick<DashboardVersion, 'policy' | 'pinnedDatasetVersionIds'> | undefined): T[] {
  if (published === undefined || published.policy !== 'PINNED') return versions.filter((one) => one.status === 'FROZEN');
  return versions.filter((one) => published.pinnedDatasetVersionIds.includes(one.id) && (one.status === 'FROZEN' || one.status === 'SUPERSEDED'));
}
