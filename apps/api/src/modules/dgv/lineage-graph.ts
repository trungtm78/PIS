import { DgvLineageStore } from '@machvon/db';
import type { TenantTx } from '@machvon/db';
import { DomainError, LINEAGE_DEFAULT_DEPTH, LINEAGE_DIRECTIONS, LINEAGE_MAX_DEPTH, LINEAGE_NODE_KINDS, asUuid, shapeGraph } from '@machvon/kernel';
import type { EffectiveAccess, GraphNode, LineageDirection, LineageNodeKind } from '@machvon/kernel';
import { LineageVisibility } from './lineage-visibility';

/** What a read of the graph asks: the node by its kind and the id of what it stands for, up or down, a number of levels. */
export interface GraphQuery {
  kind: LineageNodeKind;
  refId: string;
  direction: LineageDirection;
  depth: number;
}

/** The query as the request has it: anything that is not what the graph takes is 422 naming the field. */
export function parseGraphQuery(input: { nodeKind: unknown; refId: unknown; direction: unknown; depth: unknown }): GraphQuery {
  const kind = LINEAGE_NODE_KINDS.find((candidate) => candidate === input.nodeKind) as LineageNodeKind | undefined;
  if (kind === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'node_kind');
  const refId = typeof input.refId === 'string' ? asUuid(input.refId) : undefined;
  if (refId === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'ref_id');
  return { kind, refId, ...parseWay(input.direction, input.depth) };
}

/** The direction and the depth of a read of the graph (upstream and three levels when they are not given). */
export function parseWay(direction: unknown, depth: unknown): { direction: LineageDirection; depth: number } {
  const way = direction === undefined ? 'upstream' : (LINEAGE_DIRECTIONS.find((candidate) => candidate === direction) as LineageDirection | undefined);
  if (way === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'direction');
  const steps = depth === undefined ? LINEAGE_DEFAULT_DEPTH : typeof depth === 'string' && /^[1-9]$/.test(depth) ? Number(depth) : 0;
  if (steps < 1 || steps > LINEAGE_MAX_DEPTH) throw new DomainError('VALIDATION_FAILED', 422, 'depth');
  return { direction: way, depth: steps };
}

export type GraphRead = { found: false; reason: 'NO_NODE' | 'HIDDEN' } | { found: true; start: GraphNode; truncated: boolean; shown: ReturnType<typeof shapeGraph> };

/**
 * The graph from a node, as one person may see it: a node they may not see is shown as restricted, with no name, no id and no kind. A start the person may not see is as good as none (the answer does not tell that it exists);
 * a start that is not a node yet says so, for a caller that knows the object exists and has had nothing recorded about it.
 */
export async function readGraph(tx: TenantTx, viewer: { membershipId: string; access: EffectiveAccess; now: Date; permission?: string }, query: GraphQuery): Promise<GraphRead> {
  const lineage = new DgvLineageStore();
  const start = await lineage.findByRef(tx, query.kind, query.refId);
  if (start === undefined) return { found: false, reason: 'NO_NODE' };
  const visibility = new LineageVisibility(tx, viewer);
  if (!(await visibility.visible([start])).has(start.id)) return { found: false, reason: 'HIDDEN' };
  const walked = await lineage.traverse(tx, start, query.direction, query.depth);
  const visible = await visibility.visible(walked.nodes);
  return { found: true, start, truncated: walked.truncated, shown: shapeGraph(walked.nodes, walked.edges, walked.levels, visible) };
}

export function nodeView(node: ReturnType<typeof shapeGraph>['nodes'][number]): Record<string, unknown> {
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

export const edgeView = (edge: ReturnType<typeof shapeGraph>['edges'][number]): Record<string, unknown> => ({
  from: edge.from,
  to: edge.to,
  run_id: edge.runId,
  transform_version: edge.transformVersion,
  observed_at: edge.observedAt,
});
