import { ApiError } from '@machvon/api-client';

export const BUILD_PERMISSION = 'bi.dataset.build';
export const MODEL_PATH = '/bi/bi-07';
export const VERSIONS_PATH = '/bi/bi-18';
export const DGV_CATALOGUE_PATH = '/dgv/dgv-04';

export const BADGES = ['NOT_ASSESSED', 'PASSED', 'WARNING', 'FAILED', 'STALE'] as const;
export type Badge = (typeof BADGES)[number];
export const VERSION_STATUSES = ['BUILDING', 'FROZEN', 'SUPERSEDED', 'FAILED'] as const;
export type VersionStatus = (typeof VERSION_STATUSES)[number];

type Raw = Record<string, unknown>;
const asRecord = (value: unknown): Raw | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Raw) : undefined);
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const nullableText = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const whole = (value: unknown): number | undefined => (typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined);
const includes = <T extends string>(list: readonly T[], value: string | undefined): value is T => value !== undefined && (list as readonly string[]).includes(value);

export interface Join {
  from: string;
  to: string;
}

export interface Dataset {
  id: string;
  code: string;
  title: string;
  sourceKind: string;
  grain: string;
  /** The dimensions the dataset offers and the joins that were approved for it: nothing else is reachable through it. */
  dimensions: string[];
  joins: Join[];
  dgvDatasetId: string | null;
  refreshPolicy: string;
  classification: string;
  status: string;
  latest: { asOfPeriod: string; badge: Badge; builtAt: string } | null;
}

/** A dataset as the screens read it; an entry that lacks what they need is left out, never guessed. */
export function toDataset(raw: unknown): Dataset | undefined {
  const row = asRecord(raw);
  const id = text(row?.id);
  const code = text(row?.dataset_code);
  if (row === undefined || id === undefined || code === undefined) return undefined;
  const paths = asRecord(row.join_paths);
  const latest = asRecord(row.latest_version);
  const badge = text(latest?.quality_badge);
  return {
    id,
    code,
    title: text(row.title) ?? code,
    sourceKind: text(row.source_kind) ?? '',
    grain: text(row.grain) ?? '',
    dimensions: Array.isArray(paths?.dimensions) ? paths.dimensions.filter((item): item is string => typeof item === 'string') : [],
    joins: Array.isArray(paths?.joins)
      ? paths.joins.flatMap((item) => {
          const join = asRecord(item);
          const from = text(join?.from);
          const to = text(join?.to);
          return from === undefined || to === undefined ? [] : [{ from, to }];
        })
      : [],
    dgvDatasetId: nullableText(row.dgv_dataset_id),
    refreshPolicy: text(row.refresh_policy) ?? '',
    classification: text(row.classification) ?? '',
    status: text(row.status) ?? '',
    latest: latest === undefined || text(latest.as_of_period) === undefined || !includes(BADGES, badge) ? null : { asOfPeriod: text(latest.as_of_period) as string, badge, builtAt: text(latest.built_at) ?? '' },
  };
}

export interface DatasetVersion {
  id: string;
  datasetId: string;
  asOfPeriod: string;
  sourceSnapshotId: string | null;
  builtAt: string;
  rowCount: number;
  /** At least this many rows feed certified figures: DGV adds up what each rule quarantined, so a row two rules quarantined is counted twice in the rows left out. */
  certifiedRowCountMin: number;
  excludedQuarantineRows: number;
  badge: Badge;
  qualityRunId: string | null;
  feedsCertified: boolean;
  status: VersionStatus;
}

export function toVersion(raw: unknown): DatasetVersion | undefined {
  const row = asRecord(raw);
  const id = text(row?.id);
  const datasetId = text(row?.dataset_id);
  const period = text(row?.as_of_period);
  const badge = text(row?.quality_badge);
  const status = text(row?.status);
  const rowCount = whole(row?.row_count);
  if (row === undefined || id === undefined || datasetId === undefined || period === undefined || rowCount === undefined || !includes(BADGES, badge) || !includes(VERSION_STATUSES, status)) return undefined;
  const excluded = whole(row.excluded_quarantine_rows) ?? 0;
  return {
    id,
    datasetId,
    asOfPeriod: period,
    sourceSnapshotId: nullableText(row.source_snapshot_id),
    builtAt: text(row.built_at) ?? '',
    rowCount,
    certifiedRowCountMin: whole(row.certified_row_count_min) ?? Math.max(0, rowCount - excluded),
    excludedQuarantineRows: excluded,
    badge,
    qualityRunId: nullableText(row.quality_run_id),
    feedsCertified: row.feeds_certified !== false,
    status,
  };
}

const PERIOD = /^[0-9A-Za-z][0-9A-Za-z_.-]{3,19}$/;

/** What is wrong with the period typed to build, or nothing. */
export const periodProblem = (value: string): 'required' | 'invalid' | undefined => (value.trim() === '' ? 'required' : PERIOD.test(value.trim()) ? undefined : 'invalid');

export type BuildReason = 'running' | 'notFrozen' | 'invalid' | 'denied' | 'notFound' | 'session' | 'general';
const REASON_BY_CODE: Readonly<Record<string, BuildReason>> = {
  BUILD_ALREADY_RUNNING: 'running',
  SOURCE_SNAPSHOT_NOT_FROZEN: 'notFrozen',
  VALIDATION_FAILED: 'invalid',
  INVALID_REQUEST: 'invalid',
  SCOPE_DENIED: 'denied',
  PERMISSION_DENIED: 'denied',
  RESOURCE_NOT_FOUND: 'notFound',
  SESSION_EXPIRED: 'session',
};

/** Maps a refusal of the server to what the screen says; an unknown failure is the general message. */
export function describeBuildProblem(error: unknown): BuildReason {
  return error instanceof ApiError ? (REASON_BY_CODE[error.code] ?? 'general') : 'general';
}

/** The badge a text names, if it is one. */
export const badgeOf = (value: string | undefined): Badge | undefined => (includes(BADGES, value) ? value : undefined);
