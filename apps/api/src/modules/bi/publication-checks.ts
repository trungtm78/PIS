import { BiDashboardStore, BiMetricStore, BiPolicyStore, BiQueryStore } from '@machvon/db';
import type { DashboardRecord, DashboardVersionRecord, MetricRow, PolicyRow, TenantTx } from '@machvon/db';
import { DISBURSEMENT_ADAPTER, DomainError, datasetAdapterOf, failedCheck, measurePlanOf, reproductionChecks } from '@machvon/kernel';
import type { DatasetAdapter, MeasurePlan, MetricAggregation, PublicationCheck, PublicationKind } from '@machvon/kernel';

export type Subject =
  | { kind: 'METRIC'; metric: MetricRow }
  | { kind: 'DASHBOARD'; dashboard: DashboardRecord; version: DashboardVersionRecord }
  | { kind: 'ACCESS_POLICY'; policy: PolicyRow };

export interface Judged {
  subject: Subject;
  checks: PublicationCheck[];
}

/** The dimension a metric with none of its own is reconciled by: every dataset the platform builds has it. */
const DEFAULT_DIMENSION = 'unit';

/**
 * The checks a request to publish stands on (ST-BI-006, BI 3 F5), made when it is asked and made again when it is decided: a metric is rerun over the latest frozen version of its dataset (the formula computes, the rows are
 * the rows the snapshot says, the groups add up), a version of a dashboard names certified metrics and frozen versions only, a policy is a draft over a dataset that is open. A check that fails is the refusal, with its name.
 */
export class PublicationChecks {
  private readonly metrics = new BiMetricStore();
  private readonly queries = new BiQueryStore();
  private readonly dashboards = new BiDashboardStore();
  private readonly policies = new BiPolicyStore();

  async judge(tx: TenantTx, kind: PublicationKind, objectId: string): Promise<Judged> {
    switch (kind) {
      case 'METRIC':
        return this.metric(tx, objectId);
      case 'DASHBOARD':
        return this.dashboard(tx, objectId);
      case 'ACCESS_POLICY':
        return this.policy(tx, objectId);
    }
  }

  private async metric(tx: TenantTx, id: string): Promise<Judged> {
    const metric = await this.metrics.find(tx, id);
    if (metric === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    // The metrics of the platform are certified by the review of the repository; a revision that is certified, superseded or retired is not asked for again.
    if (metric.origin !== 'TENANT_UI' || (metric.status !== 'DRAFT' && metric.status !== 'IN_REVIEW')) throw new DomainError('STAGE_TRANSITION_DENIED', 409, 'status');
    // The fields and dimensions a metric may use are those of the dataset it is a metric of (the latest frozen version of that dataset is what it is rerun over); a metric of a dataset the engine does not read has none.
    const frozen = metric.datasetId === null ? undefined : await this.queries.latestFrozenOfDataset(tx, metric.datasetId);
    const adapter: DatasetAdapter = (frozen === undefined ? undefined : datasetAdapterOf(frozen.datasetCode)) ?? DISBURSEMENT_ADAPTER;
    let plan: MeasurePlan | undefined;
    try {
      plan = measurePlanOf({ aggregationType: metric.aggregationType as MetricAggregation, expressionAst: metric.expressionAst, numeratorAst: metric.numeratorAst, denominatorAst: metric.denominatorAst }, adapter);
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
    }
    const known = metric.dimensionCodes.filter((code) => Object.prototype.hasOwnProperty.call(adapter.dimensions, code));
    const reproduction = plan === undefined || frozen?.snapshotId == null ? undefined : await this.queries.reproduce(tx, frozen.snapshotId, plan, known.length > 0 ? known : [DEFAULT_DIMENSION], adapter);
    const checks = reproductionChecks(plan !== undefined, reproduction);
    const failed = failedCheck(checks);
    if (failed !== undefined) throw new DomainError('REPRODUCIBILITY_CHECK_FAILED', 422, failed.code, { extensions: { checks } });
    return { subject: { kind: 'METRIC', metric }, checks };
  }

  private async dashboard(tx: TenantTx, versionId: string): Promise<Judged> {
    const held = await this.dashboards.lockVersion(tx, versionId);
    if (held === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (held.version.status !== 'DRAFT' || held.dashboard.status === 'ARCHIVED') throw new DomainError('STAGE_TRANSITION_DENIED', 409, 'status');
    const ids = held.version.metricVersionIds;
    const found = new Map((await this.dashboards.metricChecks(tx, ids)).map((metric) => [metric.id, metric.status]));
    const uncertified = ids.filter((metric) => found.get(metric) !== 'CERTIFIED');
    if (uncertified.length > 0) throw new DomainError('METRIC_NOT_CERTIFIED', 422, 'metric_versions', { extensions: { metric_version_ids: uncertified } });
    const pinned = held.version.pinnedDatasetVersionIds;
    const versions = new Map((await this.dashboards.datasetVersionChecks(tx, pinned)).map((version) => [version.id, version.status]));
    const unfrozen = pinned.filter((version) => versions.get(version) !== 'FROZEN');
    if (unfrozen.length > 0) throw new DomainError('DATASET_VERSION_NOT_FROZEN', 422, 'pinned_dataset_version_ids', { extensions: { dataset_version_ids: unfrozen } });
    return {
      subject: { kind: 'DASHBOARD', dashboard: held.dashboard, version: held.version },
      checks: [
        { code: 'METRICS_CERTIFIED', passed: true },
        { code: 'DATASET_VERSIONS_FROZEN', passed: true },
      ],
    };
  }

  private async policy(tx: TenantTx, id: string): Promise<Judged> {
    const policy = await this.policies.find(tx, id);
    if (policy === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (policy.status !== 'DRAFT') throw new DomainError('STAGE_TRANSITION_DENIED', 409, 'status');
    const open = await tx.query<{ n: string }>("select count(*)::text as n from machvon.bi_dataset where id = $1::uuid and status = 'ACTIVE'", [policy.datasetId]);
    if (Number(open[0]?.n ?? 0) === 0) throw new DomainError('VALIDATION_FAILED', 422, 'dataset_id');
    return {
      subject: { kind: 'ACCESS_POLICY', policy },
      checks: [
        { code: 'POLICY_IS_DRAFT', passed: true },
        { code: 'DATASET_ACTIVE', passed: true },
      ],
    };
  }
}
