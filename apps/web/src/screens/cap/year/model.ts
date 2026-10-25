import { ApiError } from '@machvon/api-client';

/** The permissions of CAP-11 (x-permission of the operations in openapi.json). */
export const READ_PERMISSION = 'capital.read';
export const CLOSE_PERMISSION = 'capital.year.close';
export const REOPEN_PERMISSION = 'capital.year.reopen';

export const YEAR_STATUSES = ['OPEN', 'SOFT_CLOSED', 'LOCKED'] as const;
export type YearStatus = (typeof YEAR_STATUSES)[number];
export type CloseTarget = 'SOFT_CLOSED' | 'LOCKED';

export const MIN_CLOSE_REASON = 5;
export const MAX_REASON = 2000;
export const MIN_REOPEN_REASON = 20;
export const MIN_WINDOW_HOURS = 1;
export const MAX_WINDOW_HOURS = 168;
export const DEFAULT_WINDOW_HOURS = 24;

export interface YearRow {
  year: number;
  status: YearStatus;
  /** The If-Match of the next close or reopening; a year the control does not know is open with version 1. */
  version: number;
  softClosedAt: string | undefined;
  softClosedBy: string | undefined;
  lockedAt: string | undefined;
  lockedBy: string | undefined;
  closeReason: string | undefined;
  reopenReason: string | undefined;
  reopenedAt: string | undefined;
  reopenedUntil: string | undefined;
  reopenApprovedBy: string | undefined;
}

type Raw = Record<string, unknown>;
const isRecord = (value: unknown): value is Raw => typeof value === 'object' && value !== null;
const optionalText = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

export function toYear(raw: unknown): YearRow | undefined {
  const row: Raw = isRecord(raw) ? raw : {};
  if (typeof row.plan_year !== 'number' || !Number.isInteger(row.plan_year)) return undefined;
  return {
    year: row.plan_year,
    status: YEAR_STATUSES.find((candidate) => candidate === row.status) ?? 'OPEN',
    version: count(row.version) || 1,
    softClosedAt: optionalText(row.soft_closed_at),
    softClosedBy: optionalText(row.soft_closed_by),
    lockedAt: optionalText(row.locked_at),
    lockedBy: optionalText(row.locked_by),
    closeReason: optionalText(row.close_reason),
    reopenReason: optionalText(row.reopen_reason),
    reopenedAt: optionalText(row.reopened_at),
    reopenedUntil: optionalText(row.reopened_until),
    reopenApprovedBy: optionalText(row.reopen_approved_by),
  };
}

/** A year the control does not know is open, with version 1. */
export const openYear = (year: number): YearRow => ({
  year,
  status: 'OPEN',
  version: 1,
  softClosedAt: undefined,
  softClosedBy: undefined,
  lockedAt: undefined,
  lockedBy: undefined,
  closeReason: undefined,
  reopenReason: undefined,
  reopenedAt: undefined,
  reopenedUntil: undefined,
  reopenApprovedBy: undefined,
});

/** The years of the choice: the ones the control knows and the years around today, the latest first. */
export function yearChoices(rows: readonly YearRow[], today: Date): number[] {
  const current = today.getUTCFullYear();
  return [...new Set([...rows.map((row) => row.year), current - 1, current, current + 1])].sort((a, b) => b - a);
}

/** What the person may do to a year in its state: open years are closed, soft-closed years are locked, locked years are reopened. */
export function actionsFor(status: YearStatus): Array<'SOFT_CLOSE' | 'LOCK' | 'REOPEN'> {
  if (status === 'OPEN') return ['SOFT_CLOSE', 'LOCK'];
  return status === 'SOFT_CLOSED' ? ['LOCK'] : ['REOPEN'];
}

// ---- the forms ------------------------------------------------------------------------------------------------------------------------

export interface YearForm {
  reason: string;
  hours: string;
}

export const EMPTY_FORM: YearForm = { reason: '', hours: String(DEFAULT_WINDOW_HOURS) };

export type FormField = 'reason' | 'hours';
export type FieldProblem = 'closeReasonLength' | 'reopenReasonLength' | 'hoursInvalid';

export function validateClose(form: YearForm): Partial<Record<FormField, FieldProblem>> {
  const reason = form.reason.trim();
  return reason.length < MIN_CLOSE_REASON || reason.length > MAX_REASON ? { reason: 'closeReasonLength' } : {};
}

export function validateReopen(form: YearForm): Partial<Record<FormField, FieldProblem>> {
  const problems: Partial<Record<FormField, FieldProblem>> = {};
  const reason = form.reason.trim();
  if (reason.length < MIN_REOPEN_REASON || reason.length > MAX_REASON) problems.reason = 'reopenReasonLength';
  const hours = Number(form.hours.trim());
  if (form.hours.trim() === '' || !Number.isInteger(hours) || hours < MIN_WINDOW_HOURS || hours > MAX_WINDOW_HOURS) problems.hours = 'hoursInvalid';
  return problems;
}

// ---- refusals ---------------------------------------------------------------------------------------------------------------------------

export type ProblemReason =
  | 'plansPending'
  | 'reservationsActive'
  | 'alreadyLocked'
  | 'alreadySoftClosed'
  | 'notLocked'
  | 'selfApproval'
  | 'reasonRequired'
  | 'conflict'
  | 'invalid'
  | 'denied'
  | 'notFound'
  | 'session'
  | 'general';

export interface ProblemView {
  reason: ProblemReason;
  field: string | undefined;
  /** The plans (or reservations) that stand in the way of a close. */
  blockers: number;
}

export function describeProblem(error: unknown): ProblemView {
  if (!(error instanceof ApiError)) return { reason: 'general', field: undefined, blockers: 0 };
  const why = optionalText(error.extensions.reason);
  const list = Array.isArray(error.extensions.plan_ids) ? error.extensions.plan_ids : Array.isArray(error.extensions.reservation_ids) ? error.extensions.reservation_ids : [];
  const base = { field: error.detail, blockers: list.length };
  switch (error.code) {
    case 'YEAR_STATE_INVALID':
      return {
        ...base,
        reason:
          why === 'PLANS_PENDING'
            ? 'plansPending'
            : why === 'RESERVATIONS_ACTIVE'
              ? 'reservationsActive'
              : why === 'ALREADY_SOFT_CLOSED'
                ? 'alreadySoftClosed'
                : why === 'NOT_LOCKED'
                  ? 'notLocked'
                  : 'alreadyLocked',
      };
    case 'SELF_APPROVAL_DENIED':
      return { ...base, reason: 'selfApproval' };
    case 'REOPEN_REASON_REQUIRED':
      return { ...base, reason: 'reasonRequired' };
    case 'VERSION_CONFLICT':
      return { ...base, reason: 'conflict' };
    case 'VALIDATION_FAILED':
    case 'INVALID_REQUEST':
    case 'FIELD_NOT_ALLOWED':
      return { ...base, reason: 'invalid' };
    case 'SCOPE_DENIED':
    case 'ENTITLEMENT_DENIED':
      return { ...base, reason: 'denied' };
    case 'RESOURCE_NOT_FOUND':
      return { ...base, reason: 'notFound' };
    case 'SESSION_EXPIRED':
      return { ...base, reason: 'session' };
    default:
      return { ...base, reason: 'general' };
  }
}
