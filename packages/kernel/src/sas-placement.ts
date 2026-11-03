import { createHash } from 'node:crypto';
import { DomainError } from './errors.ts';
import { assertFourEyes } from './four-eyes.ts';

/**
 * The promotion of a tenant from the shared (pool) placement to a database of its own (silo) with a verified cutover (ST-SAS-018, SAS.md 3.3, BR-SAS-05): the rows are copied, the copy is compared with the original table by table
 * (the number of rows, a checksum of the content of every row and the sum of every numeric(24,0) money column), a System Admin other than the one who started approves the cutover, writes are frozen for a bounded time, the copy is
 * compared again, the routing is switched and the tenant is watched for 24 hours before the migration is Completed. The rules below are pure: the database and the worker only carry them out.
 */

export const MIGRATION_STATUSES = ['Planned', 'Copying', 'Verifying', 'AwaitingCutover', 'CutoverFrozen', 'Switched', 'Completed', 'Aborted', 'RolledBack'] as const;
export type MigrationStatus = (typeof MIGRATION_STATUSES)[number];

/** The statuses of a migration that is not over: a tenant has at most one of them (409 MIGRATION_ALREADY_OPEN). */
export const OPEN_MIGRATION_STATUSES: readonly MigrationStatus[] = ['Planned', 'Copying', 'Verifying', 'AwaitingCutover', 'CutoverFrozen', 'Switched'];
export const FINAL_MIGRATION_STATUSES: readonly MigrationStatus[] = ['Completed', 'Aborted', 'RolledBack'];

export const isOpenMigration = (status: MigrationStatus): boolean => OPEN_MIGRATION_STATUSES.includes(status);

/** BR-SAS-05: the freeze of writes lasts 5 to 240 minutes. */
export const MIN_FREEZE_MINUTES = 5;
export const MAX_FREEZE_MINUTES = 240;
export const MIN_REASON_LENGTH = 10;
export const MAX_REASON_LENGTH = 2000;
/** The tenant is watched this long after the switch before the migration is Completed (SAS.md 3.3). */
export const OBSERVATION_HOURS = 24;
/** The old copy of the data is deleted this many days after Completed, unless a legal hold is in force (SAS.md 3.3). */
export const SOURCE_RETENTION_DAYS = 30;
/** A comparison older than this does not support a cutover: the tenant went on writing since. */
export const VERIFICATION_MAX_AGE_MINUTES = 10;
/** The window of the migration may be this late when it is asked for (the clock of the caller is not the clock of the server). */
export const WINDOW_SKEW_MINUTES = 5;
/** The window of the migration may be this far ahead. */
export const MAX_WINDOW_DAYS = 90;
/**
 * The worker waits this long after writes are frozen before it sends the last difference: the answer about the tenant is kept for a second by every process of the API and a command that began before the freeze finishes within
 * seconds, so a write accepted at the instant of the approval is still in before the last comparison is made.
 */
export const FREEZE_SETTLE_SECONDS = 5;
/** The most migrations that a worker pass moves one after the other for a tenant. */
export const MAX_STEPS_PER_PASS = 8;

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

type Action = 'copy' | 'copied' | 'verified' | 'approve' | 'switch' | 'complete';

const NEXT: Readonly<Record<MigrationStatus, Readonly<Partial<Record<Action, MigrationStatus>>>>> = {
  Planned: { copy: 'Copying' },
  Copying: { copied: 'Verifying' },
  Verifying: { verified: 'AwaitingCutover' },
  AwaitingCutover: { approve: 'CutoverFrozen' },
  CutoverFrozen: { switch: 'Switched' },
  Switched: { complete: 'Completed' },
  Completed: {},
  Aborted: {},
  RolledBack: {},
};

export type MigrationAction = Action | 'abort';

/**
 * The status after `action`, or 409 `MIGRATION_STATE_INVALID` naming the status and the action. An abort before the cutover is `Aborted` (nothing was switched, the routing never changed); an abort once writes were frozen or the
 * routing was switched is `RolledBack` (the freeze is lifted and the routing is back on the old placement).
 */
export function nextMigrationStatus(from: MigrationStatus, action: MigrationAction): MigrationStatus {
  if (action === 'abort') return abortedStatus(from);
  const next = NEXT[from][action];
  if (next === undefined) throw new DomainError('MIGRATION_STATE_INVALID', 409, `${from}->${action}`);
  return next;
}

/** The status a migration ends in when it is aborted from `from`: Aborted before the cutover, RolledBack once writes were frozen or the routing switched; 409 `MIGRATION_STATE_INVALID` when it is over already. */
export function abortedStatus(from: MigrationStatus): 'Aborted' | 'RolledBack' {
  if (!isOpenMigration(from)) throw new DomainError('MIGRATION_STATE_INVALID', 409, `${from}->abort`);
  return from === 'CutoverFrozen' || from === 'Switched' ? 'RolledBack' : 'Aborted';
}

/** The moves the database allows, for its guard: every other change of status is refused. */
export const MIGRATION_TRANSITIONS: ReadonlyArray<readonly [MigrationStatus, MigrationStatus]> = MIGRATION_STATUSES.flatMap((from) => {
  const forward = Object.values(NEXT[from]);
  const aborts = isOpenMigration(from) ? [nextMigrationStatus(from, 'abort')] : [];
  return [...forward, ...aborts].map((to): readonly [MigrationStatus, MigrationStatus] => [from, to]);
});

export interface MigrationStartInput {
  writeFreezeMaxMinutes: number;
  plannedWindowStart: Date | undefined;
  reason: string;
}

/** The first field of a start that cannot be accepted, or undefined. */
export function startDefect(input: MigrationStartInput, now: Date): 'write_freeze_max_minutes' | 'planned_window_start' | 'reason' | undefined {
  if (!Number.isInteger(input.writeFreezeMaxMinutes) || input.writeFreezeMaxMinutes < MIN_FREEZE_MINUTES || input.writeFreezeMaxMinutes > MAX_FREEZE_MINUTES) return 'write_freeze_max_minutes';
  const start = input.plannedWindowStart;
  if (start === undefined || Number.isNaN(start.getTime())) return 'planned_window_start';
  if (start.getTime() < now.getTime() - WINDOW_SKEW_MINUTES * MINUTE_MS || start.getTime() > now.getTime() + MAX_WINDOW_DAYS * DAY_MS) return 'planned_window_start';
  const reason = input.reason.trim();
  if (reason.length < MIN_REASON_LENGTH || reason.length > MAX_REASON_LENGTH) return 'reason';
  return undefined;
}

export function assertStartAccepted(input: MigrationStartInput, now: Date): void {
  const field = startDefect(input, now);
  if (field !== undefined) throw new DomainError('VALIDATION_FAILED', 422, field);
}

export interface PromotableTenant {
  status: string;
  isolationMode: string;
  region: string;
  placementId: string;
}

export interface PromotionTarget {
  id: string;
  kind: string;
  status: string;
  region: string;
  /** Whether the placement has room: no tenant on it and none on the way to it (a silo is one tenant's own). */
  hasRoom: boolean;
}

/**
 * Whether the tenant may be moved to the placement. Only an Active tenant that is on the pool (409 `TENANT_STATE_INVALID`), to an Active silo of its own region that is free and is not where it already is (422
 * `PLACEMENT_UNAVAILABLE`, the extension `reason` says which). The region matters because the data of a tenant stays in the country and the region it was given (Luật Dữ liệu 60/2024/QH15).
 */
export function assertSiloPromotable(tenant: PromotableTenant, target: PromotionTarget): void {
  if (tenant.status !== 'Active') throw new DomainError('TENANT_STATE_INVALID', 409, tenant.status);
  if (tenant.isolationMode === 'SILO') throw new DomainError('TENANT_STATE_INVALID', 409, 'ALREADY_SILO');
  const unavailable = (reason: string): DomainError => new DomainError('PLACEMENT_UNAVAILABLE', 422, 'to_placement_id', { extensions: { reason } });
  if (target.id === tenant.placementId) throw unavailable('SAME_PLACEMENT');
  if (target.kind !== 'SILO') throw unavailable('NOT_SILO');
  if (target.status !== 'Active') throw unavailable('NOT_ACTIVE');
  if (target.region !== tenant.region) throw unavailable('OTHER_REGION');
  if (!target.hasRoom) throw unavailable('NO_ROOM');
}

/** What is measured of one table of the tenant, on either side of the copy. Every number is exact: sums travel as decimal text because they exceed what a JavaScript number holds. */
export interface TableMeasure {
  table: string;
  rows: number;
  /** The sum of a hash of the whole content of every row (every column, so a change to any of them changes it), as decimal text: the same rows give the same sum in any order. */
  checksum: string;
  /** The sum of each numeric(24,0) column, as decimal text, by column. */
  money: Readonly<Record<string, string>>;
}

export interface MoneyReconciliation {
  column: string;
  source: string | null;
  target: string | null;
  match: boolean;
}

export interface TableReconciliation {
  table: string;
  sourceRows: number | null;
  targetRows: number | null;
  rowsMatch: boolean;
  sourceChecksum: string | null;
  targetChecksum: string | null;
  checksumMatch: boolean;
  money: MoneyReconciliation[];
  moneyMatch: boolean;
  match: boolean;
}

export interface CopyReconciliation {
  match: boolean;
  tables: TableReconciliation[];
  /** The tables that do not agree (rows, content checksum or money), by name. */
  mismatchedTables: string[];
  sourceRows: number;
  targetRows: number;
}

const DECIMAL = /^-?\d+$/;

/** Whether two sums written as decimal text are the same number (a missing one is never the same as anything). */
export function sameAmount(left: string | null | undefined, right: string | null | undefined): boolean {
  if (typeof left !== 'string' || typeof right !== 'string' || !DECIMAL.test(left) || !DECIMAL.test(right)) return false;
  return BigInt(left) === BigInt(right);
}

function moneyOf(source: TableMeasure | undefined, target: TableMeasure | undefined): MoneyReconciliation[] {
  const columns = [...new Set([...Object.keys(source?.money ?? {}), ...Object.keys(target?.money ?? {})])].sort();
  return columns.map((column) => {
    const left = source?.money[column] ?? null;
    const right = target?.money[column] ?? null;
    return { column, source: left, target: right, match: sameAmount(left, right) };
  });
}

/**
 * Compares the original with the copy, table by table. A table is in agreement only when both sides have it, the number of rows is the same, the checksum of the content of the rows is the same and every money column has the same
 * sum; a table on one side only (a table the copy lacks, or rows of a table the tenant does not have) is a difference. The whole is in agreement only when every table is.
 */
export function reconcileCopy(source: readonly TableMeasure[], target: readonly TableMeasure[]): CopyReconciliation {
  const left = new Map(source.map((measure) => [measure.table, measure]));
  const right = new Map(target.map((measure) => [measure.table, measure]));
  const names = [...new Set([...left.keys(), ...right.keys()])].sort();
  const tables = names.map((table): TableReconciliation => {
    const one = left.get(table);
    const other = right.get(table);
    const money = moneyOf(one, other);
    const rowsMatch = one !== undefined && other !== undefined && one.rows === other.rows;
    const checksumMatch = one !== undefined && other !== undefined && sameAmount(one.checksum, other.checksum);
    const moneyMatch = one !== undefined && other !== undefined && money.every((entry) => entry.match);
    return {
      table,
      sourceRows: one?.rows ?? null,
      targetRows: other?.rows ?? null,
      rowsMatch,
      sourceChecksum: one?.checksum ?? null,
      targetChecksum: other?.checksum ?? null,
      checksumMatch,
      money,
      moneyMatch,
      match: rowsMatch && checksumMatch && moneyMatch,
    };
  });
  return {
    match: tables.every((entry) => entry.match),
    tables,
    mismatchedTables: tables.filter((entry) => !entry.match).map((entry) => entry.table),
    sourceRows: source.reduce((sum, measure) => sum + measure.rows, 0),
    targetRows: target.reduce((sum, measure) => sum + measure.rows, 0),
  };
}

/** The comparison as it is kept with the migration: when it was taken, both sides, and what it concluded. */
export interface VerificationReport {
  measuredAt: Date;
  source: TableMeasure[];
  target: TableMeasure[];
  match: boolean;
  mismatchedTables: string[];
}

export function verificationReport(source: readonly TableMeasure[], target: readonly TableMeasure[], measuredAt: Date): VerificationReport {
  const result = reconcileCopy(source, target);
  return { measuredAt, source: [...source], target: [...target], match: result.match, mismatchedTables: result.mismatchedTables };
}

const sortedMeasure = (measure: TableMeasure): TableMeasure => ({ table: measure.table, rows: measure.rows, checksum: measure.checksum, money: Object.fromEntries(Object.entries(measure.money).sort(([a], [b]) => a.localeCompare(b))) });
const byTable = (measures: readonly TableMeasure[]): TableMeasure[] => measures.map(sortedMeasure).sort((a, b) => a.table.localeCompare(b.table));

/** The reference that the migration keeps to its comparison: a hash of what was compared and when, so a report that is altered afterwards no longer matches its reference. */
export function reportReference(report: VerificationReport): string {
  const canonical = JSON.stringify({ measured_at: report.measuredAt.toISOString(), source: byTable(report.source), target: byTable(report.target) });
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}

/** Whether a comparison is recent enough to support a cutover. */
export const isReportFresh = (measuredAt: Date, now: Date): boolean => now.getTime() - measuredAt.getTime() <= VERIFICATION_MAX_AGE_MINUTES * MINUTE_MS && measuredAt.getTime() <= now.getTime() + MINUTE_MS;

export interface CutoverFacts {
  status: MigrationStatus;
  requestedBy: string;
  /** The last comparison, or undefined when none was made. */
  report: Pick<VerificationReport, 'measuredAt' | 'match' | 'mismatchedTables'> | undefined;
}

/**
 * Whether `approver` may approve the cutover now: the migration waits for it (409 `MIGRATION_STATE_INVALID`), the approver is not the one who started it (403 `SELF_APPROVAL_DENIED`) and the last comparison, taken
 * recently, found the copy and the original in agreement (422 `MIGRATION_VERIFICATION_FAILED`, the extension `reason` says NOT_VERIFIED, STALE or MISMATCH and `tables` which tables differ).
 */
export function assertCutoverApproved(facts: CutoverFacts, approver: string, now: Date): void {
  nextMigrationStatus(facts.status, 'approve');
  assertFourEyes(facts.requestedBy, approver);
  const failed = (reason: string, tables: readonly string[]): DomainError => new DomainError('MIGRATION_VERIFICATION_FAILED', 422, undefined, { extensions: { reason, tables: [...tables] } });
  if (facts.report === undefined) throw failed('NOT_VERIFIED', []);
  if (!facts.report.match) throw failed('MISMATCH', facts.report.mismatchedTables);
  if (!isReportFresh(facts.report.measuredAt, now)) throw failed('STALE', []);
}

export const freezeEndsAt = (startedAt: Date, maxMinutes: number): Date => new Date(startedAt.getTime() + maxMinutes * MINUTE_MS);
/** Whether the freeze of writes has run out its time: the routing may be switched only before this instant. */
export const freezeOver = (startedAt: Date, maxMinutes: number, now: Date): boolean => now.getTime() >= freezeEndsAt(startedAt, maxMinutes).getTime();
export const observationEndsAt = (switchedAt: Date): Date => new Date(switchedAt.getTime() + OBSERVATION_HOURS * HOUR_MS);
export const sourcePurgeDueAt = (completedAt: Date): Date => new Date(completedAt.getTime() + SOURCE_RETENTION_DAYS * DAY_MS);

/** Why the system ended a migration by itself. */
export type SystemEndReason = 'FREEZE_EXPIRED' | 'FINAL_VERIFICATION_FAILED';

export interface WorkerFacts {
  status: MigrationStatus;
  plannedWindowStart: Date;
  writeFreezeStartedAt: Date | null;
  writeFreezeMaxMinutes: number;
  switchedAt: Date | null;
  /** The data of the target is destroyed once the migration ended without a switch. */
  targetDiscarded: boolean;
  sourcePurgeDueAt: Date | null;
  sourcePurged: boolean;
}

/**
 * What the worker does next with a migration (SAS.md 3.3, `PlacementMigrationWorkflow`):
 *  - `start`: the window has come, the copy begins; `wait`: nothing to do until a later pass;
 *  - `copy`, `verify`: carry on with the copy and compare it; `refresh`: while the cutover waits for approval, catch up with the original and compare again;
 *  - `freeze-expired`: the freeze ran out its time before the switch, so the migration is rolled back; `finalize`: send the last difference, compare again and switch (after the first seconds of the freeze, see `FREEZE_SETTLE_SECONDS`);
 *  - `complete`: the observation is over; `discard-target`: the copy of an ended migration is destroyed; `purge-source`: the old copy of a completed one is deleted.
 */
export type WorkerStep = 'wait' | 'start' | 'copy' | 'verify' | 'refresh' | 'freeze-expired' | 'finalize' | 'complete' | 'discard-target' | 'purge-source';

export function workerStep(facts: WorkerFacts, now: Date): WorkerStep {
  switch (facts.status) {
    case 'Planned':
      return now.getTime() >= facts.plannedWindowStart.getTime() ? 'start' : 'wait';
    case 'Copying':
      return 'copy';
    case 'Verifying':
      return 'verify';
    case 'AwaitingCutover':
      return 'refresh';
    case 'CutoverFrozen':
      if (facts.writeFreezeStartedAt === null || freezeOver(facts.writeFreezeStartedAt, facts.writeFreezeMaxMinutes, now)) return 'freeze-expired';
      return now.getTime() < facts.writeFreezeStartedAt.getTime() + FREEZE_SETTLE_SECONDS * 1000 ? 'wait' : 'finalize';
    case 'Switched':
      return facts.switchedAt !== null && now.getTime() >= observationEndsAt(facts.switchedAt).getTime() ? 'complete' : 'wait';
    case 'Completed':
      return facts.sourcePurged || facts.sourcePurgeDueAt === null || now.getTime() < facts.sourcePurgeDueAt.getTime() ? 'wait' : 'purge-source';
    case 'Aborted':
    case 'RolledBack':
      return facts.targetDiscarded ? 'wait' : 'discard-target';
  }
}

/** The old copy of a completed migration is deleted only when no legal hold is in force on the tenant (BR-PLT-04). */
export const mayPurgeSource = (legalHoldsActive: number): boolean => legalHoldsActive === 0;
