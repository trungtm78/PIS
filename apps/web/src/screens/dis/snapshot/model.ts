import { ApiError } from '@machvon/api-client';
import type { components } from '@machvon/contracts';

/** DIS-21: the close and freeze of the figures of a period (ST-DIS-009, DIS 3 F6). */
export const SNAPSHOT_PATH = '/dis/dis-21';
export const BUILD_PERMISSION = 'snapshot.build';
export const FREEZE_PERMISSION = 'snapshot.freeze';

type Raw = Record<string, unknown>;
const asRecord = (value: unknown): Raw | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Raw) : undefined);
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const whole = (value: unknown): number | undefined => (typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined);
const optionalText = (value: unknown): string | null => (typeof value === 'string' ? value : null);

export const SNAPSHOT_KINDS = ['PERIOD_CLOSE', 'ADHOC', 'MNE'] as const;
export type SnapshotKind = (typeof SNAPSHOT_KINDS)[number];
export const SNAPSHOT_STATUSES = ['BUILDING', 'FROZEN', 'SUPERSEDED', 'FAILED'] as const;
export type SnapshotStatus = (typeof SNAPSHOT_STATUSES)[number];
export const DEFINITION_STATUSES = ['PROPOSED_PENDING_SIGNOFF', 'SIGNED'] as const;
export type DefinitionStatus = (typeof DEFINITION_STATUSES)[number];

export interface SnapshotView {
  id: string;
  periodId: string;
  kind: SnapshotKind;
  status: SnapshotStatus;
  asOfDate: string;
  cutoffDate: string;
  definitionStatus: DefinitionStatus;
  rowCount: number;
  payloadSha256: string | null;
  frozenAt: string | null;
  supersedesId: string | null;
  createdAt: string;
  version: number;
}

export function toSnapshot(raw: unknown): SnapshotView | undefined {
  const row = asRecord(raw);
  const id = text(row?.id);
  const periodId = text(row?.period_id);
  const kind = SNAPSHOT_KINDS.find((candidate) => candidate === row?.snapshot_kind);
  const status = SNAPSHOT_STATUSES.find((candidate) => candidate === row?.status);
  const definition = DEFINITION_STATUSES.find((candidate) => candidate === row?.definition_status);
  const cutoff = text(row?.treasury_cutoff_date);
  const asOf = text(row?.as_of_date);
  const rows = whole(row?.row_count);
  const version = whole(row?.version);
  if (row === undefined || id === undefined || periodId === undefined || kind === undefined || status === undefined || definition === undefined || cutoff === undefined || asOf === undefined || rows === undefined || version === undefined) return undefined;
  return {
    id,
    periodId,
    kind,
    status,
    asOfDate: asOf,
    cutoffDate: cutoff,
    definitionStatus: definition,
    rowCount: rows,
    payloadSha256: optionalText(row.payload_sha256),
    frozenAt: optionalText(row.frozen_at),
    supersedesId: optionalText(row.supersedes_id),
    createdAt: text(row.created_at) ?? '',
    version,
  };
}

/** A report that was handed in and is not accepted: what a snapshot leaves out. */
export interface PendingReport {
  reportId: string;
  projectCode: string;
  revision: number;
  status: string;
}

export interface SnapshotList {
  items: SnapshotView[];
  pending: PendingReport[];
}

export function toSnapshotList(raw: unknown): SnapshotList {
  const row = asRecord(raw);
  const items = (Array.isArray(row?.items) ? row.items : []).flatMap((item) => toSnapshot(item) ?? []);
  const pending = (Array.isArray(row?.pending_reports) ? row.pending_reports : []).flatMap((item): PendingReport[] => {
    const report = asRecord(item);
    const reportId = text(report?.report_id);
    const code = text(report?.project_code);
    const revision = whole(report?.revision);
    const status = text(report?.status);
    return report === undefined || reportId === undefined || code === undefined || revision === undefined || status === undefined ? [] : [{ reportId, projectCode: code, revision, status }];
  });
  return { items, pending };
}

/** One line of a snapshot: a project in a cell of the report, with the plan, the two figures of disbursement and the two rates. A figure nobody has is null, never zero. */
export interface SnapshotLineView {
  id: string;
  projectCode: string;
  bucket: string;
  budgetLevel: string;
  planPmVnd: string;
  planLocalVnd: string;
  planTotalVnd: string;
  treasuryVnd: string | null;
  reportedVnd: string | null;
  deltaVnd: string | null;
  ctmtqgVnd: string | null;
  ratePmPct: string | null;
  rateTotalPct: string | null;
  rateNullReason: string | null;
  coverage: string;
}

export function toSnapshotLine(raw: unknown): SnapshotLineView | undefined {
  const row = asRecord(raw);
  const id = text(row?.id);
  const code = text(row?.project_code);
  const bucket = text(row?.bucket);
  const level = text(row?.budget_level);
  const pm = text(row?.plan_pm_assigned_vnd);
  const local = text(row?.plan_local_added_vnd);
  const total = text(row?.plan_total_vnd);
  const coverage = text(row?.treasury_coverage);
  if (row === undefined || id === undefined || code === undefined || bucket === undefined || level === undefined || pm === undefined || local === undefined || total === undefined || coverage === undefined) return undefined;
  return {
    id,
    projectCode: code,
    bucket,
    budgetLevel: level,
    planPmVnd: pm,
    planLocalVnd: local,
    planTotalVnd: total,
    treasuryVnd: optionalText(row.disbursed_treasury_vnd),
    reportedVnd: optionalText(row.disbursed_reported_vnd),
    deltaVnd: optionalText(row.period_delta_vnd),
    ctmtqgVnd: optionalText(row.ctmtqg_subset_vnd),
    ratePmPct: optionalText(row.rate_pm_pct),
    rateTotalPct: optionalText(row.rate_total_pct),
    rateNullReason: optionalText(row.rate_null_reason),
    coverage,
  };
}

export interface LinesPage {
  snapshot: SnapshotView | undefined;
  items: SnapshotLineView[];
  nextCursor: string | undefined;
}

export function toLinesPage(raw: unknown): LinesPage {
  const row = asRecord(raw);
  return { snapshot: toSnapshot(row?.snapshot), items: (Array.isArray(row?.items) ? row.items : []).flatMap((item) => toSnapshotLine(item) ?? []), nextCursor: text(row?.next_cursor) };
}

type Mode = 'FULL' | 'READ_ONLY' | undefined;
const holds = (permissions: readonly string[] | undefined, permission: string, mode: Mode): boolean => (permissions === undefined || permissions.includes(permission)) && mode !== 'READ_ONLY';
export const canBuild = (permissions: readonly string[] | undefined, mode: Mode): boolean => holds(permissions, BUILD_PERMISSION, mode);
export const canFreeze = (permissions: readonly string[] | undefined, mode: Mode): boolean => holds(permissions, FREEZE_PERMISSION, mode);

/** A snapshot that was built and not frozen: the only one that can be frozen. */
export const isFreezable = (snapshot: SnapshotView): boolean => snapshot.status === 'BUILDING';
/** The first eight characters of the hash, what the list shows; the whole hash is in the title of the cell. */
export const shortHash = (hash: string | null): string => (hash === null ? '' : hash.slice(0, 8));

export type SnapshotRequest = components['schemas']['DisSnapshotRequest'];
export const buildRequest = (periodId: string, kind: SnapshotKind, cutoffDate: string): SnapshotRequest => ({ period_id: periodId, snapshot_kind: kind, treasury_cutoff_date: cutoffDate });

export type SnapshotProblem = 'frozen' | 'notBuilt' | 'inProgress' | 'periodOpen' | 'versionConflict' | 'scopeDenied' | 'validation' | 'notFound' | 'general';

const PROBLEM_BY_CODE: Readonly<Record<string, SnapshotProblem>> = {
  SNAPSHOT_FROZEN: 'frozen',
  SNAPSHOT_NOT_BUILT: 'notBuilt',
  SNAPSHOT_BUILD_IN_PROGRESS: 'inProgress',
  PERIOD_STATE_INVALID: 'periodOpen',
  VERSION_CONFLICT: 'versionConflict',
  SCOPE_DENIED: 'scopeDenied',
  VALIDATION_FAILED: 'validation',
  INVALID_REQUEST: 'validation',
  RESOURCE_NOT_FOUND: 'notFound',
};

export const describeSnapshot = (error: unknown): SnapshotProblem => (error instanceof ApiError ? (PROBLEM_BY_CODE[error.code] ?? 'general') : 'general');

/** The id of the snapshot a command answered with. */
export function snapshotIdOf(done: unknown): string | undefined {
  const id = asRecord(done)?.resource_id;
  return typeof id === 'string' ? id : undefined;
}
