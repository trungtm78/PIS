import { ApiError } from '@machvon/api-client';

export const NODE_KINDS = ['SOURCE_SYSTEM', 'IMPORT_BATCH', 'TABLE', 'RECORD', 'DATASET', 'DATASET_VERSION', 'METRIC_VERSION', 'DASHBOARD_VERSION', 'EXPORT'] as const;
export type NodeKind = (typeof NODE_KINDS)[number];
export const DIRECTIONS = ['upstream', 'downstream'] as const;
export type Direction = (typeof DIRECTIONS)[number];
export const DEPTHS = [1, 2, 3, 4, 5, 6] as const;
export const DEFAULT_DEPTH = 3;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Raw = Record<string, unknown>;
const isRecord = (value: unknown): value is Raw => typeof value === 'object' && value !== null && !Array.isArray(value);
const nullableText = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/** A node of the answer: one the person may see, whole, or one they may not, which has a position and a level and nothing else. */
export interface LineageNode {
  key: string;
  restricted: boolean;
  kind: NodeKind | null;
  module: string | null;
  refId: string | null;
  refKey: string | null;
  name: string | null;
  classification: string | null;
  level: number;
}

export interface LineageEdge {
  from: string;
  to: string;
  runId: string | null;
  transformVersion: string | null;
  observedAt: string | null;
}

export interface LineageGraph {
  start: string;
  direction: Direction;
  depth: number;
  truncated: boolean;
  nodes: LineageNode[];
  edges: LineageEdge[];
}

export function toGraph(raw: unknown): LineageGraph | undefined {
  if (!isRecord(raw) || typeof raw.start !== 'string' || !Array.isArray(raw.nodes) || !Array.isArray(raw.edges)) return undefined;
  const nodes = raw.nodes.flatMap((item): LineageNode[] => {
    if (!isRecord(item) || typeof item.key !== 'string') return [];
    const restricted = item.restricted === true;
    return [
      {
        key: item.key,
        restricted,
        // A restricted node is told by nothing but its place: whatever else it carried is not read.
        kind: restricted ? null : (NODE_KINDS.find((kind) => kind === item.node_kind) ?? null),
        module: restricted ? null : nullableText(item.ref_module),
        refId: restricted ? null : nullableText(item.ref_id),
        refKey: restricted ? null : nullableText(item.ref_key),
        name: restricted ? null : nullableText(item.display_name),
        classification: restricted ? null : nullableText(item.classification),
        level: typeof item.level === 'number' ? item.level : 0,
      },
    ];
  });
  const edges = raw.edges.flatMap((item): LineageEdge[] =>
    isRecord(item) && typeof item.from === 'string' && typeof item.to === 'string'
      ? [{ from: item.from, to: item.to, runId: nullableText(item.run_id), transformVersion: nullableText(item.transform_version), observedAt: nullableText(item.observed_at) }]
      : [],
  );
  return {
    start: raw.start,
    direction: raw.direction === 'downstream' ? 'downstream' : 'upstream',
    depth: typeof raw.depth === 'number' ? raw.depth : DEFAULT_DEPTH,
    truncated: raw.truncated === true,
    nodes,
    edges,
  };
}

/** The nodes of the graph by level, nearest first: the tree the screen draws. */
export function levelsOf(graph: LineageGraph): Array<{ level: number; nodes: LineageNode[] }> {
  const by = new Map<number, LineageNode[]>();
  for (const node of graph.nodes) by.set(node.level, [...(by.get(node.level) ?? []), node]);
  return [...by.entries()].sort(([a], [b]) => a - b).map(([level, nodes]) => ({ level, nodes }));
}

export interface LineageQuery {
  kind: NodeKind;
  refId: string;
  direction: Direction;
  depth: number;
}

export const EMPTY_QUERY: LineageQuery = { kind: 'METRIC_VERSION', refId: '', direction: 'upstream', depth: DEFAULT_DEPTH };

export type QueryProblem = 'required' | 'invalid';

export function validateQuery(query: LineageQuery): { refId?: QueryProblem } {
  const id = query.refId.trim();
  if (id === '') return { refId: 'required' };
  return UUID.test(id) ? {} : { refId: 'invalid' };
}

/** Whether two questions are the same one (the id is judged as the server reads it: blanks and case do not make another). */
export const sameQuery = (a: LineageQuery, b: LineageQuery): boolean =>
  a.kind === b.kind && a.direction === b.direction && a.depth === b.depth && a.refId.trim().toLowerCase() === b.refId.trim().toLowerCase();

export const queryParams = (query: LineageQuery): { node_kind: NodeKind; ref_id: string; direction: Direction; depth: string } => ({
  node_kind: query.kind,
  ref_id: query.refId.trim().toLowerCase(),
  direction: query.direction,
  depth: String(query.depth),
});

export type LineageReason = 'notFound' | 'scope' | 'invalid' | 'general';

export function describeLineageProblem(error: unknown): LineageReason {
  if (!(error instanceof ApiError)) return 'general';
  switch (error.code) {
    case 'RESOURCE_NOT_FOUND':
      return 'notFound';
    case 'SCOPE_DENIED':
      return 'scope';
    case 'VALIDATION_FAILED':
    case 'INVALID_REQUEST':
      return 'invalid';
    default:
      return 'general';
  }
}
