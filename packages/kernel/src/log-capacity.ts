import { TECHNICAL_CLASSES } from './retention.ts';
import type { TechnicalClass } from './retention.ts';

/**
 * Caps on the number and the size of the log classes of a tenant (HT.06, ENT-4e). Two kinds of class:
 * - a TECHNICAL class (retention.ts) may be capped: when it is over its cap the nightly run archives the oldest rows beyond the cap into a hashed file
 *   and only then removes exactly those rows, never a row younger than the platform minimum period (the cap is not a way to shorten retention);
 * - a MONITOR-ONLY class (the audit trail and its detail records) is measured and raises alerts, but nothing ever removes a row of it: business audit
 *   evidence is not deleted by a job (BR-ADM-11).
 */
export const MONITOR_ONLY_CLASSES = ['audit_event', 'audit_event_detail'] as const;
export type MonitorOnlyClass = (typeof MONITOR_ONLY_CLASSES)[number];
export type CapacityClass = TechnicalClass | MonitorOnlyClass;
export const CAPACITY_CLASSES: readonly CapacityClass[] = [...TECHNICAL_CLASSES, ...MONITOR_ONLY_CLASSES];

export const DEFAULT_WARN_PCT = 80;
export const MIN_WARN_PCT = 50;
export const MAX_WARN_PCT = 99;
/** After an archive-and-purge the class stands at this share of its cap, so the next night does not archive again for a few rows. */
export const LOW_WATER_PCT = 90;
export const MAX_CAP_ROWS = 1_000_000_000;
export const MAX_CAP_BYTES = 1_000_000_000_000;

export type CapacityKind = 'TECHNICAL' | 'MONITOR_ONLY';

export function capacityKindOf(recordClass: string): CapacityKind | undefined {
  if ((TECHNICAL_CLASSES as readonly string[]).includes(recordClass)) return 'TECHNICAL';
  return (MONITOR_ONLY_CLASSES as readonly string[]).includes(recordClass) ? 'MONITOR_ONLY' : undefined;
}

export interface LogCapPolicy {
  recordClass: string;
  /** Null: no limit on the number of rows. */
  maxRows: number | null;
  /** Null: no limit on the size. */
  maxBytes: number | null;
  warnPct: number;
}

/** What the nightly run measured for one class of one tenant. */
export interface LogReading {
  recordClass: string;
  rows: number;
  /** Total size of the rows; an estimate (sampled) when `bytesEstimated`. */
  bytes: number;
  bytesEstimated: boolean;
  /** Rows older than the platform minimum period and not under a legal hold: the only ones a cap may remove. */
  eligibleRows: number;
  /** Rows the platform minimum period keeps (younger than it, or held): a cap below this could never be honoured. */
  protectedRows: number;
}

export type CapacityState = 'UNCAPPED' | 'OK' | 'NEAR' | 'OVER';

export interface CapacityEvaluation {
  state: CapacityState;
  /** Share of the cap in use, in percent with one decimal; null when that dimension has no cap. */
  rowsPct: number | null;
  bytesPct: number | null;
  /** The dimension that decides the state (the larger share). */
  binding: 'ROWS' | 'BYTES' | null;
  excessRows: number;
  excessBytes: number;
}

const pct = (used: number, cap: number | null): number | null => (cap === null || cap <= 0 ? null : Math.round((used / cap) * 1000) / 10);

/** Where a class stands against its cap: OVER above 100 percent, NEAR from `warnPct`, OK below, UNCAPPED when no limit is set. */
export function evaluateCapacity(policy: Pick<LogCapPolicy, 'maxRows' | 'maxBytes' | 'warnPct'>, reading: Pick<LogReading, 'rows' | 'bytes'>): CapacityEvaluation {
  const rowsPct = pct(reading.rows, policy.maxRows);
  const bytesPct = pct(reading.bytes, policy.maxBytes);
  if (rowsPct === null && bytesPct === null) return { state: 'UNCAPPED', rowsPct, bytesPct, binding: null, excessRows: 0, excessBytes: 0 };
  const binding = (rowsPct ?? -1) >= (bytesPct ?? -1) ? 'ROWS' : 'BYTES';
  const top = Math.max(rowsPct ?? 0, bytesPct ?? 0);
  const state: CapacityState = top > 100 ? 'OVER' : top >= policy.warnPct ? 'NEAR' : 'OK';
  return {
    state,
    rowsPct,
    bytesPct,
    binding,
    excessRows: policy.maxRows === null ? 0 : Math.max(0, reading.rows - policy.maxRows),
    excessBytes: policy.maxBytes === null ? 0 : Math.max(0, reading.bytes - policy.maxBytes),
  };
}

export type ArchivePlanAction = 'NONE' | 'ARCHIVE_THEN_PURGE' | 'NOTHING_ELIGIBLE' | 'MONITOR_ONLY';

export interface ArchivePlan {
  action: ArchivePlanAction;
  /** How many of the oldest eligible rows to archive and then remove. */
  rows: number;
}

/**
 * What the nightly run does for a class over its cap. A monitor-only class is never purged. A technical class archives the oldest rows beyond the
 * low-water mark of the cap (rows, or the rows that bring the size under it at the average row size) but never more than the eligible rows: when
 * nothing is eligible the class stays over its cap and the alert says so.
 */
export function planArchive(policy: LogCapPolicy, reading: LogReading): ArchivePlan {
  const kind = capacityKindOf(policy.recordClass);
  const evaluation = evaluateCapacity(policy, reading);
  if (kind === undefined || evaluation.state !== 'OVER') return { action: 'NONE', rows: 0 };
  if (kind === 'MONITOR_ONLY') return { action: 'MONITOR_ONLY', rows: 0 };
  const targetRows = policy.maxRows === null ? Number.POSITIVE_INFINITY : Math.floor((policy.maxRows * LOW_WATER_PCT) / 100);
  const targetBytes = policy.maxBytes === null ? Number.POSITIVE_INFINITY : Math.floor((policy.maxBytes * LOW_WATER_PCT) / 100);
  const byRows = Number.isFinite(targetRows) ? Math.max(0, reading.rows - targetRows) : 0;
  const average = reading.rows === 0 ? 0 : reading.bytes / reading.rows;
  const byBytes = Number.isFinite(targetBytes) && average > 0 ? Math.max(0, Math.ceil((reading.bytes - targetBytes) / average)) : 0;
  const wanted = Math.max(byRows, byBytes);
  const rows = Math.min(wanted, reading.eligibleRows);
  return rows === 0 ? { action: 'NOTHING_ELIGIBLE', rows: 0 } : { action: 'ARCHIVE_THEN_PURGE', rows };
}

export type LogCapacityFindingCode = 'CLASS_UNKNOWN' | 'NO_LIMIT' | 'ROWS_RANGE' | 'BYTES_RANGE' | 'WARN_RANGE' | 'BELOW_PROTECTED_ROWS' | 'REASON_REQUIRED';

export interface LogCapacityFinding {
  field: string;
  code: LogCapacityFindingCode;
  message: string;
}

const MESSAGES: Readonly<Record<LogCapacityFindingCode, string>> = {
  CLASS_UNKNOWN: 'adm.logCapacity.error.classUnknown',
  NO_LIMIT: 'adm.logCapacity.error.noLimit',
  ROWS_RANGE: 'adm.logCapacity.error.rowsRange',
  BYTES_RANGE: 'adm.logCapacity.error.bytesRange',
  WARN_RANGE: 'adm.logCapacity.error.warnRange',
  BELOW_PROTECTED_ROWS: 'adm.logCapacity.error.belowProtected',
  REASON_REQUIRED: 'adm.logCapacity.error.reason',
};

const finding = (field: string, code: LogCapacityFindingCode): LogCapacityFinding => ({ field, code, message: MESSAGES[code] });

/**
 * Every rule of a cap that the request schema cannot state. `protectedRows` is the last reading of rows that the platform minimum period keeps: a cap on
 * the number of rows below it could never be honoured without shortening the retention that BR-ADM-11 fixes, so it is refused (monitor-only classes
 * have no such floor because nothing is ever removed from them).
 */
export function logCapFindings(policy: LogCapPolicy, reason: string, protectedRows: number): LogCapacityFinding[] {
  const found: LogCapacityFinding[] = [];
  const kind = capacityKindOf(policy.recordClass);
  if (kind === undefined) found.push(finding('record_class', 'CLASS_UNKNOWN'));
  if (policy.maxRows === null && policy.maxBytes === null) found.push(finding('max_rows', 'NO_LIMIT'));
  if (policy.maxRows !== null && (!Number.isInteger(policy.maxRows) || policy.maxRows < 1 || policy.maxRows > MAX_CAP_ROWS)) found.push(finding('max_rows', 'ROWS_RANGE'));
  if (policy.maxBytes !== null && (!Number.isInteger(policy.maxBytes) || policy.maxBytes < 1_048_576 || policy.maxBytes > MAX_CAP_BYTES)) found.push(finding('max_bytes', 'BYTES_RANGE'));
  if (!Number.isInteger(policy.warnPct) || policy.warnPct < MIN_WARN_PCT || policy.warnPct > MAX_WARN_PCT) found.push(finding('warn_pct', 'WARN_RANGE'));
  if (kind === 'TECHNICAL' && policy.maxRows !== null && policy.maxRows < protectedRows) found.push(finding('max_rows', 'BELOW_PROTECTED_ROWS'));
  if (reason.trim().length < 5) found.push(finding('reason', 'REASON_REQUIRED'));
  return found;
}

export type CapacityAlertCode = 'LOG_CAPACITY_NEAR' | 'LOG_CAPACITY_EXCEEDED';

/** The alert a reading raises, if any: NEAR from the warning share, EXCEEDED when the class is over its cap and the run could not bring it back (monitor-only, or nothing eligible). */
export function capacityAlert(evaluation: CapacityEvaluation, plan: ArchivePlan): CapacityAlertCode | undefined {
  if (evaluation.state === 'NEAR') return 'LOG_CAPACITY_NEAR';
  if (evaluation.state !== 'OVER') return undefined;
  return plan.action === 'ARCHIVE_THEN_PURGE' ? 'LOG_CAPACITY_NEAR' : 'LOG_CAPACITY_EXCEEDED';
}
