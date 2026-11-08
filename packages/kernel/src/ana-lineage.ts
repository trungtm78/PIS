/**
 * Where a number comes from (G3-11, BI): the declared lineage metric <- dataset <- table <- module, built from what the platform declares (the formulas of the metrics, the fields each dataset serves, the
 * tables each dataset is read from, the module that owns each table), with no observation of runs: that is the lineage of DGV. The same builder serves a KPI of the command center, which reads tables directly. It answers
 * "where does this number come from" (upstream) and "what is hurt if this table changes" (downstream), deterministically, and says plainly when it does not know the owner of a table.
 */

export const LINEAGE_KINDS = ['MODULE', 'TABLE', 'DATASET', 'METRIC', 'KPI'] as const;
export type DeclaredNodeKind = (typeof LINEAGE_KINDS)[number];
export type DeclaredRelation = 'OWNS' | 'FEEDS';

export interface DeclaredNode {
  /** `<kind>:<key>`, unique in the graph. */
  id: string;
  kind: DeclaredNodeKind;
  key: string;
  label: string;
  /** TABLE and DATASET: the module that owns it; null when the owner is not known (said, not guessed). */
  module: string | null;
}
export interface DeclaredEdge {
  /** The upstream node: it feeds, or owns, the node `to`. */
  from: string;
  to: string;
  relation: DeclaredRelation;
}
export interface DeclaredLineage {
  nodes: DeclaredNode[];
  edges: DeclaredEdge[];
  /** Metrics that read a field no dataset serves, and tables whose module is not known: listed so the gaps are seen. */
  unresolved: Array<{ kind: 'METRIC_WITHOUT_DATASET' | 'TABLE_WITHOUT_MODULE'; key: string }>;
}

export interface LineageMetric {
  code: string;
  label: string;
  /** The fields its formula reads. */
  fields: readonly string[];
}
export interface LineageDataset {
  code: string;
  label: string;
  producerModule: string;
  /** The fields the dataset serves. */
  fields: readonly string[];
  /** The tables it is read from, the base table first and then the tables of its approved joins. */
  tables: readonly string[];
}
export interface LineageKpi {
  code: string;
  label: string;
  tables: readonly string[];
}

/** The module that owns each table the declared lineage knows; a table that is not here is shown with no owner. */
export const TABLE_OWNERS: Readonly<Record<string, string>> = {
  period_snapshot: 'DIS',
  period_snapshot_line: 'DIS',
  early_warning: 'DIS',
  explanation_request: 'PRJ',
  project: 'PRJ',
  reallocation_proposal: 'CAP',
  contract_fact_snapshot: 'CTR',
  contract_fact_snapshot_line: 'CTR',
  contract_fact_snapshot_contract: 'CTR',
  acceptance: 'CTR',
  acceptance_line: 'CTR',
  organization_unit: 'ADM',
  master_record_version: 'MDM',
  contractor: 'BID',
};

/** The tables each indicator of the command center reads (the register says which module owns the figure; this says which tables it stands on). */
export const KPI_SOURCE_TABLES: Readonly<Record<string, readonly string[]>> = {
  DISBURSEMENT_RATE: ['period_snapshot', 'period_snapshot_line'],
  DISBURSEMENT_RATE_PM: ['period_snapshot', 'period_snapshot_line'],
  DISBURSEMENT_RATE_TOTAL: ['period_snapshot', 'period_snapshot_line'],
  DISBURSED_TREASURY: ['period_snapshot', 'period_snapshot_line'],
  PLAN_PM_ASSIGNED: ['period_snapshot', 'period_snapshot_line'],
  PLAN_TOTAL: ['period_snapshot', 'period_snapshot_line'],
  OPEN_WARNINGS: ['early_warning'],
  OVERDUE_EXPLANATIONS: ['explanation_request'],
  PENDING_REALLOCATIONS: ['reallocation_proposal'],
  PHYSICAL_PROGRESS: ['acceptance', 'acceptance_line'],
};

const idOf = (kind: DeclaredNodeKind, key: string): string => `${kind}:${key}`;
const byId = (left: { id: string }, right: { id: string }): number => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);

/** The graph from the declarations: nodes and edges sorted, each edge once, so the same inputs always give the same graph. */
export function buildLineage(input: { metrics: readonly LineageMetric[]; datasets: readonly LineageDataset[]; kpis: readonly LineageKpi[]; owners?: Readonly<Record<string, string>> }): DeclaredLineage {
  const owners = input.owners ?? TABLE_OWNERS;
  const nodes = new Map<string, DeclaredNode>();
  const edges = new Map<string, DeclaredEdge>();
  const unresolved: DeclaredLineage['unresolved'] = [];
  const node = (kind: DeclaredNodeKind, key: string, label: string, module: string | null): string => {
    const id = idOf(kind, key);
    if (!nodes.has(id)) nodes.set(id, { id, kind, key, label, module });
    return id;
  };
  const edge = (from: string, to: string, relation: DeclaredRelation): void => {
    edges.set(`${from}>${to}>${relation}`, { from, to, relation });
  };
  const table = (name: string): string => {
    const owner = owners[name] ?? null;
    const id = node('TABLE', name, name, owner);
    if (owner === null) {
      if (!unresolved.some((one) => one.kind === 'TABLE_WITHOUT_MODULE' && one.key === name)) unresolved.push({ kind: 'TABLE_WITHOUT_MODULE', key: name });
    } else edge(node('MODULE', owner, owner, null), id, 'OWNS');
    return id;
  };
  for (const dataset of input.datasets) {
    const id = node('DATASET', dataset.code, dataset.label, dataset.producerModule);
    for (const name of dataset.tables) edge(table(name), id, 'FEEDS');
  }
  for (const kpi of input.kpis) {
    const id = node('KPI', kpi.code, kpi.label, null);
    for (const name of kpi.tables) edge(table(name), id, 'FEEDS');
  }
  for (const metric of input.metrics) {
    const id = node('METRIC', metric.code, metric.label, null);
    const serving = input.datasets.filter((dataset) => metric.fields.length > 0 && metric.fields.every((field) => dataset.fields.includes(field)));
    if (serving.length === 0) unresolved.push({ kind: 'METRIC_WITHOUT_DATASET', key: metric.code });
    for (const dataset of serving) edge(idOf('DATASET', dataset.code), id, 'FEEDS');
  }
  return { nodes: [...nodes.values()].sort(byId), edges: [...edges.values()].sort((left, right) => (`${left.from}>${left.to}` < `${right.from}>${right.to}` ? -1 : 1)), unresolved };
}

export type TraceDirection = 'UPSTREAM' | 'DOWNSTREAM';
export interface Trace {
  root: string;
  direction: TraceDirection;
  nodes: DeclaredNode[];
  edges: DeclaredEdge[];
  /** Each root-to-end path as the ids in order, root first (the lines of the explorer). */
  paths: string[][];
}

export const TRACE_MAX_DEPTH = 6;

/** The nodes and edges reached from one node, upstream (where it comes from) or downstream (what it feeds), to a depth; null when the node is not in the graph. */
export function traceLineage(graph: DeclaredLineage, root: string, direction: TraceDirection, depth: number = TRACE_MAX_DEPTH): Trace | null {
  if (!graph.nodes.some((one) => one.id === root)) return null;
  const limit = Math.max(1, Math.min(depth, TRACE_MAX_DEPTH));
  const next = (from: string): DeclaredEdge[] => graph.edges.filter((one) => (direction === 'UPSTREAM' ? one.to === from : one.from === from));
  const seen = new Set<string>([root]);
  const used = new Map<string, DeclaredEdge>();
  const paths: string[][] = [];
  const walk = (current: string, path: string[], level: number): void => {
    const onward = level >= limit ? [] : next(current);
    if (onward.length === 0) {
      if (path.length > 1) paths.push(path);
      return;
    }
    for (const one of onward) {
      const other = direction === 'UPSTREAM' ? one.from : one.to;
      // A graph made of the declarations has no cycles; a path never visits a node twice all the same.
      if (path.includes(other)) continue;
      seen.add(other);
      used.set(`${one.from}>${one.to}>${one.relation}`, one);
      walk(other, [...path, other], level + 1);
    }
  };
  walk(root, [root], 0);
  return { root, direction, nodes: graph.nodes.filter((one) => seen.has(one.id)), edges: [...used.values()], paths };
}
