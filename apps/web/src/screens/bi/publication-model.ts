import { ApiError } from '@machvon/api-client';
import type { Dashboard, DashboardVersion, Widget } from './dashboard-model';

export const INBOX_PATH = '/bi/bi-11';
export const COMPARE_PATH = '/bi/bi-10';
export const PUBLISH_PERMISSION = 'bi.publish';
export const REQUEST_PERMISSION = 'bi.publish.request';

export const KINDS = ['METRIC', 'DASHBOARD', 'ACCESS_POLICY'] as const;
export type Kind = (typeof KINDS)[number];
export const STATUSES = ['PENDING', 'DECIDED', 'WITHDRAWN'] as const;
export type Status = (typeof STATUSES)[number];
export type Decision = 'APPROVED' | 'REJECTED';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Raw = Record<string, unknown>;
const isRecord = (value: unknown): value is Raw => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const nullableText = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const oneOf = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T => allowed.find((candidate) => candidate === value) ?? fallback;

export interface Check {
  code: string;
  passed: boolean;
}

export interface Person {
  id: string;
  name: string | null;
}

export interface PublicationRequest {
  id: string;
  kind: Kind;
  objectId: string;
  objectCode: string | null;
  objectRevision: number | null;
  requestedBy: Person;
  checks: Check[];
  status: Status;
  decision: Decision | null;
  decidedBy: Person | null;
  decidedAt: string | null;
  comment: string | null;
  createdAt: string;
  version: number;
}

const personOf = (raw: unknown): Person => (isRecord(raw) ? { id: text(raw.id), name: nullableText(raw.name) } : { id: '', name: null });

/** A request as the inbox lists it; a row without an id is dropped. */
export function toRequest(raw: unknown): PublicationRequest | undefined {
  if (!isRecord(raw) || typeof raw.id !== 'string') return undefined;
  return {
    id: raw.id,
    kind: oneOf(raw.object_kind, KINDS, 'METRIC'),
    objectId: text(raw.object_id),
    objectCode: nullableText(raw.object_code),
    objectRevision: typeof raw.object_revision === 'number' ? raw.object_revision : null,
    requestedBy: personOf(raw.requested_by),
    checks: Array.isArray(raw.checks) ? raw.checks.flatMap((check) => (isRecord(check) && typeof check.code === 'string' ? [{ code: check.code, passed: check.passed === true }] : [])) : [],
    status: oneOf(raw.status, STATUSES, 'PENDING'),
    decision: raw.decision === 'APPROVED' || raw.decision === 'REJECTED' ? raw.decision : null,
    decidedBy: raw.decided_by === null || raw.decided_by === undefined ? null : personOf(raw.decided_by),
    decidedAt: nullableText(raw.decided_at),
    comment: nullableText(raw.comment),
    createdAt: text(raw.created_at),
    version: typeof raw.version === 'number' ? raw.version : 1,
  };
}

// ---- the request and the decision --------------------------------------------------------------------------------------------------------

export interface RequestForm {
  kind: Kind;
  objectId: string;
}

export const EMPTY_REQUEST: RequestForm = { kind: 'METRIC', objectId: '' };

export type RequestProblem = 'required' | 'invalid';

export function validateRequest(form: RequestForm): {
  objectId?: RequestProblem;
} {
  const id = form.objectId.trim();
  if (id === '') return { objectId: 'required' };
  return UUID.test(id) ? {} : { objectId: 'invalid' };
}

export const requestBody = (form: RequestForm): { object_kind: Kind; object_id: string } => ({
  object_kind: form.kind,
  object_id: form.objectId.trim().toLowerCase(),
});

/** A rejection says why; an approval may say nothing. */
export const decisionProblem = (decision: Decision, comment: string): 'reasonRequired' | undefined => (decision === 'REJECTED' && comment.trim() === '' ? 'reasonRequired' : undefined);

export const decisionBody = (decision: Decision, comment: string): { decision: Decision; comment?: string } => (comment.trim() === '' ? { decision } : { decision, comment: comment.trim() });

// ---- what the server refused -------------------------------------------------------------------------------------------------------------

export type PublicationReason = 'self' | 'reproduction' | 'notCertified' | 'notFrozen' | 'pending' | 'conflict' | 'decided' | 'invalid' | 'scope' | 'notFound' | 'general';

const REASON_BY_CODE: Readonly<Record<string, PublicationReason>> = {
  SELF_APPROVAL_DENIED: 'self',
  REPRODUCIBILITY_CHECK_FAILED: 'reproduction',
  METRIC_NOT_CERTIFIED: 'notCertified',
  DATASET_VERSION_NOT_FROZEN: 'notFrozen',
  PUBLICATION_ALREADY_PENDING: 'pending',
  VERSION_CONFLICT: 'conflict',
  STAGE_TRANSITION_DENIED: 'decided',
  VALIDATION_FAILED: 'invalid',
  INVALID_REQUEST: 'invalid',
  SCOPE_DENIED: 'scope',
  RESOURCE_NOT_FOUND: 'notFound',
};

/** What the refusal is, and the name of the check or the field it points at (the server names the check that failed in the detail). */
export const describePublicationProblem = (error: unknown): { reason: PublicationReason; detail: string } =>
  error instanceof ApiError
    ? {
        reason: REASON_BY_CODE[error.code] ?? 'general',
        detail: error.detail ?? '',
      }
    : { reason: 'general', detail: '' };

// ---- the comparison of two versions of a dashboard ---------------------------------------------------------------------------------------

export type TileField = 'kind' | 'title' | 'metric' | 'dimension' | 'grid';

export interface TileChange {
  id: string;
  before: Widget;
  after: Widget;
  fields: TileField[];
}

export interface SettingChange {
  key: string;
  before: string | null;
  after: string | null;
}

export interface VersionDiff {
  tilesAdded: Widget[];
  tilesRemoved: Widget[];
  tilesChanged: TileChange[];
  metricsAdded: string[];
  metricsRemoved: string[];
  metricsKept: string[];
  settings: SettingChange[];
  same: boolean;
}

const gridKey = (widget: Widget): string => `${widget.grid.x},${widget.grid.y},${widget.grid.w},${widget.grid.h}`;

function changedFields(before: Widget, after: Widget): TileField[] {
  const fields: TileField[] = [];
  if (before.kind !== after.kind) fields.push('kind');
  if (before.title !== after.title) fields.push('title');
  if (before.metricVersionId !== after.metricVersionId) fields.push('metric');
  if (before.dimensionCode !== after.dimensionCode) fields.push('dimension');
  if (gridKey(before) !== gridKey(after)) fields.push('grid');
  return fields;
}

function settingsOf(version: DashboardVersion): Map<string, string> {
  const settings = new Map<string, string>([
    ['columns', String(version.columns)],
    ['policy', version.policy],
    ['pinned', [...version.pinnedDatasetVersionIds].sort().join(', ')],
  ]);
  for (const [key, value] of Object.entries(version.breakpoints)) settings.set(`breakpoint:${key}`, String(value));
  for (const [key, value] of Object.entries(version.filterMappings)) settings.set(`filter:${key}`, value);
  return settings;
}

/**
 * What changed from one version of a dashboard to another: the tiles added, removed and changed (a tile is the same one by its id), the metrics the versions name, and the settings (columns, breakpoints, filter
 * mappings, the policy for the datasets and the versions it pins). The versions are fixed once saved, so the comparison is of facts, never of edits in flight.
 */
export function compareVersions(older: DashboardVersion, newer: DashboardVersion): VersionDiff {
  const before = new Map(older.widgets.map((widget) => [widget.id, widget]));
  const after = new Map(newer.widgets.map((widget) => [widget.id, widget]));
  const tilesChanged: TileChange[] = [];
  for (const [id, current] of after) {
    const previous = before.get(id);
    if (previous === undefined) continue;
    const fields = changedFields(previous, current);
    if (fields.length > 0) tilesChanged.push({ id, before: previous, after: current, fields });
  }
  const oldMetrics = new Set(older.metricVersionIds);
  const newMetrics = new Set(newer.metricVersionIds);
  const oldSettings = settingsOf(older);
  const newSettings = settingsOf(newer);
  const settings: SettingChange[] = [];
  for (const key of [...new Set([...oldSettings.keys(), ...newSettings.keys()])].sort()) {
    const was = oldSettings.get(key) ?? null;
    const is = newSettings.get(key) ?? null;
    if (was !== is) settings.push({ key, before: was, after: is });
  }
  const diff = {
    tilesAdded: newer.widgets.filter((widget) => !before.has(widget.id)),
    tilesRemoved: older.widgets.filter((widget) => !after.has(widget.id)),
    tilesChanged,
    metricsAdded: newer.metricVersionIds.filter((id) => !oldMetrics.has(id)),
    metricsRemoved: older.metricVersionIds.filter((id) => !newMetrics.has(id)),
    metricsKept: newer.metricVersionIds.filter((id) => oldMetrics.has(id)),
    settings,
  };
  return {
    ...diff,
    same: diff.tilesAdded.length + diff.tilesRemoved.length + diff.tilesChanged.length + diff.metricsAdded.length + diff.metricsRemoved.length + settings.length === 0,
  };
}

/** Whether the person may ask to publish the version: the owner of the dashboard, and a draft that is the dashboard's. */
export const mayRequest = (dashboard: Dashboard, version: DashboardVersion): boolean => dashboard.mayEdit && version.status === 'DRAFT' && dashboard.status !== 'ARCHIVED';
