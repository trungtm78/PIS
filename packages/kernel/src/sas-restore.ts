import { canonicalJson, sha256Hex } from './canonical-json.ts';
import { DomainError } from './errors.ts';

/**
 * The restore of one tenant to a recovery point (ST-SAS-019, SAS.md 3.11, NFR-AVAILABILITY-02 and 03): into a sandbox, or over the data of the tenant when it is Suspended. A System Admin asks, a second one decides, the restore
 * is made by the worker through the restore engine, and it is Completed only when what the restored copy holds matches what the backup recorded for that recovery point (rows, a checksum and the money totals of every table,
 * no row of another tenant). The rules below are pure.
 */

export const RESTORE_TARGETS = ['SANDBOX', 'IN_PLACE'] as const;
export type RestoreTarget = (typeof RESTORE_TARGETS)[number];
export type RestoreStatus = 'Requested' | 'Approved' | 'Restoring' | 'Verifying' | 'Completed' | 'Failed' | 'Rejected';

/** A restore that has not ended: an in-place one of these blocks the next in-place restore of the tenant. */
export const OPEN_RESTORE_STATUSES: readonly RestoreStatus[] = ['Requested', 'Approved', 'Restoring', 'Verifying'];

export const MIN_RESTORE_REASON = 10;
export const MAX_RESTORE_REASON = 2000;
/** NFR-AVAILABILITY-02: continuous WAL archive and a point-in-time recovery of 35 days. */
export const RECOVERY_WINDOW_DAYS = 35;
/** NFR-AVAILABILITY-02: at most 15 minutes of data lost and 4 hours to recover [the targets await decision D10]. */
export const RESTORE_RPO_TARGET_SECONDS = 15 * 60;
export const RESTORE_RTO_TARGET_SECONDS = 4 * 3600;
/** A restore that has been running for the time agreed to recover, and two hours more, belongs to a process that is gone. */
export const RESTORE_STALLED_AFTER_MS = (RESTORE_RTO_TARGET_SECONDS + 2 * 3600) * 1000;
export const RESTORE_REPORT_SCHEMA_VERSION = 1;
/** The states of a tenant whose data exists and may be restored from; a tenant that was never provisioned or is archived has nothing to restore into or from. */
export const RESTORABLE_TENANT_STATUSES: readonly string[] = ['Active', 'Suspended', 'Offboarding'];
const DAY_MS = 86_400_000;

export interface RecoveryWindow {
  /** The oldest recovery point the backups hold. */
  earliest: Date;
  /** The latest recovery point the backups hold. */
  latest: Date;
}

/** The window of a point-in-time recovery that reaches back `RECOVERY_WINDOW_DAYS` from `now`. */
export function recoveryWindowEndingAt(now: Date): RecoveryWindow {
  return { earliest: new Date(now.getTime() - RECOVERY_WINDOW_DAYS * DAY_MS), latest: now };
}

export interface RestoreRequestInput {
  recoveryPoint: Date;
  target: RestoreTarget;
  reason: string;
}

/** The fields of a request that cannot be accepted (the contract refuses most already; the store relies on this): the reason is 10 to 2000 characters once trimmed, the recovery point is an instant. */
export function restoreRequestDefects(input: Pick<RestoreRequestInput, 'recoveryPoint' | 'reason'>): Array<'recovery_point' | 'reason'> {
  const defects: Array<'recovery_point' | 'reason'> = [];
  if (Number.isNaN(input.recoveryPoint.getTime())) defects.push('recovery_point');
  const reason = input.reason.trim();
  if (reason.length < MIN_RESTORE_REASON || reason.length > MAX_RESTORE_REASON) defects.push('reason');
  return defects;
}

/**
 * Whether a tenant in this state may be restored this way (409 `TENANT_STATE_INVALID`): the data must exist (Active, Suspended or Offboarding), and a restore over the data of the tenant (IN_PLACE) is made only while the tenant is
 * Suspended, so that nobody works in the data while it is replaced; a copy in a sandbox touches nothing.
 */
export function assertRestorable(target: RestoreTarget, tenantStatus: string): void {
  if (!RESTORABLE_TENANT_STATUSES.includes(tenantStatus) || (target === 'IN_PLACE' && tenantStatus !== 'Suspended')) throw new DomainError('TENANT_STATE_INVALID', 409, tenantStatus);
}

/** The recovery point must be one the backups hold (422 `RECOVERY_POINT_UNAVAILABLE`); no window at all means nothing can be restored. */
export function assertRecoveryPointHeld(recoveryPoint: Date, window: RecoveryWindow | undefined): void {
  if (window === undefined || recoveryPoint.getTime() < window.earliest.getTime() || recoveryPoint.getTime() > window.latest.getTime()) throw new DomainError('RECOVERY_POINT_UNAVAILABLE', 422);
}

/** What one table holds: its rows, a checksum of them and the totals of its money columns (names ending in `_vnd`), as decimal texts. */
export interface TableMeasurement {
  rows: number;
  checksum: string;
  money: Readonly<Record<string, string>>;
}

export interface Measurement {
  tables: Readonly<Record<string, TableMeasurement>>;
}

/** What a restored copy holds: the same measure, and the rows in it that belong to another tenant (there must be none). */
export interface RestoredCopy extends Measurement {
  foreignRows: number;
}

export interface RestoreMoneyCheck {
  column: string;
  expected: string;
  restored: string;
  match: boolean;
}

export interface RestoreTableCheck {
  table: string;
  expected_rows: number;
  restored_rows: number;
  rows_match: boolean;
  expected_checksum: string;
  restored_checksum: string;
  checksum_match: boolean;
  money: RestoreMoneyCheck[];
}

export interface RestoreVerificationReport {
  schema_version: number;
  matched: boolean;
  tables: RestoreTableCheck[];
  totals: { tables: number; rows_expected: number; rows_restored: number; money_expected_vnd: string; money_restored_vnd: string };
  foreign_rows: number;
  mismatches: string[];
  rpo_seconds: number;
  rto_seconds: number;
  rpo_target_seconds: number;
  rto_target_seconds: number;
  within_targets: boolean;
}

export interface RestoreTimings {
  recoveryPoint: Date;
  /** The instant the engine actually restored to (it may be before the recovery point asked for). */
  restoredTo: Date;
  approvedAt: Date;
  verifiedAt: Date;
}

const MICRO = 1_000_000n;
const DECIMAL = /^(-?)(\d{1,30})(?:\.(\d{1,6}))?$/;

function toMicro(text: string): bigint {
  const parts = DECIMAL.exec(text);
  if (parts === null) throw new Error('a money total is not a decimal of at most six places');
  const value = BigInt(parts[2] as string) * MICRO + BigInt((parts[3] ?? '').padEnd(6, '0'));
  return parts[1] === '-' ? -value : value;
}

function fromMicro(value: bigint): string {
  const sign = value < 0n ? '-' : '';
  const absolute = value < 0n ? -value : value;
  const fraction = (absolute % MICRO).toString().padStart(6, '0').replace(/0+$/, '');
  return `${sign}${absolute / MICRO}${fraction === '' ? '' : `.${fraction}`}`;
}

/** The same money, written once: `100.50` and `100.5` are one amount. */
export const normalizeMoney = (text: string): string => fromMicro(toMicro(text));

const moneyTotal = (measurement: Measurement): bigint =>
  Object.values(measurement.tables)
    .flatMap((table) => Object.values(table.money))
    .reduce((sum, amount) => sum + toMicro(amount), 0n);

function moneyChecks(table: string, expected: TableMeasurement | undefined, restored: TableMeasurement | undefined, mismatches: string[]): RestoreMoneyCheck[] {
  const columns = [...new Set([...Object.keys(expected?.money ?? {}), ...Object.keys(restored?.money ?? {})])].sort();
  return columns.map((column) => {
    const [want, got] = [expected?.money[column], restored?.money[column]];
    const match = want !== undefined && got !== undefined && toMicro(want) === toMicro(got);
    if (!match) mismatches.push(`money:${table}.${column}`);
    return { column, expected: want === undefined ? '' : normalizeMoney(want), restored: got === undefined ? '' : normalizeMoney(got), match };
  });
}

/**
 * Compares what the backup recorded for the recovery point with what the restored copy holds, table by table: the same tables, the same rows, the same checksum, the same money totals, and no row of another tenant. The
 * restore is `matched` only when nothing differs. The report also states how far the copy stops before the recovery point asked for (RPO) and how long the restore took from its approval (RTO), against the targets.
 */
export function verifyRestore(expected: Measurement, restored: RestoredCopy, timings: RestoreTimings): RestoreVerificationReport {
  const mismatches: string[] = [];
  const names = [...new Set([...Object.keys(expected.tables), ...Object.keys(restored.tables)])].sort();
  const tables = names.map((table): RestoreTableCheck => {
    const [want, got] = [expected.tables[table], restored.tables[table]];
    if (want === undefined) mismatches.push(`unexpected_table:${table}`);
    else if (got === undefined) mismatches.push(`missing_table:${table}`);
    const rowsMatch = want !== undefined && got !== undefined && want.rows === got.rows;
    const checksumMatch = want !== undefined && got !== undefined && want.checksum === got.checksum;
    if (want !== undefined && got !== undefined) {
      if (!rowsMatch) mismatches.push(`rows:${table}`);
      if (!checksumMatch) mismatches.push(`checksum:${table}`);
    }
    return {
      table,
      expected_rows: want?.rows ?? 0,
      restored_rows: got?.rows ?? 0,
      rows_match: rowsMatch,
      expected_checksum: want?.checksum ?? '',
      restored_checksum: got?.checksum ?? '',
      checksum_match: checksumMatch,
      money: moneyChecks(table, want, got, mismatches),
    };
  });
  if (restored.foreignRows > 0) mismatches.push('foreign_rows');
  const rpo = Math.max(0, Math.floor((timings.recoveryPoint.getTime() - timings.restoredTo.getTime()) / 1000));
  const rto = Math.max(0, Math.ceil((timings.verifiedAt.getTime() - timings.approvedAt.getTime()) / 1000));
  return {
    schema_version: RESTORE_REPORT_SCHEMA_VERSION,
    matched: mismatches.length === 0,
    tables,
    totals: {
      tables: names.length,
      rows_expected: tables.reduce((sum, table) => sum + table.expected_rows, 0),
      rows_restored: tables.reduce((sum, table) => sum + table.restored_rows, 0),
      money_expected_vnd: fromMicro(moneyTotal(expected)),
      money_restored_vnd: fromMicro(moneyTotal(restored)),
    },
    foreign_rows: restored.foreignRows,
    mismatches,
    rpo_seconds: rpo,
    rto_seconds: rto,
    rpo_target_seconds: RESTORE_RPO_TARGET_SECONDS,
    rto_target_seconds: RESTORE_RTO_TARGET_SECONDS,
    within_targets: rpo <= RESTORE_RPO_TARGET_SECONDS && rto <= RESTORE_RTO_TARGET_SECONDS,
  };
}

/** The reference of a verification report: its sha256 over the canonical text. The record of a drill names the report it was judged by, and the report cannot change without the reference showing it. */
export const restoreReportReference = (report: RestoreVerificationReport): string => `sha256:${sha256Hex(canonicalJson(report))}`;
