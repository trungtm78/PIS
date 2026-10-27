import { ApiError } from '@machvon/api-client';
import type { Tile } from './model';

type Raw = Record<string, unknown>;
const isRecord = (value: unknown): value is Raw => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const nullableText = (value: unknown): string | null => (typeof value === 'string' ? value : null);

export const DRILL_LEVELS = ['SCOPE', 'UNIT', 'PROJECT', 'CELL'] as const;
export type DrillLevel = (typeof DRILL_LEVELS)[number];
export const DRILL_DIMENSIONS = ['unit', 'project', 'cell'] as const;
export type DrillDimension = (typeof DRILL_DIMENSIONS)[number];

const oneOf = <T extends string>(value: unknown, allowed: readonly T[]): T | undefined => (typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : undefined);

export interface DrillChild {
  dimension: DrillDimension;
  id: string;
  code: string;
  name: string;
  value: string | null;
  numerator: string | null;
  denominator: string | null;
  nullReason: string | null;
  contextToken: string;
}

export type DrillSource =
  | { kind: 'REPORT_REVISION'; id: string; revision: number; status: string; submittedAt: string | null; acceptedAt: string | null }
  | { kind: 'TREASURY_TRANSACTION'; id: string; externalId: string; amountVnd: string; contributionVnd: string; confirmedAt: string; reversalOfId: string | null };

export interface DrillExclusion {
  id: string | null;
  code: string;
  reason: string | null;
}

export interface Drill {
  /** The same step, renewed under the scope of the reader as it is now: what a refresh adopts. */
  contextToken: string;
  metricCode: string;
  level: DrillLevel;
  snapshotId: string;
  asOfDate: string;
  treasuryCutoffDate: string;
  definitionStatus: string;
  scopeChanged: boolean;
  /** The scope the reader was read in: pages of one reading name the same one. */
  scopeHash: string;
  scope: { unitName: string | null; projectCode: string | null; projectName: string | null };
  formula: string;
  unit: 'PERCENT' | 'VND';
  value: string | null;
  numerator: string | null;
  denominator: string | null;
  nullReason: string | null;
  dimension: DrillDimension | null;
  dimensions: DrillDimension[];
  exclusions: DrillExclusion[];
  children: DrillChild[];
  reconcilesToParent: boolean;
  nonAdditiveReason: string | null;
  sources: DrillSource[];
  nextCursor: string | null;
}

function toChild(raw: unknown): DrillChild | undefined {
  if (!isRecord(raw)) return undefined;
  const dimension = oneOf(raw.dimension, DRILL_DIMENSIONS);
  if (dimension === undefined || text(raw.id) === '' || text(raw.context_token) === '') return undefined;
  return { dimension, id: text(raw.id), code: text(raw.code), name: text(raw.name), value: nullableText(raw.value), numerator: nullableText(raw.numerator), denominator: nullableText(raw.denominator), nullReason: nullableText(raw.null_reason), contextToken: text(raw.context_token) };
}

function toSource(raw: unknown): DrillSource | undefined {
  if (!isRecord(raw) || text(raw.id) === '') return undefined;
  if (raw.kind === 'REPORT_REVISION') return { kind: 'REPORT_REVISION', id: text(raw.id), revision: typeof raw.revision === 'number' ? raw.revision : 0, status: text(raw.status), submittedAt: nullableText(raw.submitted_at), acceptedAt: nullableText(raw.accepted_at) };
  if (raw.kind === 'TREASURY_TRANSACTION') return { kind: 'TREASURY_TRANSACTION', id: text(raw.id), externalId: text(raw.external_id), amountVnd: text(raw.amount_vnd), contributionVnd: text(raw.contribution_vnd) === '' ? text(raw.amount_vnd) : text(raw.contribution_vnd), confirmedAt: text(raw.confirmed_at), reversalOfId: nullableText(raw.reversal_of_id) };
  return undefined;
}

/** A drill as the screen reads it, or undefined when it lacks what makes a figure citable: the snapshot, the day, the formula and the unit of measure (BR-HOME-01). */
export function toDrill(raw: unknown): Drill | undefined {
  if (!isRecord(raw) || !isRecord(raw.scope)) return undefined;
  const level = oneOf(raw.level, DRILL_LEVELS);
  const unit = raw.unit === 'PERCENT' || raw.unit === 'VND' ? raw.unit : undefined;
  if (level === undefined || unit === undefined || text(raw.snapshot_id) === '' || text(raw.as_of_date) === '' || text(raw.formula) === '' || text(raw.metric_code) === '') return undefined;
  return {
    contextToken: text(raw.context_token),
    metricCode: text(raw.metric_code),
    level,
    snapshotId: text(raw.snapshot_id),
    asOfDate: text(raw.as_of_date),
    treasuryCutoffDate: text(raw.treasury_cutoff_date),
    definitionStatus: text(raw.definition_status),
    scopeChanged: raw.scope_changed === true,
    scopeHash: text(raw.scope_hash),
    scope: { unitName: nullableText(raw.scope.unit_name), projectCode: nullableText(raw.scope.project_code), projectName: nullableText(raw.scope.project_name) },
    formula: text(raw.formula),
    unit,
    value: nullableText(raw.value),
    numerator: nullableText(raw.numerator),
    denominator: nullableText(raw.denominator),
    nullReason: nullableText(raw.null_reason),
    dimension: oneOf(raw.child_dimension, DRILL_DIMENSIONS) ?? null,
    dimensions: (Array.isArray(raw.child_dimensions) ? raw.child_dimensions : []).flatMap((entry) => oneOf(entry, DRILL_DIMENSIONS) ?? []),
    exclusions: (Array.isArray(raw.exclusions) ? raw.exclusions : []).flatMap((entry) => (isRecord(entry) ? [{ id: nullableText(entry.id), code: text(entry.code), reason: nullableText(entry.reason) }] : [])),
    children: (Array.isArray(raw.children) ? raw.children : []).flatMap((child) => toChild(child) ?? []),
    reconcilesToParent: raw.reconciles_to_parent === true,
    nonAdditiveReason: nullableText(raw.non_additive_reason),
    sources: (Array.isArray(raw.source_records) ? raw.source_records : []).flatMap((source) => toSource(source) ?? []),
    nextCursor: nullableText(raw.next_cursor),
  };
}

export type DrillProblem = 'denied' | 'expired' | 'invalid' | 'notFound' | 'general';

/** What a failure of the drill is: the right gone (403 SCOPE_DENIED), a token that is old (409), a token that is not valid (400, 422) or a snapshot that is not there (404). */
export function describeDrill(error: unknown): DrillProblem {
  if (!(error instanceof ApiError)) return 'general';
  switch (error.code) {
    case 'SCOPE_DENIED':
      return 'denied';
    case 'SNAPSHOT_EXPIRED':
      return 'expired';
    case 'INVALID_REQUEST':
    case 'VALIDATION_FAILED':
      return 'invalid';
    case 'RESOURCE_NOT_FOUND':
      return 'notFound';
    default:
      return 'general';
  }
}

export interface RefreshTarget {
  snapshotId: string;
  metricCode: string;
  unitId: string | null;
  /** The old token was below the tile of a unit with the units under it (a project, a cell, or the unit alone): a new token of the tile is of a wider place, and the page says so. */
  deeper: boolean;
}

/** Where an old token was of, as the server says it: the snapshot to ask for again, the metric, the unit, and whether the drill had gone below the unit (a new token of the tile is then of a higher level). */
export function refreshTargetOf(error: unknown): RefreshTarget | undefined {
  if (!(error instanceof ApiError) || error.code !== 'SNAPSHOT_EXPIRED') return undefined;
  const snapshotId = error.extensions.snapshot_id;
  const metricCode = error.extensions.metric_code;
  if (typeof snapshotId !== 'string' || typeof metricCode !== 'string') return undefined;
  const unitId = error.extensions.unit_id;
  return { snapshotId, metricCode, unitId: typeof unitId === 'string' ? unitId : null, deeper: typeof error.extensions.project_id === 'string' || error.extensions.unit_exact === true };
}

/** The token of the tile of a metric among the tiles of a reading of the center. */
export const tokenOfMetric = (tiles: readonly Pick<Tile, 'metricCode' | 'contextToken'>[], metricCode: string): string | undefined => tiles.find((tile) => tile.metricCode === metricCode)?.contextToken;

export interface Step {
  token: string;
  /** What the breadcrumb says of the step (the metric for the first, the name of the place for the others). */
  label: string;
}
