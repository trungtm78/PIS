import { toGraph } from '../dgv/lineage/model';
import type { Direction, LineageGraph } from '../dgv/lineage/model';

type Raw = Record<string, unknown>;
const isRecord = (value: unknown): value is Raw => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The quality of a version of a dataset on the way, as the lineage tells it (the badge and the rows the quarantine kept out), never a value of the data. */
export interface VersionQuality {
  badge: string;
  excludedRows: number;
}

/** The lineage of a metric: the graph, and the quality of the versions of the dataset the person sees on it, by the key of their node. A metric nothing was recorded about has a graph with no node. */
export interface MetricLineage {
  graph: LineageGraph;
  quality: Map<string, VersionQuality>;
}

export interface MetricLineageQuery {
  metricId: string;
  direction: Direction;
  depth: number;
}

export const EMPTY_LINEAGE_QUERY: MetricLineageQuery = { metricId: '', direction: 'upstream', depth: 3 };

export function toMetricLineage(raw: unknown): MetricLineage | undefined {
  if (!isRecord(raw)) return undefined;
  // A metric that was never read nor built from has no start: the graph is empty, and that is an answer.
  const graph = toGraph({ ...raw, start: typeof raw.start === 'string' ? raw.start : '' });
  if (graph === undefined) return undefined;
  const quality = new Map<string, VersionQuality>();
  if (isRecord(raw.quality)) {
    for (const [key, value] of Object.entries(raw.quality)) {
      if (isRecord(value) && typeof value.quality_badge === 'string')
        quality.set(key, { badge: value.quality_badge, excludedRows: typeof value.excluded_quarantine_rows === 'number' ? value.excluded_quarantine_rows : 0 });
    }
  }
  return { graph, quality };
}

/** The query of the read: the direction and the depth the person chose. */
export const lineageParams = (query: MetricLineageQuery): Record<string, string> => ({ direction: query.direction, depth: String(query.depth) });

/** A metric must be chosen before anything is asked. */
export const lineageNeedsMetric = (query: MetricLineageQuery): boolean => query.metricId === '';

/** Whether the graph has anything to show: the metric alone is a graph with no steps. */
export const hasSteps = (lineage: MetricLineage): boolean => lineage.graph.edges.length > 0;
