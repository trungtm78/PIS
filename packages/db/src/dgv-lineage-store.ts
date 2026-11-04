import { randomUUID } from 'node:crypto';
import { LINEAGE_MAX_EDGES_READ, LINEAGE_MAX_NODES } from '@machvon/kernel';
import type { GraphEdge, GraphNode, LineageClassification, LineageDirection, LineageNodeKind, NodeRef } from '@machvon/kernel';
import type { TenantTx } from './tenant-database.ts';

interface Sql {
  [column: string]: unknown;
  id: string;
  ref_module: string;
  ref_id: string | null;
  ref_key: string | null;
  display_name: string;
  from_node_id: string;
  to_node_id: string;
  run_id: string | null;
  transform_version: string;
}

type Described = Extract<NodeRef, { kind: 'DESCRIBED' }>;

const NIL = '00000000-0000-0000-0000-000000000000';
const iso = (value: unknown): string => new Date(value as string).toISOString();
const COLUMNS = 'id, node_kind, ref_module, ref_id, ref_key, display_name, classification';

const toNode = (row: Sql): GraphNode => ({
  id: row.id,
  nodeKind: row.node_kind as LineageNodeKind,
  refModule: row.ref_module,
  refId: row.ref_id,
  refKey: row.ref_key,
  displayName: row.display_name,
  classification: row.classification as LineageClassification,
});

const toEdge = (row: Sql): GraphEdge => ({ id: row.id, fromId: row.from_node_id, toId: row.to_node_id, runId: row.run_id, transformVersion: row.transform_version, observedAt: iso(row.observed_at) });

export interface Traversal {
  nodes: GraphNode[];
  edges: GraphEdge[];
  levels: Map<string, number>;
  /** The graph goes on past what was read (the node cap): the answer is cut, and says so. */
  truncated: boolean;
}

/**
 * The lineage graph (ST-DGV-006, DGV 3 F5): nodes and edges that are written once and never changed. A node is named by its kind, its module and the id or the key of what it stands for, so describing it twice is one node;
 * an edge is one for each pair of nodes and each version of the transform, so the same batch posted twice adds nothing. Who may see a node is not decided here.
 */
export class DgvLineageStore {
  async node(tx: TenantTx, id: string): Promise<GraphNode | undefined> {
    const rows = await tx.query<Sql>(`select ${COLUMNS} from machvon.lineage_node where id = $1::uuid`, [id]);
    return rows[0] === undefined ? undefined : toNode(rows[0]);
  }

  /** The node a person asks the graph of, by the kind and the id of what it stands for (the oldest one when two modules name the same id). */
  async findByRef(tx: TenantTx, kind: LineageNodeKind, refId: string): Promise<GraphNode | undefined> {
    const rows = await tx.query<Sql>(`select ${COLUMNS} from machvon.lineage_node where node_kind = $1 and ref_id = $2::uuid order by created_at, id limit 1`, [kind, refId]);
    return rows[0] === undefined ? undefined : toNode(rows[0]);
  }

  /**
   * Takes the writes of the lineage of the tenant one batch after the other: a batch is a number of nodes and edges that two batches may share in any order, and two transactions that each hold a node the other waits for
   * would be a deadlock. One lock for the tenant, taken first, leaves no order to get wrong.
   */
  async lockWrites(tx: TenantTx): Promise<void> {
    await tx.query("select pg_advisory_xact_lock(hashtextextended('lineage:' || current_setting('app.tenant_id', true), 0))");
  }

  /** The id of the node a description names, when it is there. */
  async idOf(tx: TenantTx, node: Described): Promise<string | undefined> {
    const found = await tx.query<{ id: string }>(
      "select id from machvon.lineage_node where node_kind = $1 and ref_module = $2 and coalesce(ref_id, $3::uuid) = coalesce($4::uuid, $3::uuid) and coalesce(ref_key, '') = coalesce($5, '')",
      [node.nodeKind, node.module, NIL, node.refId, node.refKey],
    );
    return found[0]?.id;
  }

  /** The node a batch describes: the one that is there, or a new one (the caller holds the lock of the writes). */
  async upsertNode(tx: TenantTx, node: Described): Promise<{ id: string; created: boolean }> {
    const existing = await this.idOf(tx, node);
    if (existing !== undefined) return { id: existing, created: false };
    const id = randomUUID();
    await tx.query(
      `insert into machvon.lineage_node (tenant_id, id, node_kind, ref_module, ref_id, ref_key, display_name, classification)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2, $3, $4::uuid, $5, $6, $7)`,
      [id, node.nodeKind, node.module, node.refId, node.refKey, node.displayName, node.classification],
    );
    return { id, created: true };
  }

  /** The edge is recorded once for the pair of nodes and the version of the transform; false when it was there. */
  async recordEdge(tx: TenantTx, edge: { fromId: string; toId: string; runId: string; transformVersion: string; observedAt: Date }): Promise<boolean> {
    const rows = await tx.query<{ id: string }>(
      `insert into machvon.lineage_edge (tenant_id, id, from_node_id, to_node_id, run_id, transform_version, observed_at)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6::timestamptz)
       on conflict (tenant_id, from_node_id, to_node_id, transform_version) do nothing returning id`,
      [randomUUID(), edge.fromId, edge.toId, edge.runId, edge.transformVersion, edge.observedAt.toISOString()],
    );
    return rows.length > 0;
  }

  /**
   * Joins two nodes that are described, for a module that knows what it made (BI: a dataset version built, a metric read over it, a dashboard that saves a version): the nodes are made when they are not there and the edge is
   * recorded once for the pair and the version of the transform. What is already there is found without the lock of the writes, so a query that was seen before writes nothing and waits for nobody; false when nothing was written.
   */
  async link(tx: TenantTx, from: Described, to: Described, edge: { runId: string; transformVersion: string; observedAt: Date }): Promise<boolean> {
    const known = [await this.idOf(tx, from), await this.idOf(tx, to)];
    if (known[0] !== undefined && known[1] !== undefined) {
      const there = await tx.query('select 1 from machvon.lineage_edge where from_node_id = $1::uuid and to_node_id = $2::uuid and transform_version = $3', [
        known[0],
        known[1],
        edge.transformVersion,
      ]);
      if (there.length > 0) return false;
    }
    await this.lockWrites(tx);
    const fromId = (await this.upsertNode(tx, from)).id;
    const toId = (await this.upsertNode(tx, to)).id;
    return this.recordEdge(tx, { fromId, toId, ...edge });
  }

  /** The nodes and the edges up or down from a node, a level at a time up to the depth; the answer is cut at the node cap. */
  async traverse(
    tx: TenantTx,
    start: GraphNode,
    direction: LineageDirection,
    depth: number,
    limits: { nodes: number; edges: number } = { nodes: LINEAGE_MAX_NODES, edges: LINEAGE_MAX_EDGES_READ },
  ): Promise<Traversal> {
    const nodes = new Map<string, GraphNode>([[start.id, start]]);
    const levels = new Map<string, number>([[start.id, 0]]);
    const edges = new Map<string, GraphEdge>();
    let frontier = [start.id];
    let truncated = false;
    for (let level = 1; level <= depth && frontier.length > 0 && !truncated; level += 1) {
      const [near, far] = direction === 'upstream' ? ['to_node_id', 'from_node_id'] : ['from_node_id', 'to_node_id'];
      // The edges are read up to what is left of the cap, and one more to tell that there are more: a node with very many edges is not read whole before it is cut.
      const room = limits.edges - edges.size;
      const read = await tx.query<Sql>(
        `select id, from_node_id, to_node_id, run_id, transform_version, observed_at from machvon.lineage_edge where ${near} = any($1::uuid[]) order by observed_at, id limit $2::int`,
        [frontier, room + 1],
      );
      if (read.length > room) truncated = true;
      const rows = read.slice(0, room);
      const next: string[] = [];
      for (const row of rows) {
        const neighbour = row[far] as string;
        if (!nodes.has(neighbour)) {
          if (nodes.size >= limits.nodes) {
            truncated = true;
            continue;
          }
          next.push(neighbour);
          nodes.set(neighbour, undefined as unknown as GraphNode);
          levels.set(neighbour, level);
        }
        edges.set(row.id, toEdge(row));
      }
      if (next.length > 0) {
        const found = await tx.query<Sql>(`select ${COLUMNS} from machvon.lineage_node where id = any($1::uuid[])`, [next]);
        for (const row of found) nodes.set(row.id, toNode(row));
      }
      frontier = next;
    }
    return {
      nodes: [...nodes.values()].filter((node) => node !== undefined),
      edges: [...edges.values()].filter((edge) => nodes.get(edge.fromId) !== undefined && nodes.get(edge.toId) !== undefined),
      levels,
      truncated,
    };
  }
}
