import { DomainError } from './errors.ts';

export const RECOMMENDATION_STATUSES = ['OPEN', 'ASSIGNED', 'IN_PROGRESS', 'PENDING_VERIFICATION', 'CLOSED', 'DISPUTED', 'CANCELLED'] as const;
export type RecommendationStatus = (typeof RECOMMENDATION_STATUSES)[number];

/** The commands that move a recommendation (AUD 4); `reopen` is the system's, when a recovery is reversed, and `cancel` belongs to the amended conclusions (ST-AUD-007). */
export type RecommendationAction = 'assign' | 'plan' | 'submit' | 'verifyClose' | 'verifyReturn' | 'dispute' | 'decideAccepted' | 'decideRejected' | 'reopen' | 'cancel';

interface Edge {
  from: readonly RecommendationStatus[];
  to: RecommendationStatus;
}

/**
 * The only place that names the edges of a recommendation. Planning an action moves ASSIGNED to IN_PROGRESS once and leaves IN_PROGRESS where it is (a second action is another row, not another
 * edge); an assignment may be repeated before work begins (another owner or another day); a dispute is raised while the work is assigned or going on, and the authority's answer sends it back
 * to work (rejected) or to the verifier (accepted).
 */
export const RECOMMENDATION_EDGES: Readonly<Record<RecommendationAction, Edge>> = {
  assign: { from: ['OPEN', 'ASSIGNED'], to: 'ASSIGNED' },
  plan: { from: ['ASSIGNED', 'IN_PROGRESS'], to: 'IN_PROGRESS' },
  submit: { from: ['IN_PROGRESS'], to: 'PENDING_VERIFICATION' },
  verifyClose: { from: ['PENDING_VERIFICATION'], to: 'CLOSED' },
  verifyReturn: { from: ['PENDING_VERIFICATION'], to: 'IN_PROGRESS' },
  dispute: { from: ['ASSIGNED', 'IN_PROGRESS'], to: 'DISPUTED' },
  decideAccepted: { from: ['DISPUTED'], to: 'PENDING_VERIFICATION' },
  decideRejected: { from: ['DISPUTED'], to: 'IN_PROGRESS' },
  reopen: { from: ['CLOSED'], to: 'IN_PROGRESS' },
  cancel: { from: ['OPEN', 'ASSIGNED'], to: 'CANCELLED' },
};

/** The statuses in which a recommendation counts as overdue when its day has passed (BR-AUD-06): not closed, not cancelled, and not while the owner's explanation is being decided. */
export const OVERDUE_EXEMPT_STATUSES: readonly RecommendationStatus[] = ['CLOSED', 'CANCELLED', 'DISPUTED'];

/** The status a command leads to, or 409 `RECOMMENDATION_STATE_INVALID` naming the edge that is not there. */
export function nextRecommendationStatus(status: RecommendationStatus, action: RecommendationAction): RecommendationStatus {
  const edge = RECOMMENDATION_EDGES[action];
  if (!edge.from.includes(status)) throw new DomainError('RECOMMENDATION_STATE_INVALID', 409, `${status}->${action}`);
  return edge.to;
}

export interface Hands {
  ownerUserId: string | null;
  submittedBy: string | null;
  disputedBy: string | null;
}

/**
 * BR-AUD-08: nobody verifies their own work. The verifier is neither the one who reported the work done, nor the one whose explanation of a dispute the authority accepted, nor the person the
 * recommendation was assigned to (403 `SELF_APPROVAL_DENIED`). The table holds the same rule for a closed recommendation.
 */
export function assertNotOwnWork(actor: string, hands: Hands): void {
  const who = actor.toLowerCase();
  for (const other of [hands.ownerUserId, hands.submittedBy, hands.disputedBy]) {
    if (other !== null && other.toLowerCase() === who) throw new DomainError('SELF_APPROVAL_DENIED', 403);
  }
}

/**
 * BR-AUD-06 [CXN-AUD-01]: the day a recommendation is due is read from the conclusion, never from a constant. It is not in the past, and not after the implementation deadline the conclusion
 * states (422 `DUE_AFTER_CONCLUSION_DEADLINE`) when it states one; a conclusion that states none leaves the day to the one who assigns.
 */
export function assertDueDay(dueOn: string, today: string, deadline: string | null): void {
  if (dueOn < today) throw new DomainError('VALIDATION_FAILED', 422, 'due_on');
  if (deadline !== null && dueOn > deadline) throw new DomainError('DUE_AFTER_CONCLUSION_DEADLINE', 422, 'due_on', { extensions: { implementation_due_on: deadline } });
}

/**
 * BR-AUD-04 and the table `fin_close_chk`: a financial recommendation is closed when what was recovered equals what was recommended, or when the authority accepted the dispute (the part not
 * recovered is then not owed). 422 `RECOVERY_INCOMPLETE` otherwise, with the figures; one that is not financial has no money to wait for.
 */
export function assertRecoveryComplete(input: { financial: boolean; amountVnd: string | null; recoveredVnd: string; disputeAccepted: boolean }): void {
  if (!input.financial || input.disputeAccepted) return;
  const amount = BigInt(input.amountVnd ?? '0');
  const recovered = BigInt(input.recoveredVnd);
  if (recovered !== amount) {
    throw new DomainError('RECOVERY_INCOMPLETE', 422, 'recovered_vnd', { extensions: { amount_vnd: amount.toString(), recovered_vnd: recovered.toString(), remaining_vnd: (amount - recovered).toString() } });
  }
}
