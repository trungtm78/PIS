import { nodeIdentity, parseLineageBatch, shapeGraph } from '../src/dgv-lineage.ts';
import type { GraphEdge, GraphNode } from '../src/dgv-lineage.ts';

const ID = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const node = (n: number, name: string, overrides: Partial<GraphNode> = {}): GraphNode => ({
  id: ID(n),
  nodeKind: 'TABLE',
  refModule: 'DIS',
  refId: ID(n + 100),
  refKey: null,
  displayName: name,
  classification: 'INTERNAL',
  ...overrides,
});
const edge = (from: number, to: number): GraphEdge => ({ id: ID(from * 10 + to), fromId: ID(from), toId: ID(to), runId: ID(900), transformVersion: 'v1', observedAt: '2026-11-01T00:00:00.000Z' });

describe('the lineage batch and the graph a person is shown (DGV 3 F5)', () => {
  it('reads a batch of edges between nodes named by their id or described by what they are, with the moment when it was seen', () => {
    const batch = parseLineageBatch({
      run_id: ID(1).toUpperCase(),
      transform_version: ' dis-v1 ',
      edges: [
        {
          from: { node_id: ID(2).toUpperCase() },
          to: { node_kind: 'TABLE', ref_module: 'DIS', ref_key: 'lines', display_name: '  bảng  ', classification: 'PERSONAL' },
          observed_at: '2026-11-01T01:00:00Z',
        },
      ],
    });
    expect(batch.runId).toBe(ID(1));
    expect(batch.transformVersion).toBe('dis-v1');
    expect(batch.edges[0]?.from).toEqual({ kind: 'ID', id: ID(2) });
    expect(batch.edges[0]?.to).toEqual({ kind: 'DESCRIBED', nodeKind: 'TABLE', module: 'DIS', refId: null, refKey: 'lines', displayName: 'bảng', classification: 'PERSONAL' });
    expect(batch.edges[0]?.observedAt?.toISOString()).toBe('2026-11-01T01:00:00.000Z');
    const described = batch.edges[0]?.to;
    expect(described?.kind === 'DESCRIBED' ? nodeIdentity(described) : '').toBe('TABLE|DIS||lines');
  });

  it('shows what may be seen whole and what may not as a position with nothing of the node, and keeps the run and the transform of an edge for the edges between nodes that may be seen', () => {
    const nodes = [node(1, 'Chỉ tiêu'), node(2, 'Bản ghi bí mật'), node(3, 'Bảng')];
    const edges = [edge(2, 1), edge(3, 2), edge(3, 1)];
    const levels = new Map([
      [ID(1), 0],
      [ID(2), 1],
      [ID(3), 2],
    ]);
    const shown = shapeGraph(nodes, edges, levels, new Set([ID(1), ID(3)]));
    expect(shown.nodes[0]).toMatchObject({ key: ID(1), restricted: false, displayName: 'Chỉ tiêu', level: 0 });
    expect(shown.nodes[1]).toEqual({ key: 'restricted-1', restricted: true, nodeKind: null, refModule: null, refId: null, refKey: null, displayName: null, classification: null, level: 1 });
    expect(JSON.stringify(shown)).not.toContain('Bản ghi bí mật');
    expect(shown.edges).toEqual([
      { from: 'restricted-1', to: ID(1), runId: null, transformVersion: null, observedAt: null },
      { from: ID(3), to: 'restricted-1', runId: null, transformVersion: null, observedAt: null },
      { from: ID(3), to: ID(1), runId: ID(900), transformVersion: 'v1', observedAt: '2026-11-01T00:00:00.000Z' },
    ]);
    // An edge to a node that was not read is left out; a node with no level is the start.
    expect(shapeGraph([node(1, 'a')], [edge(1, 9)], new Map(), new Set([ID(1)])).edges).toEqual([]);
    expect(shapeGraph([node(1, 'a')], [], new Map(), new Set([ID(1)])).nodes[0]?.level).toBe(0);
  });
});
