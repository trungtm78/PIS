import { ApiError } from '@machvon/api-client';

/** DIS-26: the cross-total control of the disbursed money (G4-5). */
export const CONTROL_PATH = '/dis/dis-26';
export const SNAPSHOT_PATH = '/dis/dis-21';
export const READ_PERMISSION = 'disbursement.control.read';
export const EVALUATE_PERMISSION = 'disbursement.control.evaluate';

export const DIMENSIONS = ['UNIT', 'FUND', 'PROJECT'] as const;
export type Dimension = (typeof DIMENSIONS)[number];

const SIGNED = /^-?(0|[1-9][0-9]{0,23})$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

type Raw = Record<string, unknown>;
const asRecord = (value: unknown): Raw | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Raw) : undefined);
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const whole = (value: unknown): number | undefined => (typeof value === 'number' && Number.isInteger(value) ? value : undefined);
const signed = (value: unknown): string | undefined => (typeof value === 'string' && SIGNED.test(value) ? value : undefined);

export const controlLink = (snapshotId?: string): string => (snapshotId === undefined ? CONTROL_PATH : `${CONTROL_PATH}?${new URLSearchParams({ snapshot: snapshotId }).toString()}`);

export interface KeyAmount {
  key: string;
  label: string | null;
  vnd: string;
}

export interface DimensionView {
  totalVnd: string;
  keyCount: number;
  top: KeyAmount[];
  source: string;
  disagrees: boolean;
  /** The total less the reference of the two that agree; null when no two agree. */
  offsetVnd: string | null;
}

export interface ProjectGap {
  projectId: string;
  projectCode: string | null;
  snapshotVnd: string;
  ledgerVnd: string;
  gapVnd: string;
}

export interface Check {
  id: string | null;
  snapshotId: string;
  fiscalYear: number;
  treasuryCutoffDate: string;
  windowFrom: string;
  published: boolean;
  disagreeing: Dimension[];
  agreeing: Dimension[];
  unit: DimensionView;
  fund: DimensionView;
  project: DimensionView;
  unattributedFundVnd: string;
  projectGaps: ProjectGap[];
  origin: string | null;
  createdAt: string | null;
}

function toDimension(raw: unknown): DimensionView | undefined {
  const row = asRecord(raw);
  const total = signed(row?.total_vnd);
  const keyCount = whole(row?.key_count);
  if (row === undefined || total === undefined || keyCount === undefined) return undefined;
  return {
    totalVnd: total,
    keyCount,
    top: (Array.isArray(row.top) ? row.top : []).flatMap((entry) => {
      const key = asRecord(entry);
      const name = text(key?.key);
      const vnd = signed(key?.vnd);
      return key === undefined || name === undefined || vnd === undefined ? [] : [{ key: name, label: typeof key.label === 'string' ? key.label : null, vnd }];
    }),
    source: text(row.source) ?? '',
    disagrees: row.disagrees === true,
    offsetVnd: signed(row.offset_vnd) ?? null,
  };
}

const dimensions = (value: unknown): Dimension[] => (Array.isArray(value) ? value.flatMap((entry) => DIMENSIONS.find((candidate) => candidate === entry) ?? []) : []);

export function toCheck(raw: unknown): Check | undefined {
  const row = asRecord(raw);
  const snapshotId = text(row?.snapshot_id);
  const fiscalYear = whole(row?.fiscal_year);
  const cutoff = text(row?.treasury_cutoff_date);
  const from = text(row?.window_from);
  const unit = toDimension(row?.unit);
  const fund = toDimension(row?.fund);
  const project = toDimension(row?.project);
  const unattributed = signed(row?.unattributed_fund_vnd);
  if (row === undefined || snapshotId === undefined || fiscalYear === undefined || cutoff === undefined || !DAY.test(cutoff) || from === undefined || unit === undefined || fund === undefined || project === undefined || typeof row.published !== 'boolean') return undefined;
  return {
    id: text(row.id) ?? null,
    snapshotId,
    fiscalYear,
    treasuryCutoffDate: cutoff,
    windowFrom: from,
    published: row.published,
    disagreeing: dimensions(row.disagreeing),
    agreeing: dimensions(row.agreeing),
    unit,
    fund,
    project,
    unattributedFundVnd: unattributed ?? '0',
    projectGaps: (Array.isArray(row.project_gaps) ? row.project_gaps : []).flatMap((entry) => {
      const gap = asRecord(entry);
      const projectId = text(gap?.project_id);
      const snapshotVnd = signed(gap?.snapshot_vnd);
      const ledgerVnd = signed(gap?.ledger_vnd);
      const gapVnd = signed(gap?.gap_vnd);
      return gap === undefined || projectId === undefined || snapshotVnd === undefined || ledgerVnd === undefined || gapVnd === undefined ? [] : [{ projectId, projectCode: typeof gap.project_code === 'string' ? gap.project_code : null, snapshotVnd, ledgerVnd, gapVnd }];
    }),
    origin: text(row.origin) ?? null,
    createdAt: text(row.created_at) ?? null,
  };
}

export interface SnapshotHead {
  id: string;
  kind: string;
  status: string;
  cutoffDate: string;
  periodId: string;
}

export interface Control {
  snapshot: SnapshotHead;
  live: Check;
  recorded: Check | null;
  history: Check[];
  formula: string;
  asOf: string;
}

export function toControl(value: unknown): Control | undefined {
  const row = asRecord(value);
  const snapshot = asRecord(row?.snapshot);
  const id = text(snapshot?.id);
  const live = toCheck(row?.live);
  if (row === undefined || snapshot === undefined || id === undefined || live === undefined) return undefined;
  return {
    snapshot: { id, kind: text(snapshot.snapshot_kind) ?? '', status: text(snapshot.status) ?? '', cutoffDate: text(snapshot.treasury_cutoff_date) ?? '', periodId: text(snapshot.period_id) ?? '' },
    live,
    recorded: toCheck(row.recorded) ?? null,
    history: (Array.isArray(row.history) ? row.history : []).flatMap((entry) => toCheck(entry) ?? []),
    formula: text(row.formula) ?? '',
    asOf: text(row.as_of) ?? '',
  };
}

/** One snapshot of the list the screen offers. */
export function toSnapshotHead(raw: unknown): SnapshotHead | undefined {
  const row = asRecord(raw);
  const id = text(row?.id);
  const status = text(row?.status);
  if (row === undefined || id === undefined || status === undefined) return undefined;
  return { id, kind: text(row.snapshot_kind) ?? '', status, cutoffDate: text(row.treasury_cutoff_date) ?? '', periodId: text(row.period_id) ?? '' };
}

export function toSnapshotHeads(value: unknown): SnapshotHead[] {
  const row = asRecord(value);
  return (Array.isArray(row?.items) ? row.items : []).flatMap((item) => toSnapshotHead(item) ?? []);
}

export interface CheckAnswer {
  id: string;
  published: boolean;
  disagreeing: Dimension[];
}

export function toCheckAnswer(value: unknown): CheckAnswer | undefined {
  const row = asRecord(value);
  const id = text(row?.resource_id);
  if (row === undefined || id === undefined || typeof row.published !== 'boolean') return undefined;
  return { id, published: row.published, disagreeing: dimensions(row.disagreeing) };
}

export type ControlProblem = 'denied' | 'notFound' | 'validation' | 'general';

export function describeControl(error: unknown): ControlProblem {
  if (!(error instanceof ApiError)) return 'general';
  switch (error.code) {
    case 'SCOPE_DENIED':
    case 'ENTITLEMENT_DENIED':
      return 'denied';
    case 'RESOURCE_NOT_FOUND':
      return 'notFound';
    case 'VALIDATION_FAILED':
      return 'validation';
    default:
      return error.status === 403 ? 'denied' : 'general';
  }
}

export const dimensionOf = (check: Check, dimension: Dimension): DimensionView => (dimension === 'UNIT' ? check.unit : dimension === 'FUND' ? check.fund : check.project);
