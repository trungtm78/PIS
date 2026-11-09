import { ApiError } from '@machvon/api-client';
import { NONE, camel, money, percent } from '../funding/model';
import type { Money, Rate } from '../funding/model';

export { NONE, camel, money, percent };
export type { Money, Rate };

/**
 * DIS-32 and DIS-33 (ENT-3a, docs/ent-snapshot.md): the enterprise period snapshot as the API gives it. The shapes are read defensively (a wrong shape is an error of the read, never an empty screen); money is whole
 * dong as text and is never turned into a number; a figure nobody has is `null` and is written as a dash, never as zero.
 */
export const BUILD_PERMISSION = 'funding.snapshot.build';
export const FREEZE_PERMISSION = 'funding.snapshot.freeze';
export const READ_PERMISSION = 'funding.snapshot.read';
export const BUILD_PATH = '/dis/dis-32';
export const DETAIL_PATH = '/dis/dis-33';
/** The screen that asks for a locked period to be reopened (DIS-22): a frozen snapshot is rebuilt only after an approved reopening. */
export const REOPEN_PATH = '/dis/dis-22';

export const SNAPSHOT_STATUSES = ['BUILDING', 'FROZEN', 'SUPERSEDED', 'FAILED'] as const;
export type SnapshotStatus = (typeof SNAPSHOT_STATUSES)[number];

export interface MissingCell {
  class_code: string;
  tier_code: string;
  measure: string;
  months: number[];
}

export interface MissingProject {
  project_id: string;
  project_code: string;
  cells: MissingCell[];
}

export interface MissingUnit {
  unit_id: string;
  unit_code: string;
  projects: MissingProject[];
}

export interface WaitingBatch {
  project_id: string;
  project_code: string;
  batch_id: string;
}

export interface Readiness {
  period: { id: string; code: string; status: string; grain: string; plan_year: number; ordinal: number };
  pack: { code: string; version: number; unverified: boolean };
  complete: boolean;
  planned_cells: number;
  projects: number;
  missing_units: MissingUnit[];
  waiting_batches: WaitingBatch[];
  frozen: { id: string; revision: number; payload_sha256: string } | null;
  rebuild_allowed: boolean;
  actions: { build: boolean };
}

export interface Snapshot {
  id: string;
  period_id: string;
  period_code: string;
  status: SnapshotStatus;
  revision: number;
  version: number;
  payload_sha256: string | null;
  taxonomy_pack: string;
  taxonomy_version?: number;
  hash_schema?: number;
  definition_status?: string;
  row_count: number;
  figure_count?: number;
  indicator_count?: number;
  as_of_at?: string;
  as_of_date?: string;
  supersedes_id?: string | null;
  frozen_by?: string | null;
  frozen_at?: string | null;
  created_at?: string;
  created_by?: string;
}

export interface UnitRow {
  unit_id: string;
  unit_code: string;
  unit_name: string;
  projects: number;
  money: Money[];
  rates: Rate[];
}

export interface ProjectRow {
  project_id: string;
  project_code: string;
  project_name: string;
  unit_id: string;
  unit_code: string;
  tmdt_in_force_vnd: string | null;
  money: Money[];
  rates: Rate[];
}

export interface ClassRow {
  class_code: string;
  money: Money[];
}

export interface IndicatorRow {
  project_code: string;
  unit_code: string;
  indicator_code: string;
  value: string;
  unit: string;
  revision: number;
}

export interface LineageRow {
  id: string;
  revision: number;
  status: SnapshotStatus;
  payload_sha256: string | null;
  frozen_at: string | null;
  supersedes_id: string | null;
}

export interface SnapshotDetail {
  snapshot: Snapshot;
  period: { grain: string; plan_year: number; ordinal: number; start: string; end: string; code: string };
  pack: { code: string; label: string; version: number; measures: string[]; classes: Array<{ code: string; label: string; additive: boolean }> };
  measure: string;
  partial: boolean;
  totals: { money: Money[]; by_class: ClassRow[]; rates: Rate[]; total_investment_vnd: string | null; rate_since_start: { ratePct: string | null; nullReason: string | null } };
  by_unit: UnitRow[];
  projects: ProjectRow[];
  indicators: IndicatorRow[];
  lineage: LineageRow[];
  hash_verified: boolean | null;
  actions: { build: boolean; freeze: boolean };
  as_of: string;
}

const asRecord = (value: unknown): Record<string, unknown> | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined);

function toSnapshot(raw: unknown): Snapshot {
  const body = asRecord(raw);
  if (body === undefined || typeof body.id !== 'string' || typeof body.status !== 'string' || typeof body.revision !== 'number' || typeof body.version !== 'number') throw new Error('unexpected snapshot');
  return body as unknown as Snapshot;
}

export function toSnapshots(raw: unknown): Snapshot[] {
  const body = asRecord(raw);
  if (body === undefined || !Array.isArray(body.items)) throw new Error('unexpected snapshots');
  return body.items.map(toSnapshot);
}

export function toReadiness(raw: unknown): Readiness {
  const body = asRecord(raw);
  if (body === undefined || asRecord(body.period) === undefined || asRecord(body.pack) === undefined || typeof body.complete !== 'boolean' || !Array.isArray(body.missing_units) || !Array.isArray(body.waiting_batches) || asRecord(body.actions) === undefined) {
    throw new Error('unexpected readiness');
  }
  return body as unknown as Readiness;
}

export function toDetail(raw: unknown): SnapshotDetail {
  const body = asRecord(raw);
  const totals = asRecord(body?.totals);
  if (
    body === undefined || totals === undefined || asRecord(body.snapshot) === undefined || asRecord(body.period) === undefined || asRecord(body.actions) === undefined || !Array.isArray(totals.money) || !Array.isArray(totals.rates) || !Array.isArray(totals.by_class) ||
    !Array.isArray(body.by_unit) || !Array.isArray(body.projects) || !Array.isArray(body.indicators) || !Array.isArray(body.lineage)
  ) {
    throw new Error('unexpected snapshot detail');
  }
  toSnapshot(body.snapshot);
  return body as unknown as SnapshotDetail;
}

// ---- reading the figures -------------------------------------------------------------------------------------------------------------------------------------------

/** The columns of the money tables in the order of the form: what the plan said, what is expected, what happened. */
export const MONEY_COLUMNS = ['PLAN_YEAR', 'PLAN_ADJUSTED', 'PLAN_IN_FORCE', 'PLAN_PERIOD', 'ESTIMATE', 'ACTUAL', 'CUMULATIVE_YTD', 'CUMULATIVE_SINCE_START', 'REMAINING_YEAR'] as const;

/** The columns of the tables by unit and by project: the plan in force and what happened. */
export const SUMMARY_COLUMNS = ['PLAN_IN_FORCE', 'ACTUAL', 'CUMULATIVE_YTD', 'CUMULATIVE_SINCE_START'] as const;

/** The value of a money figure by its code, null when nobody has it (never zero). */
export const moneyOf = (figures: readonly Money[], code: string, classCode: string | null = null): string | null => figures.find((one) => one.code === code && one.class_code === classCode)?.value_vnd ?? null;

export const rateOf = (rates: readonly Rate[], code: string): Rate | undefined => rates.find((one) => one.code === code && one.class_code === null);
export const ratesOverall = (rates: readonly Rate[]): Rate[] => rates.filter((one) => one.class_code === null);
export const sharesOf = (rates: readonly Rate[]): Rate[] => rates.filter((one) => one.class_code !== null);

/** The first characters of a hash for a table; the whole hash is shown where it is the subject. */
export const shortHash = (hash: string | null | undefined): string => (hash === null || hash === undefined || hash === '' ? NONE : `${hash.slice(0, 12)}…`);

/** The months of a missing cell as a list ("1, 2, 3"). */
export const monthsText = (months: readonly number[]): string => months.join(', ');

/** The number of cells a list of missing units still lacks. */
export const missingCells = (units: readonly MissingUnit[]): number => units.reduce((total, unit) => total + unit.projects.reduce((sum, project) => sum + project.cells.length, 0), 0);

// ---- refusals ------------------------------------------------------------------------------------------------------------------------------------------------------------

export type ProblemKind = 'incomplete' | 'frozen' | 'notLocked' | 'self' | 'conflict' | 'notFound' | 'general';

const PROBLEM_BY_CODE: Readonly<Record<string, ProblemKind>> = {
  ENTERPRISE_SNAPSHOT_INCOMPLETE: 'incomplete',
  SNAPSHOT_FROZEN: 'frozen',
  PERIOD_STATE_INVALID: 'notLocked',
  SELF_APPROVAL_DENIED: 'self',
  VERSION_CONFLICT: 'conflict',
  RESOURCE_NOT_FOUND: 'notFound',
};

export const describeProblem = (error: unknown): ProblemKind => (error instanceof ApiError ? (PROBLEM_BY_CODE[error.code] ?? 'general') : 'general');

/** The units a refused build names (a top-level member of the problem); empty when the problem is another one or carries none. */
export function missingUnitsOf(error: unknown): MissingUnit[] {
  if (!(error instanceof ApiError) || error.code !== 'ENTERPRISE_SNAPSHOT_INCOMPLETE') return [];
  const units = error.extensions.missing_units;
  return Array.isArray(units) ? (units as MissingUnit[]) : [];
}

/** The batches that wait for acceptance, named by a refused build. */
export function waitingBatchesOf(error: unknown): WaitingBatch[] {
  if (!(error instanceof ApiError) || error.code !== 'ENTERPRISE_SNAPSHOT_INCOMPLETE') return [];
  const batches = error.extensions.waiting_batches;
  return Array.isArray(batches) ? (batches as WaitingBatch[]) : [];
}
