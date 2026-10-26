import { DomainError } from './errors.ts';
import type { RevisionStatus } from './dis-report.ts';

/** How long a draft that was deleted can be restored (DIS 3 F3; a working assumption until the capital owner signs it). */
export const RESTORE_WINDOW_DAYS = 30;
export const WITHDRAWAL_REASON_MIN = 20;
export const DELETION_REASON_MIN = 5;
export const LIFECYCLE_REASON_MAX = 2000;

const DAY_MS = 86_400_000;

/** The length of a text in characters, as the database counts them (a character outside the basic plane is one, not two). */
export const charactersOf = (text: string): number => [...text].length;

function reasonOf(value: unknown, min: number): string {
  const words = typeof value === 'string' ? value.trim() : '';
  const length = charactersOf(words);
  if (length < min || length > LIFECYCLE_REASON_MAX) throw new DomainError('VALIDATION_FAILED', 422, 'reason');
  return words;
}

/** Why a report that was handed in is taken back: words, at least 20 characters (422 `VALIDATION_FAILED` naming `reason`; the schema leaves the length to the command so that every refusal has one code). */
export const withdrawalOf = (raw: { reason?: unknown }): { reason: string } => ({ reason: reasonOf(raw.reason, WITHDRAWAL_REASON_MIN) });

/** Why a draft is deleted: words, at least 5 characters. */
export const deletionOf = (raw: { reason?: unknown }): { reason: string } => ({ reason: reasonOf(raw.reason, DELETION_REASON_MIN) });

const stateInvalid = (code: string, status: RevisionStatus): DomainError => new DomainError(code, 409, 'status', { extensions: { report_status: status } });

/** A report is withdrawn while it waits to be reviewed: handed in, and not yet under review (409 `REPORT_STATE_INVALID`). */
export function withdrawRefusal(status: RevisionStatus, deleted: boolean): DomainError | undefined {
  return status === 'SUBMITTED' && !deleted ? undefined : stateInvalid('REPORT_STATE_INVALID', status);
}

/** A draft that is live is deleted; a report that was handed in, or one that is deleted already, is not (409 `REPORT_NOT_EDITABLE`). */
export function deleteRefusal(status: RevisionStatus, deleted: boolean): DomainError | undefined {
  return status === 'DRAFT' && !deleted ? undefined : stateInvalid('REPORT_NOT_EDITABLE', status);
}

/** The last instant a deletion can be undone. */
export const restoreDeadline = (deletedAt: string): Date => new Date(new Date(deletedAt).getTime() + RESTORE_WINDOW_DAYS * DAY_MS);

/** A draft that was deleted is restored within the window (422 `RESTORE_WINDOW_EXPIRED` after it); what was not deleted is not restored (409 `REPORT_STATE_INVALID`). */
export function restoreRefusal(head: { status: RevisionStatus; deletedAt: string | null }, now: Date): DomainError | undefined {
  if (head.status !== 'DRAFT' || head.deletedAt === null) return stateInvalid('REPORT_STATE_INVALID', head.status);
  return now.getTime() > restoreDeadline(head.deletedAt).getTime() ? new DomainError('RESTORE_WINDOW_EXPIRED', 422, 'deleted_at') : undefined;
}
