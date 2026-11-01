import { Controller, Get, Inject, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { BiLineageStore, BiMetricStore, BiQueryJobStore, TenantDatabase } from '@machvon/db';
import type { QueryRunLine } from '@machvon/db';
import { DomainError } from '@machvon/kernel';
import type { EffectiveAccess, TenantContext } from '@machvon/kernel';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { CurrentTenant } from '../../tenant-context.decorator';
import { holdsOnWholeTenant } from '../adm/tenant-authority';
import { edgeView, nodeView, parseWay, readGraph } from '../dgv/lineage-graph';
import { holds } from '../dgv/lineage-visibility';

type Row = Record<string, unknown>;

const DEFAULT_PAGE = 50;
const MAX_PAGE = 200;

const lineView = (line: QueryRunLine): Row => ({
  id: line.id,
  requested_by: line.requestedBy,
  metric_version_ids: line.metricVersionIds,
  as_of_period: line.asOfPeriod,
  dataset_version_id: line.datasetVersionId,
  mode: line.mode,
  status: line.status,
  served_from_cache: line.servedFromCache,
  duration_ms: line.durationMs,
  row_count: line.rowCount,
  cost_units: line.costUnits,
  estimated_cost: line.estimatedCost,
  error_code: line.errorCode,
  created_at: line.createdAt,
  finished_at: line.finishedAt,
});

/**
 * The log of the queries and the lineage of a metric (ST-BI-009, BI 3 F3 and F5, BI-13 and BI-14). The log tells who asked, how long it took, how many rows, whether the answer came from the cache and how it ended, and never the
 * figures, the filters or the dimension: it is for the administrator of BI over the whole tenant. The lineage of a metric is read from the graph of data (DGV): the version of the metric, the version of the dataset it was read
 * over, the snapshot of DIS and the projects it is made of, each node checked for the person who asks; one they may not see is shown as restricted and nothing more.
 */
@Controller()
export class BiQueryLogController {
  private readonly jobs = new BiQueryJobStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get('bi/query-runs')
  @OperationId('listBiQueryRuns')
  async runs(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Query('status') status?: unknown,
    @Query('requested_by') requestedBy?: unknown,
    @Query('as_of_period') asOfPeriod?: unknown,
    @Query('cursor') cursor?: unknown,
    @Query('limit') limit?: unknown,
  ): Promise<{ items: Row[]; next_cursor: string | null }> {
    // The log is the administrator's over the whole tenant: a right over one unit does not read the queries of the others.
    if (!holdsOnWholeTenant(access, PERMISSIONS.listBiQueryRuns)) throw new DomainError('SCOPE_DENIED', 403);
    for (const [name, value] of [
      ['status', status],
      ['requested_by', requestedBy],
      ['as_of_period', asOfPeriod],
      ['cursor', cursor],
    ] as const) {
      if (value !== undefined && typeof value !== 'string') throw new DomainError('VALIDATION_FAILED', 422, name);
    }
    const page = limit === undefined ? DEFAULT_PAGE : typeof limit === 'string' && /^[0-9]{1,4}$/.test(limit) ? Number(limit) : 0;
    if (page < 1 || page > MAX_PAGE) throw new DomainError('VALIDATION_FAILED', 422, 'limit');
    const done = await this.database.withTenant(tenant, (tx) =>
      this.jobs.list(tx, {
        status: status as string | undefined,
        requestedBy: requestedBy as string | undefined,
        asOfPeriod: asOfPeriod as string | undefined,
        cursor: cursor as string | undefined,
        limit: page,
      }),
    );
    return { items: done.items.map(lineView), next_cursor: done.next };
  }
}

@Controller()
export class BiQueryRunController {
  private readonly jobs = new BiQueryJobStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  /** How a query of the person ended (the job a heavy query became: waiting, running, or how it ended): theirs only, the run of another is as good as none. It is what a screen asks while it waits, and it tells nothing of the figures. */
  @Get('bi/query-runs/:id')
  @OperationId('getBiQueryRun')
  async run(@CurrentTenant() tenant: TenantContext, @Param('id', ParseUUIDPipe) id: string): Promise<Row> {
    const found = await this.database.withTenant(tenant, (tx) => this.jobs.find(tx, id.toLowerCase()));
    if (found === undefined || found.requestedBy !== tenant.membershipId) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return lineView(found);
  }
}

@Controller()
export class BiLineageController {
  private readonly metrics = new BiMetricStore();
  private readonly lineage = new BiLineageStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get('bi/metric-definitions/:id/lineage')
  @OperationId('getBiLineage')
  async lineageOf(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('direction') direction?: unknown,
    @Query('depth') depth?: unknown,
  ): Promise<Row> {
    const way = parseWay(direction, depth);
    const now = new Date();
    const answered = await this.database.withTenant(tenant, async (tx) => {
      if ((await this.metrics.find(tx, id.toLowerCase())) === undefined) return undefined;
      const read = await readGraph(tx, { membershipId: tenant.membershipId, access, now, permission: PERMISSIONS.getBiLineage }, { kind: 'METRIC_VERSION', refId: id.toLowerCase(), ...way });
      if (!read.found) return { read };
      // The quality of the versions of the dataset on the way: only of those the person sees (a restricted node says nothing).
      const versionIds = read.shown.nodes.flatMap((node) => (node.restricted || node.nodeKind !== 'DATASET_VERSION' || node.refId === null ? [] : [node.refId]));
      return { read, quality: await this.lineage.qualityOf(tx, versionIds) };
    });
    // A metric that is not the tenant's is not there; a metric nobody has read or built from yet has no lineage, which is an empty graph and not an error; one the person may not see is not told.
    if (answered === undefined || (!answered.read.found && answered.read.reason === 'HIDDEN')) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    // A metric the person may not read is not told to exist, with or without a lineage recorded about it.
    if (!answered.read.found && !holds(access, PERMISSIONS.get_resources_metric_definition, now)) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (!answered.read.found) return { start: null, direction: way.direction, depth: way.depth, truncated: false, nodes: [], edges: [], quality: {} };
    const { read, quality } = answered as { read: Extract<typeof answered.read, { found: true }>; quality: Map<string, { badge: string; excluded: number }> };
    return {
      start: read.start.id,
      direction: way.direction,
      depth: way.depth,
      truncated: read.truncated,
      nodes: read.shown.nodes.map(nodeView),
      edges: read.shown.edges.map(edgeView),
      quality: Object.fromEntries(
        read.shown.nodes.flatMap((node) => {
          const found = node.restricted || node.refId === null ? undefined : quality.get(node.refId);
          return found === undefined ? [] : [[node.key, { quality_badge: found.badge, excluded_quarantine_rows: found.excluded }]];
        }),
      ),
    };
  }
}
