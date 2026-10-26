import type { components } from '@machvon/contracts';
import { ApiError } from '@machvon/api-client';
import type { ReportDetail, ReportStatus } from './model';

/** DIS-09: the confirmation that names the report before it is deleted or taken back, and the restore of a draft that was deleted (ST-DIS-007, DIS 3 F3). */
export const REMOVAL_PATH = '/dis/dis-09';

/** The permissions that gate the buttons; the server decides again on every request, and on a restore it judges the permission of the person now. */
export const WITHDRAW_PERMISSION = 'report.withdraw';
export const DELETE_PERMISSION = 'report.edit';

/** How long a draft that was deleted can be restored (the same 30 days as the server). */
export const RESTORE_WINDOW_DAYS = 30;
const DAY_MS = 86_400_000;

type Mode = 'FULL' | 'READ_ONLY' | undefined;
const allowed = (permissions: readonly string[] | undefined, permission: string, mode: Mode): boolean => (permissions === undefined || permissions.includes(permission)) && mode !== 'READ_ONLY';

/** The maker takes back a report that was handed in and is not being reviewed. */
export const canWithdraw = (permissions: readonly string[] | undefined, mode: Mode, status: ReportStatus): boolean => status === 'SUBMITTED' && allowed(permissions, WITHDRAW_PERMISSION, mode);
/** A draft that stands is deleted by a person who may edit it. */
export const canDelete = (permissions: readonly string[] | undefined, mode: Mode, detail: Pick<ReportDetail, 'status' | 'deleted'>): boolean => detail.status === 'DRAFT' && !detail.deleted && allowed(permissions, DELETE_PERMISSION, mode);
/** A draft that was deleted is restored by a person who may edit it. */
export const canRestore = (permissions: readonly string[] | undefined, mode: Mode, detail: Pick<ReportDetail, 'status' | 'deleted'>): boolean => detail.status === 'DRAFT' && detail.deleted && allowed(permissions, DELETE_PERMISSION, mode);

/** The last instant a deletion can be undone. */
export const restoreDeadline = (deletedAt: string): Date => new Date(new Date(deletedAt).getTime() + RESTORE_WINDOW_DAYS * DAY_MS);
export const canStillRestore = (deletedAt: string, now: Date): boolean => now.getTime() <= restoreDeadline(deletedAt).getTime();

export const WITHDRAWAL_REASON_MIN = 20;
export const DELETION_REASON_MIN = 5;
const REASON_MAX = 2000;
export type ReasonProblem = 'required' | 'tooShort' | 'tooLong';

/** What the form can tell before the server does: the reason is words, long enough for what it is for. */
export function validateRemovalReason(reason: string, min: number): ReasonProblem | undefined {
  const words = reason.trim();
  if (words === '') return 'required';
  // In characters, as the database counts them (an emoji is one).
  const length = [...words].length;
  if (length < min) return 'tooShort';
  return length > REASON_MAX ? 'tooLong' : undefined;
}

export type WithdrawalBody = components['schemas']['DisWithdrawal'];
export type DeletionBody = components['schemas']['DisDraftDeletion'];

export const reasonBody = (reason: string): WithdrawalBody => ({ reason: reason.trim() });

/** What a refusal of one of the three commands is called on the screen. */
export type RemovalProblem = 'stateChanged' | 'periodLocked' | 'windowExpired' | 'versionConflict' | 'scopeDenied' | 'reasonInvalid' | 'notFound' | 'general';

const PROBLEM_BY_CODE: Readonly<Record<string, RemovalProblem>> = {
  REPORT_STATE_INVALID: 'stateChanged',
  REPORT_NOT_EDITABLE: 'stateChanged',
  PERIOD_LOCKED: 'periodLocked',
  RESTORE_WINDOW_EXPIRED: 'windowExpired',
  VERSION_CONFLICT: 'versionConflict',
  SCOPE_DENIED: 'scopeDenied',
  VALIDATION_FAILED: 'reasonInvalid',
  INVALID_REQUEST: 'reasonInvalid',
  RESOURCE_NOT_FOUND: 'notFound',
  DRAFT_EXISTS: 'stateChanged',
};

export const describeRemoval = (error: unknown): RemovalProblem => (error instanceof ApiError ? (PROBLEM_BY_CODE[error.code] ?? 'general') : 'general');
