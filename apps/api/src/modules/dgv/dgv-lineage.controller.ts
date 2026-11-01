import { Body, Controller, Get, HttpCode, Inject, Post, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { DgvLineageStore, TenantDatabase } from '@machvon/db';
import { DomainError, parseLineageBatch } from '@machvon/kernel';
import type { EffectiveAccess, TenantContext } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { CurrentTenant } from '../../tenant-context.decorator';
import { holdsOnWholeTenant } from '../adm/tenant-authority';
import { edgeView, nodeView, parseGraphQuery, readGraph } from './lineage-graph';

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
    const query = parseGraphQuery({ nodeKind, refId, direction, depth });
    const read = await this.database.withTenant(tenant, (tx) => readGraph(tx, { membershipId: tenant.membershipId, access, now: new Date() }, query));
    // A node the person may not see is not one they can ask the graph of, and one that is not there is not either: both are as good as none.
    if (!read.found) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return { start: read.start.id, direction: query.direction, depth: query.depth, truncated: read.truncated, nodes: read.shown.nodes.map(nodeView), edges: read.shown.edges.map(edgeView) };
  }
}

