import { ApiError } from '@machvon/api-client';

/** The permissions of SAS-21 (x-permission of the operations in openapi.json): the System Admin asks and decides, the registry readers look. */
export const MANAGE_PERMISSION = 'system.tenant.manage';
export const READ_PERMISSION = 'system.tenant.read';

export const MIN_REASON = 10;
export const MAX_REASON = 2000;

export type RestoreTarget = 'SANDBOX' | 'IN_PLACE';
export type RestoreStatus = 'Requested' | 'Approved' | 'Restoring' | 'Verifying' | 'Completed' | 'Failed' | 'Rejected';
export type TenantStatus = 'Requested' | 'Provisioning' | 'Active' | 'Failed' | 'Suspended' | 'Offboarding' | 'Archived';

export interface MoneyCheck {
  column: string;
  expected: string;
  restored: string;
  match: boolean;
}

export interface TableCheck {
  table: string;
  expectedRows: number;
  restoredRows: number;
  rowsMatch: boolean;
  checksumMatch: boolean;
  money: MoneyCheck[];
}

export interface ReportView {
  matched: boolean;
  tables: TableCheck[];
  tablesCount: number;
  rowsExpected: number;
  rowsRestored: number;
  moneyExpected: string;
  moneyRestored: string;
  foreignRows: number;
  mismatches: string[];
  rpoSeconds: number;
  rtoSeconds: number;
  rpoTargetSeconds: number;
  rtoTargetSeconds: number;
  withinTargets: boolean;
}

export interface RestoreView {
  id: string;
  recoveryPoint: string;
  target: RestoreTarget;
  reason: string;
  status: RestoreStatus;
  requestedBy: string;
  requestedAt: string;
  approvedBy: string | undefined;
  decidedAt: string | undefined;
  decisionReason: string | undefined;
  startedAt: string | undefined;
  completedAt: string | undefined;
  restoredTo: string | undefined;
  sandboxRef: string | undefined;
  errorCode: string | undefined;
  reportRef: string | undefined;
  report: ReportView | undefined;
  version: number;
}

export interface RecoveryWindow {
  earliest: string;
  latest: string;
}

export interface RestorePage {
  tenantStatus: TenantStatus;
  window: RecoveryWindow | undefined;
  rpoTargetSeconds: number;
  rtoTargetSeconds: number;
  items: RestoreView[];
  nextCursor: string | undefined;
}

type Raw = Record<string, unknown>;
const isRecord = (value: unknown): value is Raw => typeof value === 'object' && value !== null;
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const optional = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);
const num = (value: unknown): number => (typeof value === 'number' ? value : 0);
const STATUSES: readonly string[] = ['Requested', 'Approved', 'Restoring', 'Verifying', 'Completed', 'Failed', 'Rejected'];
const TENANT_STATUSES: readonly string[] = ['Requested', 'Provisioning', 'Active', 'Failed', 'Suspended', 'Offboarding', 'Archived'];

function toMoney(raw: unknown): MoneyCheck[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item): MoneyCheck[] => (isRecord(item) && typeof item.column === 'string' ? [{ column: item.column, expected: text(item.expected), restored: text(item.restored), match: item.match === true }] : []));
}

function toTables(raw: unknown): TableCheck[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item): TableCheck[] =>
    isRecord(item) && typeof item.table === 'string'
      ? [{ table: item.table, expectedRows: num(item.expected_rows), restoredRows: num(item.restored_rows), rowsMatch: item.rows_match === true, checksumMatch: item.checksum_match === true, money: toMoney(item.money) }]
      : [],
  );
}

export function toReport(raw: unknown): ReportView | undefined {
  if (!isRecord(raw) || typeof raw.matched !== 'boolean') return undefined;
  const totals: Raw = isRecord(raw.totals) ? raw.totals : {};
  return {
    matched: raw.matched,
    tables: toTables(raw.tables),
    tablesCount: num(totals.tables),
    rowsExpected: num(totals.rows_expected),
    rowsRestored: num(totals.rows_restored),
    moneyExpected: text(totals.money_expected_vnd),
    moneyRestored: text(totals.money_restored_vnd),
    foreignRows: num(raw.foreign_rows),
    mismatches: Array.isArray(raw.mismatches) ? raw.mismatches.filter((item): item is string => typeof item === 'string') : [],
    rpoSeconds: num(raw.rpo_seconds),
    rtoSeconds: num(raw.rto_seconds),
    rpoTargetSeconds: num(raw.rpo_target_seconds),
    rtoTargetSeconds: num(raw.rto_target_seconds),
    withinTargets: raw.within_targets === true,
  };
}

export function toRestore(raw: unknown): RestoreView | undefined {
  if (!isRecord(raw) || typeof raw.id !== 'string') return undefined;
  return {
    id: raw.id,
    recoveryPoint: text(raw.recovery_point),
    target: raw.target === 'IN_PLACE' ? 'IN_PLACE' : 'SANDBOX',
    reason: text(raw.reason),
    status: STATUSES.includes(text(raw.status)) ? (raw.status as RestoreStatus) : 'Requested',
    requestedBy: text(raw.requested_by),
    requestedAt: text(raw.requested_at),
    approvedBy: optional(raw.approved_by),
    decidedAt: optional(raw.decided_at),
    decisionReason: optional(raw.decision_reason),
    startedAt: optional(raw.started_at),
    completedAt: optional(raw.completed_at),
    restoredTo: optional(raw.restored_to),
    sandboxRef: optional(raw.sandbox_ref),
    errorCode: optional(raw.error_code),
    reportRef: optional(raw.verification_report_ref),
    report: toReport(raw.verification_report),
    version: typeof raw.version === 'number' ? raw.version : 1,
  };
}

export function toRestorePage(raw: unknown): RestorePage | undefined {
  if (!isRecord(raw) || !TENANT_STATUSES.includes(text(raw.tenant_status))) return undefined;
  const window = isRecord(raw.recovery_window) && typeof raw.recovery_window.earliest === 'string' && typeof raw.recovery_window.latest === 'string' ? { earliest: raw.recovery_window.earliest, latest: raw.recovery_window.latest } : undefined;
  return {
    tenantStatus: raw.tenant_status as TenantStatus,
    window,
    rpoTargetSeconds: num(raw.rpo_target_seconds),
    rtoTargetSeconds: num(raw.rto_target_seconds),
    items: Array.isArray(raw.items) ? raw.items.flatMap((item) => toRestore(item) ?? []) : [],
    nextCursor: optional(raw.next_cursor),
  };
}

/** A restore the worker has taken up or is about to: the list is read again quickly while there is one. */
export const isRunning = (view: Pick<RestoreView, 'status'>): boolean => view.status === 'Approved' || view.status === 'Restoring' || view.status === 'Verifying';

/** A restore over the data of the tenant is asked for only while the tenant is Suspended. */
export const canAskInPlace = (status: TenantStatus): boolean => status === 'Suspended';
/** A tenant whose data exists can be restored from; one that was never provisioned, failed or archived cannot. */
export const canAskRestore = (status: TenantStatus): boolean => status === 'Active' || status === 'Suspended' || status === 'Offboarding';

/** Someone else decides: the person who asked sees the request wait for a second administrator. */
export const canDecide = (view: Pick<RestoreView, 'status' | 'requestedBy'>, membershipId: string | undefined, canManage: boolean): boolean =>
  canManage && view.status === 'Requested' && membershipId !== undefined && view.requestedBy.toLowerCase() !== membershipId.toLowerCase();

export const isReasonValid = (reason: string): boolean => reason.trim().length >= MIN_REASON && reason.trim().length <= MAX_REASON;

/** `2026-11-01T02:00` typed in a date-time field, read as UTC (the screen says so); undefined when it is not an instant. */
export function toInstant(local: string): string | undefined {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(local)) return undefined;
  const at = new Date(`${local}${local.length === 16 ? ':00' : ''}Z`);
  return Number.isNaN(at.getTime()) ? undefined : at.toISOString();
}

export const isInsideWindow = (instant: string, window: RecoveryWindow | undefined): boolean =>
  window !== undefined && new Date(instant).getTime() >= new Date(window.earliest).getTime() && new Date(instant).getTime() <= new Date(window.latest).getTime();

/** `2026-11-01T02:00:00.000Z` as the text of a date-time field. */
export const toLocalField = (instant: string): string => instant.slice(0, 16);

export type MismatchKind = 'rows' | 'checksum' | 'money' | 'missing_table' | 'unexpected_table' | 'foreign_rows' | 'other';
export interface MismatchView {
  kind: MismatchKind;
  subject: string;
}

const MISMATCH_KINDS: readonly string[] = ['rows', 'checksum', 'money', 'missing_table', 'unexpected_table'];

/** `rows:note` as a kind and the subject it is about; what the screen does not know is kept as it was written. */
export function toMismatch(code: string): MismatchView {
  if (code === 'foreign_rows') return { kind: 'foreign_rows', subject: '' };
  const at = code.indexOf(':');
  const kind = at < 0 ? '' : code.slice(0, at);
  return MISMATCH_KINDS.includes(kind) ? { kind: kind as MismatchKind, subject: code.slice(at + 1) } : { kind: 'other', subject: code };
}

/** Seconds as hours, minutes and seconds (`1:02:03`), for the RPO and the RTO. */
export function clock(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${Math.floor(whole / 3600)}:${pad(Math.floor((whole % 3600) / 60))}:${pad(whole % 60)}`;
}

export type ProblemReason = 'selfApproval' | 'conflict' | 'state' | 'notWaiting' | 'unavailable' | 'inProgress' | 'invalid' | 'denied' | 'notFound' | 'session' | 'general';
export interface ProblemView {
  reason: ProblemReason;
  field: string | undefined;
}

const REASON_BY_CODE: Readonly<Record<string, ProblemReason>> = {
  SELF_APPROVAL_DENIED: 'selfApproval',
  VERSION_CONFLICT: 'conflict',
  TENANT_STATE_INVALID: 'state',
  STAGE_TRANSITION_DENIED: 'notWaiting',
  RECOVERY_POINT_UNAVAILABLE: 'unavailable',
  RESTORE_IN_PROGRESS: 'inProgress',
  VALIDATION_FAILED: 'invalid',
  INVALID_REQUEST: 'invalid',
  SCOPE_DENIED: 'denied',
  ENTITLEMENT_DENIED: 'denied',
  RESOURCE_NOT_FOUND: 'notFound',
  SESSION_EXPIRED: 'session',
};

export function describeProblem(error: unknown): ProblemView {
  if (!(error instanceof ApiError)) return { reason: 'general', field: undefined };
  return { reason: REASON_BY_CODE[error.code] ?? 'general', field: error.detail };
}
