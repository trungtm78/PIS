import { DomainError } from './errors.ts';

/**
 * The four-eyes rule (maker-checker): the person who proposed a change may not be the one who approves or publishes it.
 * Ids are compared by value, not by letter case; a missing id is a malformed request, never "a different person".
 */
export function assertFourEyes(maker: string, checker: string): void {
  if (maker === '' || checker === '') throw new DomainError('INVALID_REQUEST', 400);
  if (maker.toLowerCase() === checker.toLowerCase()) throw new DomainError('SELF_APPROVAL_DENIED', 403);
}

export const CHANGE_REQUEST_STATES = ['Draft', 'Submitted', 'Approved', 'Rejected', 'Applied'] as const;
export type ChangeRequestState = (typeof CHANGE_REQUEST_STATES)[number];
export type ChangeRequestAction = 'submit' | 'approve' | 'reject' | 'apply' | 'reopen';

const NEXT: Readonly<Record<ChangeRequestState, Readonly<Partial<Record<ChangeRequestAction, ChangeRequestState>>>>> = {
  Draft: { submit: 'Submitted' },
  Submitted: { approve: 'Approved', reject: 'Rejected' },
  Approved: { apply: 'Applied' },
  Rejected: { reopen: 'Draft' },
  Applied: {},
};

export function canTransition(from: ChangeRequestState, action: ChangeRequestAction): boolean {
  return NEXT[from][action] !== undefined;
}

/** The state after `action`, or 409 STAGE_TRANSITION_DENIED naming the state and the action (never a value of the request). */
export function changeRequestNext(from: ChangeRequestState, action: ChangeRequestAction): ChangeRequestState {
  const next = NEXT[from][action];
  if (next === undefined) throw new DomainError('STAGE_TRANSITION_DENIED', 409, `${from}->${action}`);
  return next;
}
