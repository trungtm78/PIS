import { DomainError } from './errors.ts';

/**
 * The lineage of data (ST-DGV-006, DGV 3 F5): nodes (a source system, an import batch, a table, a record, a dataset and its version, a metric version, a dashboard version, an export) and the edges between them, each edge
 * with the run that observed it and the version of the transform. A batch posts edges between nodes, naming a node by what it is or by the id it already has; the same batch posted twice changes nothing.
 */
export const LINEAGE_NODE_KINDS = ['SOURCE_SYSTEM', 'IMPORT_BATCH', 'TABLE', 'RECORD', 'DATASET', 'DATASET_VERSION', 'METRIC_VERSION', 'DASHBOARD_VERSION', 'EXPORT'] as const;
export type LineageNodeKind = (typeof LINEAGE_NODE_KINDS)[number];
export const LINEAGE_CLASSIFICATIONS = ['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'PERSONAL', 'IMPORTANT_CORE'] as const;
export type LineageClassification = (typeof LINEAGE_CLASSIFICATIONS)[number];
export const LINEAGE_MAX_EDGES = 500;
export const LINEAGE_MAX_DEPTH = 6;
export const LINEAGE_DEFAULT_DEPTH = 3;
/** The most edges one answer holds: a node with very many edges (or one pair of nodes under very many versions of a transform) is cut here, and the answer says so. */
export const LINEAGE_MAX_EDGES_READ = 2000;
/** The most nodes one answer holds: a larger graph is cut at the depth that reaches it, and says so. */
export const LINEAGE_MAX_NODES = 500;
export const LINEAGE_DIRECTIONS = ['upstream', 'downstream'] as const;
export type LineageDirection = (typeof LINEAGE_DIRECTIONS)[number];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MODULE = /^[A-Z]{2,8}$/;

/** A node as a batch names it: one that exists (by id), or one described by what it is (made when it is not there yet). */
export type NodeRef =
  | { kind: 'ID'; id: string }
  | { kind: 'DESCRIBED'; nodeKind: LineageNodeKind; module: string; refId: string | null; refKey: string | null; displayName: string; classification: LineageClassification };

export interface LineageEdgeInput {
  from: NodeRef;
  to: NodeRef;
  observedAt: Date | undefined;
}

export interface LineageBatchInput {
  runId: string;
  transformVersion: string;
  edges: LineageEdgeInput[];
}

const invalid = (field: string): DomainError => new DomainError('LINEAGE_NODE_INVALID', 422, field);
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function parseNode(raw: unknown, field: string): NodeRef {
  if (!record(raw)) throw invalid(field);
  if ('node_id' in raw) {
    if (Object.keys(raw).length !== 1 || typeof raw.node_id !== 'string' || !UUID.test(raw.node_id)) throw invalid(`${field}.node_id`);
    return { kind: 'ID', id: raw.node_id.toLowerCase() };
  }
  const allowed = new Set(['node_kind', 'ref_module', 'ref_id', 'ref_key', 'display_name', 'classification']);
  for (const key of Object.keys(raw)) if (!allowed.has(key)) throw invalid(`${field}.${key}`);
  const nodeKind = LINEAGE_NODE_KINDS.find((candidate) => candidate === raw.node_kind);
  if (nodeKind === undefined) throw invalid(`${field}.node_kind`);
  if (typeof raw.ref_module !== 'string' || !MODULE.test(raw.ref_module)) throw invalid(`${field}.ref_module`);
  const refId = raw.ref_id === undefined || raw.ref_id === null ? null : typeof raw.ref_id === 'string' && UUID.test(raw.ref_id) ? raw.ref_id.toLowerCase() : undefined;
  // A key is what remains after its blanks: one that is only blanks is no key (the database says the same).
  const refKey =
    raw.ref_key === undefined || raw.ref_key === null ? null : typeof raw.ref_key === 'string' && raw.ref_key.trim().length >= 1 && raw.ref_key.length <= 200 ? raw.ref_key.trim() : undefined;
  if (refId === undefined) throw invalid(`${field}.ref_id`);
  if (refKey === undefined) throw invalid(`${field}.ref_key`);
  if (refId === null && refKey === null) throw invalid(`${field}.ref_id`);
  const name = typeof raw.display_name === 'string' ? raw.display_name.trim().normalize('NFC') : '';
  if (name.length < 1 || name.length > 200) throw invalid(`${field}.display_name`);
  const classification = raw.classification === undefined ? 'INTERNAL' : LINEAGE_CLASSIFICATIONS.find((candidate) => candidate === raw.classification);
  if (classification === undefined) throw invalid(`${field}.classification`);
  return { kind: 'DESCRIBED', nodeKind, module: raw.ref_module, refId, refKey, displayName: name, classification };
}

/** A batch as the contract leaves it (the edges are free objects): anything that does not name its nodes properly is 422 `LINEAGE_NODE_INVALID` naming the field. */
export function parseLineageBatch(body: { run_id: string; transform_version: string; edges: unknown[] }): LineageBatchInput {
  if (!UUID.test(body.run_id)) throw new DomainError('VALIDATION_FAILED', 422, 'run_id');
  const transform = body.transform_version.trim();
  if (transform === '' || transform.length > 80) throw new DomainError('VALIDATION_FAILED', 422, 'transform_version');
  if (body.edges.length === 0 || body.edges.length > LINEAGE_MAX_EDGES) throw new DomainError('VALIDATION_FAILED', 422, 'edges');
  const edges = body.edges.map((raw, index): LineageEdgeInput => {
    if (!record(raw)) throw invalid(`edges[${index}]`);
    for (const key of Object.keys(raw)) if (key !== 'from' && key !== 'to' && key !== 'observed_at') throw invalid(`edges[${index}].${key}`);
    let observedAt: Date | undefined;
    if (raw.observed_at !== undefined) {
      observedAt = typeof raw.observed_at === 'string' ? new Date(raw.observed_at) : undefined;
      if (observedAt === undefined || Number.isNaN(observedAt.getTime())) throw invalid(`edges[${index}].observed_at`);
    }
    return { from: parseNode(raw.from, `edges[${index}].from`), to: parseNode(raw.to, `edges[${index}].to`), observedAt };
  });
  return { runId: body.run_id.toLowerCase(), transformVersion: transform, edges };
}

/** What a node is, whoever asks: the identity that the unique index of the store has, so two descriptions of one node are one. */
export const nodeIdentity = (node: Extract<NodeRef, { kind: 'DESCRIBED' }>): string => `${node.nodeKind}|${node.module}|${node.refId ?? ''}|${node.refKey ?? ''}`;

export interface GraphNode {
  id: string;
  nodeKind: LineageNodeKind;
  refModule: string;
  refId: string | null;
  refKey: string | null;
  displayName: string;
  classification: LineageClassification;
}

export interface GraphEdge {
  id: string;
  fromId: string;
  toId: string;
  runId: string | null;
  transformVersion: string;
  observedAt: string;
}

export interface ShownNode {
  /** The id of a node that may be seen; an opaque position (`restricted-1`) for one that may not, so the graph can still be drawn and nothing of the node is told. */
  key: string;
  restricted: boolean;
  nodeKind: LineageNodeKind | null;
  refModule: string | null;
  refId: string | null;
  refKey: string | null;
  displayName: string | null;
  classification: LineageClassification | null;
  /** How many steps from the node asked for (0 is that node). */
  level: number;
}

export interface ShownEdge {
  from: string;
  to: string;
  /** The run and the transform of an edge are told only when both its ends may be seen. */
  runId: string | null;
  transformVersion: string | null;
  observedAt: string | null;
}

/**
 * The graph as one person is shown it: a node they may see is told whole, one they may not is `restricted` with no name, no id, no kind and no classification, and an edge that touches one is told without its run and
 * its transform. The same restricted node is the same position in the answer, so the shape of the graph is the one thing that is left, and it is the graph of what the person may reach.
 */
export function shapeGraph(nodes: readonly GraphNode[], edges: readonly GraphEdge[], levels: ReadonlyMap<string, number>, visible: ReadonlySet<string>): { nodes: ShownNode[]; edges: ShownEdge[] } {
  const keys = new Map<string, string>();
  let hidden = 0;
  const shownNodes = nodes.map((node): ShownNode => {
    const level = levels.get(node.id) ?? 0;
    if (visible.has(node.id)) {
      keys.set(node.id, node.id);
      return {
        key: node.id,
        restricted: false,
        nodeKind: node.nodeKind,
        refModule: node.refModule,
        refId: node.refId,
        refKey: node.refKey,
        displayName: node.displayName,
        classification: node.classification,
        level,
      };
    }
    hidden += 1;
    keys.set(node.id, `restricted-${hidden}`);
    return { key: `restricted-${hidden}`, restricted: true, nodeKind: null, refModule: null, refId: null, refKey: null, displayName: null, classification: null, level };
  });
  const shownEdges = edges.flatMap((edge): ShownEdge[] => {
    const from = keys.get(edge.fromId);
    const to = keys.get(edge.toId);
    if (from === undefined || to === undefined) return [];
    const open = visible.has(edge.fromId) && visible.has(edge.toId);
    return [{ from, to, runId: open ? edge.runId : null, transformVersion: open ? edge.transformVersion : null, observedAt: open ? edge.observedAt : null }];
  });
  return { nodes: shownNodes, edges: shownEdges };
}
