import type { NodeRef } from '@machvon/kernel';
import { DgvLineageStore } from './dgv-lineage-store.ts';
import type { TenantTx } from './tenant-database.ts';

type Described = Extract<NodeRef, { kind: 'DESCRIBED' }>;

/** The version of the transform the lineage of BI names on its edges: what made one node out of the other. */
export const BI_BUILD_TRANSFORM = 'bi-dataset-build-v1';
export const BI_SNAPSHOT_TRANSFORM = 'dis-snapshot-close-v1';
export const BI_DASHBOARD_TRANSFORM = 'bi-dashboard-version-v1';
/** The transform of a metric is its own revision: the figure is the one that revision of its formula makes of the version of the dataset. */
export const metricTransform = (code: string, revision: number): string => `metric:${code}@${revision}`.slice(0, 80);

const node = (nodeKind: Described['nodeKind'], module: string, ref: { id?: string; key?: string }, displayName: string): Described => ({
  kind: 'DESCRIBED',
  nodeKind,
  module,
  refId: ref.id ?? null,
  refKey: ref.key ?? null,
  displayName: displayName.trim().slice(0, 200),
  classification: 'INTERNAL',
});

/**
 * What BI tells the lineage of data (ST-BI-009, BI 3 F5): which snapshot of DIS a version of a dataset was built from and the projects that snapshot is made of, which version of a dataset a metric was read over, which metrics
 * a version of a dashboard shows. BI says what it made; who may see each node is the rule of the lineage, not of this store. Writing one edge that is there already writes nothing and takes no lock.
 */
export class BiLineageStore {
  private readonly lineage = new DgvLineageStore();

  /** The version of a dataset that was built: it comes from the snapshot of DIS it was built from, and the snapshot comes from the projects whose lines it holds (the records). */
  async datasetBuilt(tx: TenantTx, input: { versionId: string; datasetCode: string; asOfPeriod: string; sourceSnapshotId: string; observedAt: Date }): Promise<void> {
    const snapshot = node('TABLE', 'DIS', { key: `period_snapshot:${input.sourceSnapshotId}` }, `Snapshot ${input.asOfPeriod}`);
    const version = node('DATASET_VERSION', 'BI', { id: input.versionId }, `${input.datasetCode} ${input.asOfPeriod}`);
    await this.lineage.link(tx, snapshot, version, { runId: input.versionId, transformVersion: BI_BUILD_TRANSFORM, observedAt: input.observedAt });
    const snapshotNodeId = await this.lineage.idOf(tx, snapshot);
    if (snapshotNodeId === undefined) return;
    await this.lineage.lockWrites(tx);
    await this.linkRecords(tx, { ...input, snapshotNodeId });
  }

  /** The version of the contract dataset that was built: it comes from the contract fact frozen with the snapshot of DIS of its period. */
  async contractFactBuilt(tx: TenantTx, input: { versionId: string; datasetCode: string; asOfPeriod: string; factSnapshotId: string; observedAt: Date }): Promise<void> {
    const snapshot = node('TABLE', 'CTR', { key: `contract_fact_snapshot:${input.factSnapshotId}` }, `Contract fact ${input.asOfPeriod}`);
    const version = node('DATASET_VERSION', 'BI', { id: input.versionId }, `${input.datasetCode} ${input.asOfPeriod}`);
    await this.lineage.link(tx, snapshot, version, { runId: input.versionId, transformVersion: BI_BUILD_TRANSFORM, observedAt: input.observedAt });
  }

  /** A metric that was read over a version of a dataset: the figure comes from that version, by that revision of the formula. */
  async metricRead(
    tx: TenantTx,
    input: { metricId: string; metricCode: string; metricRevision: number; versionId: string; datasetCode: string; asOfPeriod: string; runId: string; observedAt: Date },
  ): Promise<void> {
    const version = node('DATASET_VERSION', 'BI', { id: input.versionId }, `${input.datasetCode} ${input.asOfPeriod}`);
    const metric = node('METRIC_VERSION', 'BI', { id: input.metricId }, `${input.metricCode} r${input.metricRevision}`);
    await this.lineage.link(tx, version, metric, { runId: input.runId, transformVersion: metricTransform(input.metricCode, input.metricRevision), observedAt: input.observedAt });
  }

  /** A version of a dashboard that was saved: it shows each of its metrics. */
  async dashboardVersionSaved(tx: TenantTx, input: { versionId: string; dashboardCode: string; revision: number; metricVersionIds: readonly string[]; observedAt: Date }): Promise<void> {
    if (input.metricVersionIds.length === 0) return;
    const metrics = await tx.query<{ id: string; code: string; revision: number }>('select id, code, revision from machvon.metric_definition where id = any($1::uuid[]) order by id', [
      [...input.metricVersionIds],
    ]);
    const dashboard = node('DASHBOARD_VERSION', 'BI', { id: input.versionId }, `${input.dashboardCode} #${input.revision}`);
    for (const metric of metrics) {
      await this.lineage.link(tx, node('METRIC_VERSION', 'BI', { id: metric.id }, `${metric.code} r${metric.revision}`), dashboard, {
        runId: input.versionId,
        transformVersion: BI_DASHBOARD_TRANSFORM,
        observedAt: input.observedAt,
      });
    }
  }

  /** The quality of the versions of a dataset (the badge and the rows the quarantine kept out), by version id. */
  async qualityOf(tx: TenantTx, versionIds: readonly string[]): Promise<Map<string, { badge: string; excluded: number }>> {
    if (versionIds.length === 0) return new Map();
    const rows = await tx.query<{ id: string; quality_badge: string; excluded: string }>(
      'select id, quality_badge, excluded_quarantine_rows::text as excluded from machvon.bi_dataset_version where id = any($1::uuid[])',
      [[...versionIds]],
    );
    return new Map(rows.map((row) => [row.id, { badge: row.quality_badge, excluded: Number(row.excluded) }]));
  }

  /** Joins every project that has a line in the snapshot to the node of the snapshot; the projects that are not nodes yet are made (one statement for the nodes, one for the edges). The caller holds the lock of the writes. */
  private async linkRecords(tx: TenantTx, input: { sourceSnapshotId: string; snapshotNodeId: string; versionId: string; observedAt: Date }): Promise<number> {
    await tx.query(
      `insert into machvon.lineage_node (tenant_id, id, node_kind, ref_module, ref_id, ref_key, display_name, classification)
       select nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), 'RECORD', 'PRJ', p.id, null, left(p.code || ' - ' || p.name, 200), 'INTERNAL'
         from machvon.project p
        where p.id in (select l.project_id from machvon.period_snapshot_line l where l.snapshot_id = $1::uuid)
       on conflict do nothing`,
      [input.sourceSnapshotId],
    );
    // The projects of a snapshot that was loaded a moment ago are joined to their nodes as a whole: the planner knows nothing yet of the size of either side and would look for the nodes of the thousands one by one among all of them.
    await tx.query("select set_config('enable_nestloop', 'off', true)");
    const linked = await tx.query<{ id: string }>(
      `insert into machvon.lineage_edge (tenant_id, id, from_node_id, to_node_id, run_id, transform_version, observed_at)
       select nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), n.id, $2::uuid, $3::uuid, $4, $5::timestamptz
         from (select distinct l.project_id from machvon.period_snapshot_line l where l.snapshot_id = $1::uuid) s
         join machvon.lineage_node n on n.tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid and n.node_kind = 'RECORD' and n.ref_module = 'PRJ'
          and coalesce(n.ref_id, '00000000-0000-0000-0000-000000000000'::uuid) = s.project_id and coalesce(n.ref_key, '') = ''
       on conflict (tenant_id, from_node_id, to_node_id, transform_version) do nothing
       returning id`,
      [input.sourceSnapshotId, input.snapshotNodeId, input.versionId, BI_SNAPSHOT_TRANSFORM, input.observedAt.toISOString()],
    );
    await tx.query("select set_config('enable_nestloop', 'on', true)");
    return linked.length;
  }
}
