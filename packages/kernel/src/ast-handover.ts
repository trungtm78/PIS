import { assertNotProposer } from './contract-halt.ts';
import { DomainError } from './errors.ts';

/**
 * The handover of a work to the unit that receives it, and the punch list of what is still wrong with it (ST-AST-001, AST 3.1, BR-AST-01): the kinds, the statuses, the moves and who may make
 * them. Pure functions of their input, kept apart from the database so the cases of the receiving unit run without one.
 */

export const HANDOVER_KINDS = ['PARTIAL', 'COMPLETION', 'ASSET_TRANSFER'] as const;
export type HandoverKind = (typeof HANDOVER_KINDS)[number];

export const HANDOVER_STATUSES = ['DRAFT', 'INSPECTING', 'PUNCH_PENDING', 'ACCEPTED', 'REJECTED', 'CANCELLED'] as const;
export type HandoverStatus = (typeof HANDOVER_STATUSES)[number];

export const PUNCH_SEVERITIES = ['CRITICAL', 'MAJOR', 'MINOR'] as const;
export type PunchSeverity = (typeof PUNCH_SEVERITIES)[number];

export const PUNCH_STATUSES = ['OPEN', 'FIXED', 'VERIFIED', 'WAIVED'] as const;
export type PunchStatus = (typeof PUNCH_STATUSES)[number];

export const PUNCH_VERIFICATIONS = ['VERIFIED', 'REOPEN'] as const;
export type PunchVerification = (typeof PUNCH_VERIFICATIONS)[number];

export const HANDOVER_DECISIONS = ['approve', 'return', 'reject'] as const;
export type HandoverDecision = (typeof HANDOVER_DECISIONS)[number];

/** The statuses of a handover that still takes items on its punch list. */
const OPEN_FOR_ITEMS: readonly HandoverStatus[] = ['DRAFT', 'INSPECTING', 'PUNCH_PENDING'];

/** An item can be added until the receiving unit has decided: 409 `HANDOVER_STATE_INVALID` otherwise. */
export function assertCanAddPunchItem(status: HandoverStatus): void {
  if (!OPEN_FOR_ITEMS.includes(status)) throw new DomainError('HANDOVER_STATE_INVALID', 409, 'id', { extensions: { status } });
}

/**
 * Where a decision of the receiving unit takes a handover. A handover with a punch list is approved or given back from INSPECTING or PUNCH_PENDING, and one that has none yet (DRAFT) can be
 * approved as it is; every handover that was not decided can be rejected. A decided handover (ACCEPTED, REJECTED, CANCELLED) takes no decision: a rejected one is made again as a new file.
 */
export function assertHandoverDecision(decision: HandoverDecision, from: HandoverStatus): HandoverStatus {
  const ok = decision === 'approve' ? OPEN_FOR_ITEMS.includes(from) : decision === 'return' ? from === 'INSPECTING' || from === 'PUNCH_PENDING' : OPEN_FOR_ITEMS.includes(from);
  if (!ok) throw new DomainError('HANDOVER_STATE_INVALID', 409, 'id', { extensions: { status: from, decision } });
  return decision === 'approve' ? 'ACCEPTED' : decision === 'reject' ? 'REJECTED' : 'PUNCH_PENDING';
}

/** An item still blocks the acceptance while it is critical and not verified (BR-AST-01); a critical item is never waived, so waived ones do not enter. */
export const isOpenCritical = (severity: PunchSeverity, status: PunchStatus): boolean => severity === 'CRITICAL' && status !== 'VERIFIED';

/** The acceptance is refused while any item is open and critical (422 `OPEN_CRITICAL_PUNCH`, with the numbers of the items). */
export function assertNoOpenCritical(items: ReadonlyArray<{ itemNo: number; severity: PunchSeverity; status: PunchStatus }>): void {
  const open = items.filter((item) => isOpenCritical(item.severity, item.status));
  if (open.length > 0) throw new DomainError('OPEN_CRITICAL_PUNCH', 422, 'id', { extensions: { open_critical_punch_count: open.length, item_nos: open.map((item) => item.itemNo) } });
}

/** A contractor answers an item that is still open, and a verifier looks at an item that was answered: anything else is 409 `PUNCH_STATE_INVALID`. */
export function assertPunchMove(move: 'fix' | 'verify' | 'waive', status: PunchStatus): void {
  const ok = move === 'fix' ? status === 'OPEN' : move === 'verify' ? status === 'FIXED' : status === 'OPEN' || status === 'FIXED';
  if (!ok) throw new DomainError('PUNCH_STATE_INVALID', 409, 'id', { extensions: { status, move } });
}

/** A critical item is never waived, whatever its status (422 `CRITICAL_CANNOT_BE_WAIVED`). */
export function assertCanWaive(severity: PunchSeverity): void {
  if (severity === 'CRITICAL') throw new DomainError('CRITICAL_CANNOT_BE_WAIVED', 422, 'id');
}

/** The person who verifies that an item was put right is not the person who said it was (403 `SELF_APPROVAL_DENIED`). */
export function assertPunchVerifier(actor: string, fixedBy: string | null): void {
  assertNotProposer(actor, [fixedBy]);
}

/** The person who waives an item is not the person who put it on the list (403 `SELF_APPROVAL_DENIED`). */
export function assertPunchWaiver(actor: string, raisedBy: string): void {
  assertNotProposer(actor, [raisedBy]);
}

/** The receiving unit decides on a handover somebody else drew up (403 `SELF_APPROVAL_DENIED`). */
export function assertHandoverApprover(actor: string, draftedBy: string | null): void {
  assertNotProposer(actor, [draftedBy]);
}
