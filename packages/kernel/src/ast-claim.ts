import { DomainError } from './errors.ts';
import { assertNotProposer } from './contract-halt.ts';
import { hasRunOut } from './ast-warranty.ts';
import type { ClaimStatus } from './ast-warranty.ts';

/**
 * A warranty claim and the answer to it (ST-AST-004, AST 3.3, BR-AST-03, UAT-AC390, UAT-AC391): the severities, who bears the cost, the day the contractor has to answer by, the moves of the status and the
 * people who may not verify a repair. Pure functions of their input, kept apart from the database.
 */

export const CLAIM_SEVERITIES = ['CRITICAL', 'MAJOR', 'MINOR'] as const;
export type ClaimSeverity = (typeof CLAIM_SEVERITIES)[number];

export const COST_BEARERS = ['CONTRACTOR', 'OWNER', 'THIRD_PARTY', 'UNDETERMINED'] as const;
export type CostBearer = (typeof COST_BEARERS)[number];

export const CLAIM_VERIFICATIONS = ['VERIFIED', 'DISPUTED'] as const;
export type ClaimVerification = (typeof CLAIM_VERIFICATIONS)[number];

/**
 * The days the contractor has to answer a claim in: seven, counted from the day it was reported. The term is an [ASSUMPTION] of the specification (R-AST-03: it belongs to the rules of the tenant or to the terms of
 * the contract, neither of which is stated), so it is kept in this one place.
 */
export const CLAIM_RESPONSE_DAYS = 7;

/** The last day the contractor can answer by: the day of the report plus the days of the term. Days are `YYYY-MM-DD`. */
export function responseDueOn(reportedOn: string): string {
  const [year, month, day] = reportedOn.split('-').map(Number);
  return new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, (day ?? 1) + CLAIM_RESPONSE_DAYS)).toISOString().slice(0, 10);
}

/** A claim is valid only when it is reported before the warranty ends (BR-AST-03): from the last day on, 422 `WARRANTY_EXPIRED`. */
export function assertWithinWarranty(reportedOn: string, endsOn: string): void {
  if (hasRunOut(endsOn, reportedOn)) throw new DomainError('WARRANTY_EXPIRED', 422, 'reported_on', { extensions: { ends_on: endsOn } });
}

/** An unanswered claim whose day to answer by has gone is overdue: the day after the due day on, while it is still OPEN. */
export const isResponseOverdue = (status: ClaimStatus, dueOn: string, today: string): boolean => status === 'OPEN' && today > dueOn;

/** What is done to a claim: the contractor acknowledges it, says it is put right (again after a dispute), and somebody else verifies or disputes the repair. */
export type ClaimMove = 'ACKNOWLEDGE' | 'FIX' | 'VERIFY' | 'DISPUTE';

const MOVES: Readonly<Record<ClaimMove, { from: readonly ClaimStatus[]; to: ClaimStatus }>> = {
  ACKNOWLEDGE: { from: ['OPEN'], to: 'ACKNOWLEDGED' },
  FIX: { from: ['ACKNOWLEDGED', 'REPAIRING', 'DISPUTED'], to: 'FIXED' },
  VERIFY: { from: ['FIXED'], to: 'VERIFIED' },
  DISPUTE: { from: ['FIXED'], to: 'DISPUTED' },
};

/** The status after the move; any other start is 409 `CLAIM_STATE_INVALID` with the status the claim is in. */
export function nextClaimStatus(from: ClaimStatus, move: ClaimMove): ClaimStatus {
  const rule = MOVES[move];
  if (!rule.from.includes(from)) throw new DomainError('CLAIM_STATE_INVALID', 409, 'status', { extensions: { status: from } });
  return rule.to;
}

/** The person who verifies a repair is neither the person who reported the defect nor the one who said it was put right (403 `SELF_APPROVAL_DENIED`). */
export function assertClaimVerifier(actor: string, reportedBy: string, fixedBy: string | null): void {
  assertNotProposer(actor, [reportedBy, fixedBy]);
}
