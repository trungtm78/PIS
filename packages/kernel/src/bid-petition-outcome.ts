import { DomainError } from './errors.ts';

/**
 * The recorded outcome of a petition of a contractor (PORTAL-2; docs/plans/portal2.md). A petition is answered or passed up by the petition module; what the authority DECIDED is recorded here: upheld (the contractor was
 * right), rejected, or withdrawn by the contractor. One person records it, a different person confirms or returns it with a reason, a confirmed outcome is final. Only confirmed outcomes feed the dispute figures.
 */

export const PETITION_DECISIONS = ['UPHELD', 'REJECTED', 'WITHDRAWN'] as const;
export type PetitionDecision = (typeof PETITION_DECISIONS)[number];
export const PETITION_OUTCOME_STATUSES = ['PROPOSED', 'CONFIRMED', 'RETURNED'] as const;
export type PetitionOutcomeStatus = (typeof PETITION_OUTCOME_STATUSES)[number];
export const PETITION_OUTCOME_MOVES = ['CONFIRM', 'RETURN'] as const;
export type PetitionOutcomeMove = (typeof PETITION_OUTCOME_MOVES)[number];

/** The decision recorded for a petition in `status`. UPHELD and REJECTED need an answered (RESOLVED) or passed-up (ESCALATED) petition; WITHDRAWN is possible while the petition waits or has been passed up. 422 `PETITION_OUTCOME_NOT_ALLOWED` otherwise. */
export function assertDecisionAllowed(decision: string, petitionStatus: string): PetitionDecision {
  const found = PETITION_DECISIONS.find((candidate) => candidate === decision);
  if (found === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'outcome');
  const allowed: Readonly<Record<PetitionDecision, readonly string[]>> = {
    UPHELD: ['RESOLVED', 'ESCALATED'],
    REJECTED: ['RESOLVED', 'ESCALATED'],
    WITHDRAWN: ['RECEIVED', 'PROCESSING', 'ESCALATED'],
  };
  if (!allowed[found].includes(petitionStatus)) throw new DomainError('PETITION_OUTCOME_NOT_ALLOWED', 422, 'outcome', { extensions: { petition_status: petitionStatus } });
  return found;
}

/** Confirmed or returned from PROPOSED only; 409 `PETITION_OUTCOME_STATE_INVALID` otherwise, 422 for a missing reason when returning. */
export function nextOutcomeStatus(current: PetitionOutcomeStatus, move: PetitionOutcomeMove, reason?: string | null): PetitionOutcomeStatus {
  if (current !== 'PROPOSED') throw new DomainError('PETITION_OUTCOME_STATE_INVALID', 409, 'status', { extensions: { outcome_status: current } });
  if (move === 'RETURN') {
    if (reason === undefined || reason === null || reason.trim().length < 5) throw new DomainError('VALIDATION_FAILED', 422, 'reason');
    return 'RETURNED';
  }
  return 'CONFIRMED';
}

/** The person who confirms is never the person who recorded (403 `SCOPE_DENIED`). */
export function assertChecker(recordedBy: string, checkedBy: string): void {
  if (recordedBy.toLowerCase() === checkedBy.toLowerCase()) throw new DomainError('SCOPE_DENIED', 403, 'checked_by');
}

/** How a confirmed decision folds into the four words of the dispute figures. */
export const DECISION_TO_DISPUTE: Readonly<Record<PetitionDecision, 'UPHELD' | 'REJECTED' | 'WITHDRAWN'>> = { UPHELD: 'UPHELD', REJECTED: 'REJECTED', WITHDRAWN: 'WITHDRAWN' };
