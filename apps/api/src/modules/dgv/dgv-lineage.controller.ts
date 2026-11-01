import { Body, Controller, Get, HttpCode, Inject, Post, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { DgvLineageStore, TenantDatabase } from '@machvon/db';
import { DomainError, LINEAGE_DEFAULT_DEPTH, LINEAGE_DIRECTIONS, LINEAGE_MAX_DEPTH, LINEAGE_NODE_KINDS, asUuid, parseLineageBatch, shapeGraph } from '@machvon/kernel';
import type { EffectiveAccess, LineageDirection, LineageNodeKind, TenantContext } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { CurrentTenant } from '../../tenant-context.decorator';
import { holdsOnWholeTenant } from '../adm/tenant-authority';
import { LineageVisibility } from './lineage-visibility';

const RESOURCE_TYPE = 'lineage_batch';

/**
 * The lineage of data (ST-DGV-006, DGV 3 F5). A pipeline, the builder of BI snapshots, an import or an export posts a batch of edges between nodes with the run that observed them and the version of the transform; a node
 * is named by its id (one of this tenant) or described by what it is, and the same batch posted twice adds no edge. The graph is read up or down from a node to a depth: a node the person may not see is shown as restricted,
 * with no name, no id and no kind, and a node of another tenant is not there at all.
 */
@Controller()
export class DgvLineageController {
  private readonly lineage = new DgvLineageStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Post('dgv/lineage-batches')
  @HttpCode(200)
  @OperationId('recordLineageBatch')
  @Command({ operation: 'recordLineageBatch' })
  async record(
    @Scope() scope: CommandScope,
    @CurrentAccess() access: EffectiveAccess,
    @Body() body: Schemas['DgvLineageBatch'],
  ): Promise<CommandResult & { edges: number; edges_created: number; nodes_created: number }> {
    // The lineage is the tenant's: a pipeline writes it over the whole tenant, not over a unit.
    if (!holdsOnWholeTenant(access, PERMISSIONS.recordLineageBatch)) throw new DomainError('SCOPE_DENIED', 403);
    const batch = parseLineageBatch(body);
    // The writes of the lineage of the tenant are taken one batch after the other (two batches that share nodes cannot wait for each other).
    await this.lineage.lockWrites(scope.tx);
    const observed = new Date();
    let nodesCreated = 0;
    let edgesCreated = 0;
    // One after the other: the queries of a transaction share a connection, and two edges may name one node.
    const resolve = async (ref: (typeof batch.edges)[number]['from'], field: string): Promise<string> => {
      if (ref.kind === 'DESCRIBED') {
        const made = await this.lineage.upsertNode(scope.tx, ref);
        if (made.created) nodesCreated += 1;
        return made.id;
      }
      // A node that is named by its id is one of this tenant (the policy of the rows hides every other): any other is not a node.
      if ((await this.lineage.node(scope.tx, ref.id)) === undefined) throw new DomainError('LINEAGE_NODE_INVALID', 422, field);
      return ref.id;
    };
    for (const [index, edge] of batch.edges.entries()) {
      const fromId = await resolve(edge.from, `edges[${index}].from`);
      const toId = await resolve(edge.to, `edges[${index}].to`);
      if (fromId === toId) throw new DomainError('LINEAGE_NODE_INVALID', 422, `edges[${index}]`);
      if (await this.lineage.recordEdge(scope.tx, { fromId, toId, runId: batch.runId, transformVersion: batch.transformVersion, observedAt: edge.observedAt ?? observed })) edgesCreated += 1;
    }
    await scope.audit({
      action: 'dgv.lineage_batch',
      resourceType: RESOURCE_TYPE,
      resourceId: batch.runId,
      diff: { run_id: batch.runId, transform_version: batch.transformVersion, edges: batch.edges.length, edges_created: edgesCreated, nodes_created: nodesCreated },
    });
    return { ...commandResult(scope, 'RECORDED', 1, batch.runId), edges: batch.edges.length, edges_created: edgesCreated, nodes_created: nodesCreated };
  }

  @Get('dgv/lineage')
  @OperationId('getLineageGraph')
  async graph(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Query('node_kind') nodeKind?: unknown,
    @Query('ref_id') refId?: unknown,
    @Query('direction') direction?: unknown,
    @Query('depth') depth?: unknown,
  ): Promise<Record<string, unknown>> {
    const kind = LINEAGE_NODE_KINDS.find((candidate) => candidate === nodeKind) as LineageNodeKind | undefined;
    if (kind === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'node_kind');
    const id = typeof refId === 'string' ? asUuid(refId) : undefined;
    if (id === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'ref_id');
    const way = direction === undefined ? 'upstream' : (LINEAGE_DIRECTIONS.find((candidate) => candidate === direction) as LineageDirection | undefined);
    if (way === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'direction');
    const steps = depth === undefined ? LINEAGE_DEFAULT_DEPTH : typeof depth === 'string' && /^[1-9]$/.test(depth) ? Number(depth) : 0;
    if (steps < 1 || steps > LINEAGE_MAX_DEPTH) throw new DomainError('VALIDATION_FAILED', 422, 'depth');
    const now = new Date();
    const shown = await this.database.withTenant(tenant, async (tx) => {
      const start = await this.lineage.findByRef(tx, kind, id);
      if (start === undefined) return undefined;
      const visibility = new LineageVisibility(tx, { membershipId: tenant.membershipId, access, now });
      // A node the person may not see is not one they can ask the graph of: it is as good as none.
      if (!(await visibility.visible([start])).has(start.id)) return undefined;
      const walked = await this.lineage.traverse(tx, start, way, steps);
      const visible = await visibility.visible(walked.nodes);
      return { start, walked, ...shapeGraph(walked.nodes, walked.edges, walked.levels, visible) };
    });
    if (shown === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return { start: shown.start.id, direction: way, depth: steps, truncated: shown.walked.truncated, nodes: shown.nodes.map(nodeView), edges: shown.edges.map(edgeView) };
  }
}

function nodeView(node: ReturnType<typeof shapeGraph>['nodes'][number]): Record<string, unknown> {
  return node.restricted
    ? { key: node.key, restricted: true, level: node.level }
    : {
        key: node.key,
        restricted: false,
        node_kind: node.nodeKind,
        ref_module: node.refModule,
        ref_id: node.refId,
        ref_key: node.refKey,
        display_name: node.displayName,
        classification: node.classification,
        level: node.level,
      };
}

const edgeView = (edge: ReturnType<typeof shapeGraph>['edges'][number]): Record<string, unknown> => ({
  from: edge.from,
  to: edge.to,
  run_id: edge.runId,
  transform_version: edge.transformVersion,
  observed_at: edge.observedAt,
});
