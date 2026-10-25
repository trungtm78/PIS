import { DomainError } from './errors.ts';
import { assertNotProposer } from './contract-halt.ts';
import { signedDong, wholeVnd } from './pay-money.ts';

/**
 * Matching a Treasury transaction to a payment and the work on a difference (ST-PAY-007, PAY 3.3 steps 4 and 5, CXN-03). Whether an amount settles a request, the signed difference an item shows
 * and the moves an item may make are rules of the product, kept apart from the database so a test can run them and the migration can be read against them.
 */

export const RECONCILIATION_STATUSES = ['OPEN', 'EXPLAINED', 'RESOLVED', 'WRITTEN_OFF_APPROVED'] as const;
export type ReconciliationStatus = (typeof RECONCILIATION_STATUSES)[number];

export const RECONCILIATION_RESOLUTIONS = ['EXPLAINED', 'RESOLVED', 'WRITTEN_OFF'] as const;
export type ReconciliationResolution = (typeof RECONCILIATION_RESOLUTIONS)[number];

/** The statuses in which an item still waits for a person: it has an owner who is chased and a day by which it is due. */
export const WAITING_RECONCILIATION_STATUSES: readonly ReconciliationStatus[] = ['OPEN', 'EXPLAINED'];

export const isWaiting = (status: string): boolean => (WAITING_RECONCILIATION_STATUSES as readonly string[]).includes(status);

/**
 * The status an item reaches by a resolution, or undefined when the move is not allowed (409 `RECONCILIATION_STATE_INVALID`): an item is explained first, then resolved; a write-off
 * comes from an item that still waits. A status that ended (resolved, written off) goes nowhere.
 */
export function reconciliationTarget(from: ReconciliationStatus, resolution: ReconciliationResolution): ReconciliationStatus | undefined {
  if (resolution === 'EXPLAINED') return from === 'OPEN' ? 'EXPLAINED' : undefined;
  if (resolution === 'RESOLVED') return from === 'EXPLAINED' ? 'RESOLVED' : undefined;
  return isWaiting(from) ? 'WRITTEN_OFF_APPROVED' : undefined;
}

/** Whether the amount the Treasury confirmed is the net of the request, to the dong: the only case in which a transaction settles it. The larger figure is never taken. */
export function amountsAgree(netVnd: string, confirmedVnd: string): boolean {
  return signedDong(netVnd, 'net_vnd') === wholeVnd(confirmedVnd, 'amount_vnd');
}

/** The difference an item shows: what the Treasury confirmed less what the request is worth, signed (a shortfall is negative). */
export function reconciliationDifference(internalVnd: string, confirmedVnd: string): string {
  return (wholeVnd(confirmedVnd, 'confirmed_amount_vnd') - signedDong(internalVnd, 'internal_amount_vnd')).toString();
}

/**
 * A write-off needs the document that approves it (422 `APPROVAL_REQUIRED`) and a person other than the one who owns the difference (403 `SELF_APPROVAL_DENIED`); the document is asked for
 * first, so a person who forgot it is told what is missing before being told who may not sign.
 */
export function assertWriteOff(input: { ownerMembershipId: string; actor: string; approvalDocumentVersionId: string | undefined }): void {
  if (input.approvalDocumentVersionId === undefined) throw new DomainError('APPROVAL_REQUIRED', 422, 'approval_document_version_id');
  assertNotProposer(input.actor, [input.ownerMembershipId]);
}

/** The words of a note or a reason that a person wrote, trimmed; 422 `VALIDATION_FAILED` naming the field when nothing is left. */
export function requiredNote(value: string | undefined, field: string, max = 2000): string {
  const text = value?.trim() ?? '';
  if (text === '' || text.length > max) throw new DomainError('VALIDATION_FAILED', 422, field);
  return text;
}
