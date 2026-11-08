import { Controller, Get, Inject, Optional, Query } from '@nestjs/common';
import { AnaTrustStore, TenantDatabase } from '@machvon/db';
import type { DatasetTrust } from '@machvon/db';
import { DomainError, FRESHNESS_RULE_TYPE, LINEAGE_KINDS, SCORECARD_MODULE_RULE_TYPE, SCORECARD_UNIT_RULE_TYPE, TRACE_MAX_DEPTH, describeRuleType, traceLineage, vietnamDateOf } from '@machvon/kernel';
import type { EffectiveAccess, ScorecardRow, TenantContext, TraceDirection } from '@machvon/kernel';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { CurrentTenant } from '../../tenant-context.decorator';
import { HOME_CLOCK } from './tokens';
import { workScopes } from './work-scope';

const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);
const NODE = /^(MODULE|TABLE|DATASET|METRIC|KPI):[A-Za-z0-9_.-]{1,100}$/;

const infoOf = (type: string, version: string, unverified: boolean): Record<string, unknown> => {
  const rule = describeRuleType(type);
  return { formula: rule.formula, source: rule.source, as_of: rule.asOf, rule_version: version, unverified };
};

const rowView = (row: ScorecardRow): Record<string, unknown> => ({
  composite: row.composite,
  band: row.band,
  null_reason: row.compositeNullReason,
  used_dimensions: row.usedDimensions,
  dimensions: row.dimensions.map((dimension) => ({ code: dimension.code, weight: dimension.weight, score: dimension.score, null_reason: dimension.nullReason })),
});

const datasetView = (one: DatasetTrust): Record<string, unknown> => ({
  code: one.code,
  title: one.title,
  module: one.module,
  dataset_id: one.datasetId,
  built_at: one.builtAt,
  as_of_period: one.asOfPeriod,
  quality_badge: one.qualityBadge,
  certification: one.certification,
  freshness: { status: one.freshness.status, age_hours: one.freshness.ageHours, sla_hours: one.freshness.slaHours, overdue_hours: one.freshness.overdueHours, null_reason: one.freshness.nullReason },
  sla_version: one.slaVersion,
  unverified: one.unverified,
});

/**
 * What the leader can trust (G3-7, G3-11): how old each dataset is against its SLA (a dataset that was never built has no data, and "stale data" appears by itself past the SLA), the quality scorecards of the modules and
 * of the units the reader may read, and the declared lineage "metric <- dataset <- table <- module" with the two questions: where does this number come from, and what stands on this table.
 */
@Controller()
export class AnaTrustController {
  private readonly trust = new AnaTrustStore();
  private readonly clock: () => Date;

  constructor(
    @Inject(TenantDatabase) private readonly database: TenantDatabase,
    @Optional() @Inject(HOME_CLOCK) clock?: () => Date,
  ) {
    this.clock = clock ?? ((): Date => new Date());
  }

  @Get('bi/data-freshness')
  @OperationId('getDataFreshness')
  async freshness(@CurrentTenant() tenant: TenantContext): Promise<Record<string, unknown>> {
    const now = this.clock();
    const today = vietnamDateOf(now);
    const datasets = await this.database.withTenant(tenant, (tx) => this.trust.freshness(tx, now, today));
    return {
      as_of: now.toISOString(),
      datasets: datasets.map(datasetView),
      stale_count: datasets.filter((one) => one.freshness.status === 'STALE').length,
      no_data_count: datasets.filter((one) => one.freshness.status === 'NO_DATA').length,
      info: infoOf(FRESHNESS_RULE_TYPE, datasets.every((one) => one.slaVersion === 'builtin') ? 'builtin' : 'mixed', datasets.some((one) => one.unverified)),
    };
  }

  @Get('home/quality-scorecard')
  @OperationId('getDataTrustScorecard')
  async scorecard(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess): Promise<Record<string, unknown>> {
    const now = this.clock();
    const today = vietnamDateOf(now);
    const scopes = workScopes(access, now);
    const read = await this.database.withTenant(tenant, async (tx) => ({ modules: await this.trust.moduleScores(tx, now, today), units: await this.trust.unitScores(tx, scopes.unitScope, now, today) }));
    return {
      as_of: today,
      snapshot_id: read.units.snapshotId,
      unit_as_of_date: read.units.asOfDate,
      modules: read.modules.modules.map((one) => ({ module: one.module, datasets: one.datasets, ...rowView(one.row) })),
      units: read.units.units.map((one) => ({ unit_id: one.unitId, code: one.code, name: one.name, ...rowView(one.row) })),
      module_info: infoOf(SCORECARD_MODULE_RULE_TYPE, read.modules.policy.version, read.modules.policy.unverified),
      unit_info: infoOf(SCORECARD_UNIT_RULE_TYPE, read.units.policy.version, read.units.policy.unverified),
    };
  }

  @Get('bi/lineage')
  @OperationId('getMetricLineageGraph')
  async lineage(@CurrentTenant() tenant: TenantContext, @Query('node') node?: unknown, @Query('direction') direction?: unknown, @Query('depth') depthText?: unknown): Promise<Record<string, unknown>> {
    if (node !== undefined && (typeof node !== 'string' || !NODE.test(node))) throw invalid('node');
    if (direction !== undefined && direction !== 'UPSTREAM' && direction !== 'DOWNSTREAM') throw invalid('direction');
    if (depthText !== undefined && (typeof depthText !== 'string' || !/^[1-9]$/.test(depthText) || Number(depthText) > TRACE_MAX_DEPTH)) throw invalid('depth');
    const graph = await this.database.withTenant(tenant, (tx) => this.trust.lineage(tx));
    const counts = { nodes: graph.nodes.length, edges: graph.edges.length };
    const catalogue = LINEAGE_KINDS.map((kind) => ({ kind, nodes: graph.nodes.filter((one) => one.kind === kind).map((one) => ({ id: one.id, key: one.key, label: one.label, module: one.module })) }));
    if (node === undefined) {
      return { counts, catalogue, trace: null, edges: graph.edges.map((edge) => ({ from: edge.from, to: edge.to, relation: edge.relation })), unresolved: graph.unresolved };
    }
    const traced = traceLineage(graph, node, (direction ?? 'UPSTREAM') as TraceDirection, depthText === undefined ? undefined : Number(depthText));
    if (traced === null) throw new DomainError('RESOURCE_NOT_FOUND', 404, 'node');
    return {
      counts,
      catalogue,
      trace: {
        root: traced.root,
        direction: traced.direction,
        nodes: traced.nodes.map((one) => ({ id: one.id, kind: one.kind, key: one.key, label: one.label, module: one.module })),
        edges: traced.edges.map((edge) => ({ from: edge.from, to: edge.to, relation: edge.relation })),
        paths: traced.paths,
      },
      edges: [],
      unresolved: graph.unresolved,
    };
  }
}
