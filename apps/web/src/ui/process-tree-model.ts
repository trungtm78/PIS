/** The pure side of ProcessTree (docs/process-tree-design.md): the shape of the tree, what is visible, where an arrow key goes, where each card and edge lies in the flow. */

export type ProcessTreeHealth = 'ok' | 'attention' | 'late' | 'hold' | 'none';
export type ProcessTreeEdgeKind = 'forward' | 'return' | 'drop';

export interface ProcessTreeNode {
  id: string;
  label: string;
  /** Null when the count could not be read: the card says so, it never shows 0. */
  count: number | null;
  value?: string;
  unit?: string;
  /** 0..1 of the whole. */
  share?: number | null;
  health?: ProcessTreeHealth;
  medianDays?: number | null;
  longestDays?: number | null;
  lateCount?: number;
  heldCount?: number;
  parentId?: string | null;
  /** The branch lane (a selection method) the node belongs to in the flow view. */
  lane?: string;
  /** The column of the flow view; without it the depth in the tree is the column. */
  column?: number;
  /** `below` puts the node under the main row of its lane (hold and returned paths). */
  row?: 'main' | 'below';
  /** The node is a terminal of the flow (it sits in the last column of its lane). */
  terminal?: boolean;
  /** False keeps the node in the outline and the table only. */
  inFlow?: boolean;
  /** The sentence a screen reader reads for the card; without it the component builds one. */
  ariaLabel?: string;
}

export interface ProcessTreeEdge {
  from: string;
  to: string;
  count: number;
  kind: ProcessTreeEdgeKind;
  /** Replaces the default label of the edge ("returned 2"). */
  label?: string;
}

export interface TreeIndex {
  byId: ReadonlyMap<string, ProcessTreeNode>;
  children: ReadonlyMap<string | null, readonly string[]>;
  depth: ReadonlyMap<string, number>;
  /** Pre-order of the whole tree. */
  order: readonly string[];
}

export function indexOf(nodes: readonly ProcessTreeNode[]): TreeIndex {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const children = new Map<string | null, string[]>();
  for (const node of nodes) {
    const parent = node.parentId !== undefined && node.parentId !== null && byId.has(node.parentId) ? node.parentId : null;
    const list = children.get(parent);
    if (list === undefined) children.set(parent, [node.id]);
    else list.push(node.id);
  }
  const depth = new Map<string, number>();
  const order: string[] = [];
  const walk = (id: string, level: number): void => {
    depth.set(id, level);
    order.push(id);
    for (const child of children.get(id) ?? []) walk(child, level + 1);
  };
  for (const root of children.get(null) ?? []) walk(root, 0);
  return { byId, children, depth, order };
}

/** The nodes that are shown in the outline: a node is shown when every ancestor is expanded. */
export function visibleOrder(index: TreeIndex, expanded: ReadonlySet<string>): string[] {
  const shown: string[] = [];
  const walk = (id: string): void => {
    shown.push(id);
    if (!expanded.has(id)) return;
    for (const child of index.children.get(id) ?? []) walk(child);
  };
  for (const root of index.children.get(null) ?? []) walk(root);
  return shown;
}

/** The nodes that are expanded when nothing was remembered: those above `depth`. */
export function defaultExpanded(index: TreeIndex, depth: number): Set<string> {
  return new Set(index.order.filter((id) => (index.depth.get(id) ?? 0) < depth && (index.children.get(id)?.length ?? 0) > 0));
}

export type NavKey = 'ArrowRight' | 'ArrowLeft' | 'ArrowDown' | 'ArrowUp' | 'Home' | 'End';

/**
 * Where a key goes from `current` (spec section 9): Right to the first child (and expands it in the outline), Left to the parent, Down and Up to the next and the previous sibling, Home and End to the first and the last
 * node that is shown. Returns the id to focus, or `current` when the key goes nowhere.
 */
export function navigate(index: TreeIndex, shown: readonly string[], current: string, key: NavKey): string {
  const node = index.byId.get(current);
  if (node === undefined) return current;
  if (key === 'Home') return shown[0] ?? current;
  if (key === 'End') return shown[shown.length - 1] ?? current;
  const parent = node.parentId !== undefined && node.parentId !== null && index.byId.has(node.parentId) ? node.parentId : null;
  if (key === 'ArrowLeft') return parent ?? current;
  if (key === 'ArrowRight') return (index.children.get(current) ?? []).find((child) => shown.includes(child)) ?? current;
  const siblings = (index.children.get(parent) ?? []).filter((id) => shown.includes(id));
  const at = siblings.indexOf(current);
  if (key === 'ArrowDown') return siblings[at + 1] ?? current;
  return at > 0 ? (siblings[at - 1] as string) : current;
}

// ---- the flow layout -----------------------------------------------------------------------------------------------------------------------------------------------------

export interface FlowGeometry {
  columnWidth: number;
  gutter: number;
  nodeHeight: number;
  rowGap: number;
  laneHeader: number;
  laneGap: number;
}

export interface PlacedNode {
  id: string;
  x: number;
  y: number;
  lane: string;
  column: number;
  row: 'main' | 'below';
}

export interface PlacedLane {
  lane: string;
  y: number;
  height: number;
  nodes: PlacedNode[];
}

export interface FlowLayout {
  lanes: PlacedLane[];
  placed: ReadonlyMap<string, PlacedNode>;
  width: number;
  height: number;
}

export function layoutFlow(nodes: readonly ProcessTreeNode[], index: TreeIndex, geometry: FlowGeometry): FlowLayout {
  const inFlow = nodes.filter((node) => node.inFlow !== false);
  const laneNames: string[] = [];
  for (const node of inFlow) {
    const lane = node.lane ?? '';
    if (!laneNames.includes(lane)) laneNames.push(lane);
  }
  const step = geometry.columnWidth + geometry.gutter;
  const maxColumn = Math.max(0, ...inFlow.map((node) => node.column ?? index.depth.get(node.id) ?? 0));
  const lanes: PlacedLane[] = [];
  const placed = new Map<string, PlacedNode>();
  let top = 0;
  for (const lane of laneNames) {
    const members = inFlow.filter((node) => (node.lane ?? '') === lane);
    const hasBelow = members.some((node) => node.row === 'below');
    const header = lane === '' ? 0 : geometry.laneHeader;
    const height = header + geometry.nodeHeight + (hasBelow ? geometry.rowGap + geometry.nodeHeight : 0);
    const cells: PlacedNode[] = members.map((node) => {
      const column = node.column ?? index.depth.get(node.id) ?? 0;
      const row = node.row ?? 'main';
      return { id: node.id, x: column * step, y: top + header + (row === 'below' ? geometry.nodeHeight + geometry.rowGap : 0), lane, column, row };
    });
    for (const cell of cells) placed.set(cell.id, cell);
    lanes.push({ lane, y: top, height, nodes: cells });
    top += height + geometry.laneGap;
  }
  return { lanes, placed, width: (maxColumn + 1) * step - geometry.gutter, height: Math.max(0, top - geometry.laneGap) };
}

export interface EdgePath {
  from: string;
  to: string;
  kind: ProcessTreeEdgeKind;
  d: string;
  width: number;
  label: { x: number; y: number };
  count: number;
  text?: string;
}

const RADIUS = 8;

/** The orthogonal connector of an edge (90 degree turns with an 8 px radius); returns undefined when an end is not in the flow or the two nodes are in different lanes. */
export function edgePath(layout: FlowLayout, geometry: FlowGeometry, edge: ProcessTreeEdge, maxCount: number): EdgePath | undefined {
  const a = layout.placed.get(edge.from);
  const b = layout.placed.get(edge.to);
  if (a === undefined || b === undefined || a.lane !== b.lane || edge.count < 1) return undefined;
  const width = maxCount <= 1 ? 2 : Math.round((2 + (8 * (edge.count - 1)) / (maxCount - 1)) * 10) / 10;
  const h = geometry.nodeHeight;
  const w = geometry.columnWidth;
  const ay = a.y + h / 2;
  const by = b.y + h / 2;
  if (b.column > a.column || (b.column === a.column && b.row !== a.row)) {
    if (b.column === a.column) {
      const x = a.x + w / 2;
      const down = b.y > a.y;
      const y1 = down ? a.y + h : a.y;
      const y2 = down ? b.y : b.y + h;
      return { from: edge.from, to: edge.to, kind: edge.kind, d: `M ${x} ${y1} V ${y2}`, width, label: { x, y: (y1 + y2) / 2 }, count: edge.count, ...(edge.label === undefined ? {} : { text: edge.label }) };
    }
    const x1 = a.x + w;
    const x2 = b.x;
    const mid = (x1 + x2) / 2;
    const r = Math.min(RADIUS, Math.abs(by - ay) / 2, Math.abs(x2 - x1) / 2);
    const dir = by >= ay ? 1 : -1;
    const d = by === ay ? `M ${x1} ${ay} H ${x2}` : `M ${x1} ${ay} H ${mid - r} Q ${mid} ${ay} ${mid} ${ay + dir * r} V ${by - dir * r} Q ${mid} ${by} ${mid + r} ${by} H ${x2}`;
    return { from: edge.from, to: edge.to, kind: edge.kind, d, width, label: { x: mid, y: (ay + by) / 2 }, count: edge.count, ...(edge.label === undefined ? {} : { text: edge.label }) };
  }
  // A path back (to an earlier column, or the same column): under the cards, from the bottom of one to the bottom of the other.
  const x1 = a.x + w / 2;
  const x2 = b.x + w / 2;
  const bottom = Math.max(a.y, b.y) + h;
  const drop = bottom + 14;
  const r = Math.min(RADIUS, 7);
  const dir = x2 >= x1 ? 1 : -1;
  const d = `M ${x1} ${a.y + h} V ${drop - r} Q ${x1} ${drop} ${x1 + dir * r} ${drop} H ${x2 - dir * r} Q ${x2} ${drop} ${x2} ${drop - r} V ${b.y + h}`;
  return { from: edge.from, to: edge.to, kind: edge.kind, d, width, label: { x: (x1 + x2) / 2, y: drop }, count: edge.count, ...(edge.label === undefined ? {} : { text: edge.label }) };
}

/** The rounded percentage of a 0..1 share ("38"), or null when there is none. */
export const percentOf = (share: number | null | undefined): number | null => (share === null || share === undefined ? null : Math.round(share * 100));
