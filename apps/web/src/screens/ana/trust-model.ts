import { isRecord, list, nullableNumber, nullableText, text, toInfo } from './common';
import type { AnaInfo } from './common';

export const FRESHNESS_STATUSES = ['FRESH', 'DUE', 'STALE', 'NO_DATA'] as const;
export type FreshnessStatus = (typeof FRESHNESS_STATUSES)[number];
export const SCORE_BANDS = ['GOOD', 'FAIR', 'POOR'] as const;
export type ScoreBand = (typeof SCORE_BANDS)[number];
export const NODE_KINDS = ['MODULE', 'TABLE', 'DATASET', 'METRIC', 'KPI'] as const;
export type NodeKind = (typeof NODE_KINDS)[number];

export interface DatasetFreshness {
  code: string;
  title: string;
  module: string;
  builtAt: string | null;
  asOfPeriod: string | null;
  qualityBadge: string | null;
  certification: string | null;
  status: FreshnessStatus;
  ageHours: number | null;
  slaHours: number;
  overdueHours: number | null;
  nullReason: string | null;
  slaVersion: string;
  unverified: boolean;
}
export interface FreshnessReading {
  asOf: string;
  datasets: DatasetFreshness[];
  staleCount: number;
  noDataCount: number;
  info: AnaInfo | undefined;
}
export interface Dimension {
  code: string;
  weight: number;
  score: number | null;
  nullReason: string | null;
}
export interface ScoreRow {
  composite: number | null;
  band: ScoreBand | null;
  nullReason: string | null;
  usedDimensions: number;
  dimensions: Dimension[];
}
export interface ModuleScore extends ScoreRow {
  module: string;
  datasets: string[];
}
export interface UnitScore extends ScoreRow {
  unitId: string;
  code: string;
  name: string;
}
export interface Scorecard {
  asOf: string;
  unitAsOfDate: string | null;
  modules: ModuleScore[];
  units: UnitScore[];
  moduleInfo: AnaInfo | undefined;
  unitInfo: AnaInfo | undefined;
}

const statusOf = (raw: unknown): FreshnessStatus => FRESHNESS_STATUSES.find((one) => one === raw) ?? 'NO_DATA';
const bandOf = (raw: unknown): ScoreBand | null => SCORE_BANDS.find((one) => one === raw) ?? null;

export function toFreshness(raw: unknown): FreshnessReading | undefined {
  if (!isRecord(raw) || !Array.isArray(raw.datasets)) return undefined;
  return {
    asOf: text(raw.as_of),
    staleCount: nullableNumber(raw.stale_count) ?? 0,
    noDataCount: nullableNumber(raw.no_data_count) ?? 0,
    info: toInfo(raw.info),
    datasets: raw.datasets.flatMap((one) => {
      if (!isRecord(one) || !isRecord(one.freshness) || text(one.code) === '') return [];
      const freshness = one.freshness;
      return [
        {
          code: text(one.code),
          title: text(one.title),
          module: text(one.module),
          builtAt: nullableText(one.built_at),
          asOfPeriod: nullableText(one.as_of_period),
          qualityBadge: nullableText(one.quality_badge),
          certification: nullableText(one.certification),
          status: statusOf(freshness.status),
          ageHours: nullableNumber(freshness.age_hours),
          slaHours: nullableNumber(freshness.sla_hours) ?? 0,
          overdueHours: nullableNumber(freshness.overdue_hours),
          nullReason: nullableText(freshness.null_reason),
          slaVersion: text(one.sla_version),
          unverified: one.unverified === true,
        },
      ];
    }),
  };
}

function toRow(raw: Record<string, unknown>): ScoreRow {
  return {
    composite: nullableNumber(raw.composite),
    band: bandOf(raw.band),
    nullReason: nullableText(raw.null_reason),
    usedDimensions: nullableNumber(raw.used_dimensions) ?? 0,
    dimensions: list(raw.dimensions).flatMap((one) => (isRecord(one) && text(one.code) !== '' ? [{ code: text(one.code), weight: nullableNumber(one.weight) ?? 0, score: nullableNumber(one.score), nullReason: nullableText(one.null_reason) }] : [])),
  };
}

export function toScorecard(raw: unknown): Scorecard | undefined {
  if (!isRecord(raw) || !Array.isArray(raw.modules) || !Array.isArray(raw.units)) return undefined;
  return {
    asOf: text(raw.as_of),
    unitAsOfDate: nullableText(raw.unit_as_of_date),
    modules: raw.modules.flatMap((one) => (isRecord(one) && text(one.module) !== '' ? [{ ...toRow(one), module: text(one.module), datasets: list(one.datasets).filter((code): code is string => typeof code === 'string') }] : [])),
    units: raw.units.flatMap((one) => (isRecord(one) && text(one.unit_id) !== '' ? [{ ...toRow(one), unitId: text(one.unit_id), code: text(one.code), name: text(one.name) }] : [])),
    moduleInfo: toInfo(raw.module_info),
    unitInfo: toInfo(raw.unit_info),
  };
}

export interface LineageNode {
  id: string;
  kind: NodeKind;
  key: string;
  label: string;
  module: string | null;
}
export interface LineageView {
  counts: { nodes: number; edges: number };
  catalogue: Array<{ kind: NodeKind; nodes: Array<Omit<LineageNode, 'kind'>> }>;
  trace: { root: string; direction: 'UPSTREAM' | 'DOWNSTREAM'; nodes: LineageNode[]; paths: string[][] } | null;
  unresolved: Array<{ kind: string; key: string }>;
}

const kindOf = (raw: unknown): NodeKind | undefined => NODE_KINDS.find((one) => one === raw);

export function toLineage(raw: unknown): LineageView | undefined {
  if (!isRecord(raw) || !isRecord(raw.counts) || !Array.isArray(raw.catalogue)) return undefined;
  const trace = isRecord(raw.trace) ? raw.trace : null;
  return {
    counts: { nodes: nullableNumber(raw.counts.nodes) ?? 0, edges: nullableNumber(raw.counts.edges) ?? 0 },
    catalogue: raw.catalogue.flatMap((group) => {
      const kind = isRecord(group) ? kindOf(group.kind) : undefined;
      return isRecord(group) && kind !== undefined ? [{ kind, nodes: list(group.nodes).flatMap((one) => (isRecord(one) && text(one.id) !== '' ? [{ id: text(one.id), key: text(one.key), label: text(one.label), module: nullableText(one.module) }] : [])) }] : [];
    }),
    trace:
      trace === null
        ? null
        : {
            root: text(trace.root),
            direction: trace.direction === 'DOWNSTREAM' ? 'DOWNSTREAM' : 'UPSTREAM',
            nodes: list(trace.nodes).flatMap((one) => {
              const kind = isRecord(one) ? kindOf(one.kind) : undefined;
              return isRecord(one) && kind !== undefined ? [{ id: text(one.id), kind, key: text(one.key), label: text(one.label), module: nullableText(one.module) }] : [];
            }),
            paths: list(trace.paths).flatMap((path) => (Array.isArray(path) ? [path.filter((id): id is string => typeof id === 'string')] : [])),
          },
    unresolved: list(raw.unresolved).flatMap((one) => (isRecord(one) ? [{ kind: text(one.kind), key: text(one.key) }] : [])),
  };
}

export const FRESHNESS_PATH = '/bi/bi-23';
export const LINEAGE_PATH = '/bi/bi-24';
