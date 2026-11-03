import { ApiError } from '@machvon/api-client';

/** The permissions of SAS-23 (x-permission of the operations in openapi.json): the System Admin writes, the registry readers look. */
export const MANAGE_PERMISSION = 'system.tenant.manage';
export const READ_PERMISSION = 'system.tenant.read';

export const MIN_REASON = 10;
export const MAX_REASON = 2000;
export const MIN_FREEZE_MINUTES = 5;
export const MAX_FREEZE_MINUTES = 240;
export const DEFAULT_FREEZE_MINUTES = 30;

export const STATUSES = ['Planned', 'Copying', 'Verifying', 'AwaitingCutover', 'CutoverFrozen', 'Switched', 'Completed', 'Aborted', 'RolledBack'] as const;
export type MigrationStatus = (typeof STATUSES)[number];

/** The way of a promotion that goes forward, in order; the two ends that are not on it (Aborted, RolledBack) are shown beside it. */
export const STEPS = ['Planned', 'Copying', 'Verifying', 'AwaitingCutover', 'CutoverFrozen', 'Switched', 'Completed'] as const;

export interface MigrationView {
  id: string;
  tenantId: string;
  fromPlacementId: string;
  toPlacementId: string;
  status: MigrationStatus;
  writeFreezeMaxMinutes: number;
  plannedWindowStart: string;
  reason: string;
  requestedBy: string;
  cutoverApprovedBy: string | undefined;
  cutoverApprovedAt: string | undefined;
  approvalReason: string | undefined;
  writeFreezeStartedAt: string | undefined;
  writeFrozenUntil: string | undefined;
  checksumMatch: boolean | undefined;
  verifiedAt: string | undefined;
  verificationReportRef: string | undefined;
  switchedAt: string | undefined;
  observationEndsAt: string | undefined;
  completedAt: string | undefined;
  endedAt: string | undefined;
  endedBy: string | undefined;
  endReason: string | undefined;
  lastErrorCode: string | undefined;
  sourcePurgeDueAt: string | undefined;
  createdAt: string;
  version: number;
}

export interface MoneyView {
  column: string;
  source: string | undefined;
  target: string | undefined;
  match: boolean;
}

export interface TableView {
  table: string;
  sourceRows: number | undefined;
  targetRows: number | undefined;
  rowsMatch: boolean;
  sourceChecksum: string | undefined;
  targetChecksum: string | undefined;
  checksumMatch: boolean;
  money: MoneyView[];
  moneyMatch: boolean;
  match: boolean;
}

export interface ReconciliationView {
  match: boolean;
  measuredAt: string;
  sourceRows: number;
  targetRows: number;
  mismatchedTables: string[];
  unreadableTables: string[];
  tables: TableView[];
}

export interface DetailView {
  migration: MigrationView;
  reconciliation: ReconciliationView | undefined;
}

export interface MigrationPage {
  items: MigrationView[];
  nextCursor: string | undefined;
}

export interface PlacementView {
  id: string;
  kind: 'POOL' | 'SILO';
  region: string;
  status: string;
  maxTenants: number | undefined;
  tenantCount: number;
  incomingMigrations: number;
  available: boolean;
}

type Raw = Record<string, unknown>;
const isRecord = (value: unknown): value is Raw => typeof value === 'object' && value !== null;
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const optional = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);
const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
const optionalCount = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);
const flag = (value: unknown): boolean | undefined => (typeof value === 'boolean' ? value : undefined);
const isStatus = (value: unknown): value is MigrationStatus => typeof value === 'string' && (STATUSES as readonly string[]).includes(value);

export function toMigration(raw: unknown): MigrationView | undefined {
  if (!isRecord(raw) || typeof raw.id !== 'string' || !isStatus(raw.status)) return undefined;
  return {
    id: raw.id,
    tenantId: text(raw.tenant_id),
    fromPlacementId: text(raw.from_placement_id),
    toPlacementId: text(raw.to_placement_id),
    status: raw.status,
    writeFreezeMaxMinutes: count(raw.write_freeze_max_minutes),
    plannedWindowStart: text(raw.planned_window_start),
    reason: text(raw.reason),
    requestedBy: text(raw.requested_by),
    cutoverApprovedBy: optional(raw.cutover_approved_by),
    cutoverApprovedAt: optional(raw.cutover_approved_at),
    approvalReason: optional(raw.approval_reason),
    writeFreezeStartedAt: optional(raw.write_freeze_started_at),
    writeFrozenUntil: optional(raw.write_frozen_until),
    checksumMatch: flag(raw.checksum_match),
    verifiedAt: optional(raw.verified_at),
    verificationReportRef: optional(raw.verification_report_ref),
    switchedAt: optional(raw.switched_at),
    observationEndsAt: optional(raw.observation_ends_at),
    completedAt: optional(raw.completed_at),
    endedAt: optional(raw.ended_at),
    endedBy: optional(raw.ended_by),
    endReason: optional(raw.end_reason),
    lastErrorCode: optional(raw.last_error_code),
    sourcePurgeDueAt: optional(raw.source_purge_due_at),
    createdAt: text(raw.created_at),
    version: typeof raw.version === 'number' ? raw.version : 1,
  };
}

export function toMigrationPage(raw: unknown): MigrationPage {
  const view: Raw = isRecord(raw) ? raw : {};
  return { items: Array.isArray(view.items) ? view.items.flatMap((item) => toMigration(item) ?? []) : [], nextCursor: optional(view.next_cursor) };
}

function toTable(raw: unknown): TableView | undefined {
  if (!isRecord(raw) || typeof raw.table !== 'string') return undefined;
  const money = Array.isArray(raw.money)
    ? raw.money.flatMap((entry): MoneyView[] => (isRecord(entry) && typeof entry.column === 'string' ? [{ column: entry.column, source: optional(entry.source), target: optional(entry.target), match: entry.match === true }] : []))
    : [];
  return {
    table: raw.table,
    sourceRows: optionalCount(raw.source_rows),
    targetRows: optionalCount(raw.target_rows),
    rowsMatch: raw.rows_match === true,
    sourceChecksum: optional(raw.source_checksum),
    targetChecksum: optional(raw.target_checksum),
    checksumMatch: raw.checksum_match === true,
    money,
    moneyMatch: raw.money_match === true,
    match: raw.match === true,
  };
}

const names = (value: unknown): string[] => (Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []);

export function toReconciliation(raw: unknown): ReconciliationView | undefined {
  if (!isRecord(raw) || !Array.isArray(raw.tables)) return undefined;
  return {
    match: raw.match === true,
    measuredAt: text(raw.measured_at),
    sourceRows: count(raw.source_rows),
    targetRows: count(raw.target_rows),
    mismatchedTables: names(raw.mismatched_tables),
    unreadableTables: names(raw.unreadable_tables),
    tables: raw.tables.flatMap((entry) => toTable(entry) ?? []),
  };
}

export function toDetail(raw: unknown): DetailView | undefined {
  if (!isRecord(raw)) return undefined;
  const migration = toMigration(raw.migration);
  return migration === undefined ? undefined : { migration, reconciliation: toReconciliation(raw.reconciliation) };
}

export function toPlacements(raw: unknown): PlacementView[] {
  const items = isRecord(raw) && Array.isArray(raw.items) ? raw.items : [];
  return items.flatMap((entry): PlacementView[] =>
    isRecord(entry) && typeof entry.id === 'string'
      ? [
          {
            id: entry.id,
            kind: entry.kind === 'POOL' ? 'POOL' : 'SILO',
            region: text(entry.region),
            status: text(entry.status),
            maxTenants: optionalCount(entry.max_tenants),
            tenantCount: count(entry.tenant_count),
            incomingMigrations: count(entry.incoming_migrations),
            available: entry.available === true,
          },
        ]
      : [],
  );
}

export const isOpen = (status: MigrationStatus): boolean => status !== 'Completed' && status !== 'Aborted' && status !== 'RolledBack';
/** An abort is offered for every migration that is not over. */
export const canAbort = isOpen;
/** The cutover waits for approval: the button is offered to the System Admin other than the one who started (the server judges it again and refuses the same person). */
export const canApprove = (migration: Pick<MigrationView, 'status'>): boolean => migration.status === 'AwaitingCutover';
export const startedByMe = (migration: Pick<MigrationView, 'requestedBy'>, membershipId: string | undefined): boolean => membershipId !== undefined && migration.requestedBy.toLowerCase() === membershipId.toLowerCase();
/** Whether the migration is moving quickly, so the screen reads it more often. */
export const isBusy = (status: MigrationStatus): boolean => status === 'Planned' || status === 'Copying' || status === 'Verifying' || status === 'CutoverFrozen';

export type StepState = 'done' | 'current' | 'todo';

/** Where a step stands for a migration; a migration that ended has the steps it passed done and the rest not taken. */
export function stepState(status: MigrationStatus, step: (typeof STEPS)[number]): StepState {
  const at = (STEPS as readonly string[]).indexOf(status);
  const index = STEPS.indexOf(step);
  if (at < 0) return 'todo';
  if (index < at || status === 'Completed') return 'done';
  return index === at ? 'current' : 'todo';
}

/** Milliseconds of freeze left, or 0; undefined when writes are not frozen. */
export function freezeRemainingMs(migration: Pick<MigrationView, 'status' | 'writeFrozenUntil'>, now: number): number | undefined {
  if (migration.status !== 'CutoverFrozen' || migration.writeFrozenUntil === undefined) return undefined;
  return Math.max(0, Date.parse(migration.writeFrozenUntil) - now);
}

/** mm:ss of a duration. */
export function clockOf(ms: number): string {
  const total = Math.floor(ms / 1000);
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

/** The sums of each money column over all tables, on each side, as exact decimal text. */
export function moneyTotals(tables: readonly TableView[]): Array<{ column: string; source: string; target: string }> {
  const sums = new Map<string, { source: bigint; target: bigint }>();
  for (const table of tables) {
    for (const entry of table.money) {
      const sum = sums.get(entry.column) ?? { source: 0n, target: 0n };
      sums.set(entry.column, { source: sum.source + BigInt(entry.source ?? '0'), target: sum.target + BigInt(entry.target ?? '0') });
    }
  }
  return [...sums.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([column, sum]) => ({ column, source: sum.source.toString(), target: sum.target.toString() }));
}

/** The tables worth showing by default: those that hold rows on either side, and every table that differs. */
export const isInteresting = (table: TableView): boolean => !table.match || (table.sourceRows ?? 0) > 0 || (table.targetRows ?? 0) > 0;

export const isReasonValid = (reason: string): boolean => reason.trim().length >= MIN_REASON && reason.trim().length <= MAX_REASON;
export const isMinutesValid = (minutes: number): boolean => Number.isInteger(minutes) && minutes >= MIN_FREEZE_MINUTES && minutes <= MAX_FREEZE_MINUTES;
export const isWindowValid = (value: string): boolean => value !== '' && !Number.isNaN(Date.parse(value));

export type ProblemReason =
  | 'selfApproval'
  | 'mismatch'
  | 'notVerified'
  | 'stale'
  | 'stateInvalid'
  | 'targetChanged'
  | 'alreadyOpen'
  | 'tenantState'
  | 'placementUnavailable'
  | 'conflict'
  | 'invalid'
  | 'denied'
  | 'notFound'
  | 'session'
  | 'general';

export interface ProblemView {
  reason: ProblemReason;
  field: string | undefined;
  /** Which tables differ, when the copy does not agree. */
  tables: string[];
  /** Why a placement cannot be used (NO_ROOM, OTHER_REGION, ...). */
  why: string | undefined;
  correlationId: string | undefined;
}

const REASON_BY_CODE: Readonly<Record<string, ProblemReason>> = {
  SELF_APPROVAL_DENIED: 'selfApproval',
  MIGRATION_ALREADY_OPEN: 'alreadyOpen',
  TENANT_STATE_INVALID: 'tenantState',
  VERSION_CONFLICT: 'conflict',
  VALIDATION_FAILED: 'invalid',
  INVALID_REQUEST: 'invalid',
  SCOPE_DENIED: 'denied',
  RESOURCE_NOT_FOUND: 'notFound',
  SESSION_EXPIRED: 'session',
};

function verificationReason(why: unknown): ProblemReason {
  return why === 'NOT_VERIFIED' ? 'notVerified' : why === 'STALE' ? 'stale' : 'mismatch';
}

/** Names what the server refused by the code it answered, with the tables that differ and the reference of the request to quote to support. */
export function describeProblem(error: unknown): ProblemView {
  if (!(error instanceof ApiError)) return { reason: 'general', field: undefined, tables: [], why: undefined, correlationId: undefined };
  const why = typeof error.extensions.reason === 'string' ? error.extensions.reason : undefined;
  let reason: ProblemReason = REASON_BY_CODE[error.code] ?? 'general';
  if (error.code === 'MIGRATION_VERIFICATION_FAILED') reason = verificationReason(why);
  else if (error.code === 'MIGRATION_STATE_INVALID') reason = error.detail === 'TARGET_CHANGED' ? 'targetChanged' : 'stateInvalid';
  else if (error.code === 'PLACEMENT_UNAVAILABLE') reason = 'placementUnavailable';
  return { reason, field: error.detail, tables: names(error.extensions.tables), why, correlationId: error.correlationId };
}
