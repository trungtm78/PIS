import {
  OVERDUE_EXEMPT_STATUSES,
  RECOMMENDATION_EDGES,
  RECOMMENDATION_STATUSES,
  assertDueDay,
  assertNotOwnWork,
  assertRecoveryComplete,
  nextRecommendationStatus,
} from '../src/aud-recommendation.ts';
import type { RecommendationAction, RecommendationStatus } from '../src/aud-recommendation.ts';
import { DomainError } from '../src/errors.ts';

const refusal = (work: () => unknown): DomainError => {
  try {
    work();
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    return error as DomainError;
  }
  throw new Error('expected a refusal');
};

const PEOPLE = { owner: '00000000-0000-4000-8000-0000000000a1', reporter: '00000000-0000-4000-8000-0000000000a2', disputer: '00000000-0000-4000-8000-0000000000a3', verifier: '00000000-0000-4000-8000-0000000000a4' };

describe('the state machine of a recommendation (AUD 4)', () => {
  it('leads OPEN to ASSIGNED to IN_PROGRESS to PENDING_VERIFICATION to CLOSED, and back to work from a return', () => {
    expect(nextRecommendationStatus('OPEN', 'assign')).toBe('ASSIGNED');
    expect(nextRecommendationStatus('ASSIGNED', 'assign')).toBe('ASSIGNED');
    expect(nextRecommendationStatus('ASSIGNED', 'plan')).toBe('IN_PROGRESS');
    expect(nextRecommendationStatus('IN_PROGRESS', 'plan')).toBe('IN_PROGRESS');
    expect(nextRecommendationStatus('IN_PROGRESS', 'submit')).toBe('PENDING_VERIFICATION');
    expect(nextRecommendationStatus('PENDING_VERIFICATION', 'verifyClose')).toBe('CLOSED');
    expect(nextRecommendationStatus('PENDING_VERIFICATION', 'verifyReturn')).toBe('IN_PROGRESS');
    expect(nextRecommendationStatus('CLOSED', 'reopen')).toBe('IN_PROGRESS');
  });

  it('sends a dispute to the authority and back: rejected to work, accepted to the verifier', () => {
    expect(nextRecommendationStatus('ASSIGNED', 'dispute')).toBe('DISPUTED');
    expect(nextRecommendationStatus('IN_PROGRESS', 'dispute')).toBe('DISPUTED');
    expect(nextRecommendationStatus('DISPUTED', 'decideRejected')).toBe('IN_PROGRESS');
    expect(nextRecommendationStatus('DISPUTED', 'decideAccepted')).toBe('PENDING_VERIFICATION');
  });

  it('refuses OPEN to CLOSED, a submission before the work, a verification of work not reported and any step out of CLOSED but the reopening, each with 409 RECOMMENDATION_STATE_INVALID', () => {
    const cases: Array<[RecommendationStatus, RecommendationAction]> = [
      ['OPEN', 'verifyClose'],
      ['OPEN', 'submit'],
      ['OPEN', 'plan'],
      ['ASSIGNED', 'submit'],
      ['ASSIGNED', 'verifyClose'],
      ['IN_PROGRESS', 'verifyClose'],
      ['CLOSED', 'assign'],
      ['CLOSED', 'dispute'],
      ['DISPUTED', 'plan'],
      ['PENDING_VERIFICATION', 'dispute'],
      ['CANCELLED', 'assign'],
    ];
    for (const [status, action] of cases) {
      const error = refusal(() => nextRecommendationStatus(status, action));
      expect([error.status, error.code, error.detail]).toEqual([409, 'RECOMMENDATION_STATE_INVALID', `${status}->${action}`]);
    }
  });

  it('allows each command from exactly the statuses of its edge and no other', () => {
    for (const action of Object.keys(RECOMMENDATION_EDGES) as RecommendationAction[]) {
      for (const status of RECOMMENDATION_STATUSES) {
        const allowed = RECOMMENDATION_EDGES[action].from.includes(status);
        if (allowed) expect(nextRecommendationStatus(status, action)).toBe(RECOMMENDATION_EDGES[action].to);
        else expect(refusal(() => nextRecommendationStatus(status, action)).code).toBe('RECOMMENDATION_STATE_INVALID');
      }
    }
  });

  it('exempts the closed, the cancelled and the disputed from being overdue', () => {
    expect([...OVERDUE_EXEMPT_STATUSES].sort()).toEqual(['CANCELLED', 'CLOSED', 'DISPUTED']);
  });
});

describe('nobody verifies their own work (BR-AUD-08)', () => {
  const hands = { ownerUserId: PEOPLE.owner, submittedBy: PEOPLE.reporter, disputedBy: PEOPLE.disputer };

  it('AC-ST-AUD-003-2: refuses the owner, the one who reported the work and the one who raised the dispute with 403 SELF_APPROVAL_DENIED, whatever the case of the id', () => {
    for (const who of [PEOPLE.owner, PEOPLE.reporter, PEOPLE.disputer, PEOPLE.owner.toUpperCase()]) {
      const error = refusal(() => assertNotOwnWork(who, hands));
      expect([error.status, error.code]).toEqual([403, 'SELF_APPROVAL_DENIED']);
    }
  });

  it('lets another person verify, and does not mind the hands that are not there', () => {
    expect(() => assertNotOwnWork(PEOPLE.verifier, hands)).not.toThrow();
    expect(() => assertNotOwnWork(PEOPLE.verifier, { ownerUserId: null, submittedBy: null, disputedBy: null })).not.toThrow();
    expect(() => assertNotOwnWork(PEOPLE.owner, { ownerUserId: null, submittedBy: PEOPLE.reporter, disputedBy: null })).not.toThrow();
  });
});

describe('the day a recommendation is due (BR-AUD-06, CXN-AUD-01)', () => {
  it('is today or later and not after the implementation deadline of the conclusion', () => {
    expect(() => assertDueDay('2026-12-31', '2026-10-26', '2026-12-31')).not.toThrow();
    expect(() => assertDueDay('2026-10-26', '2026-10-26', '2026-12-31')).not.toThrow();
    expect(() => assertDueDay('2027-06-30', '2026-10-26', null)).not.toThrow();
  });

  it('AC-ST-AUD-003-1: a day after the deadline is 422 DUE_AFTER_CONCLUSION_DEADLINE with the deadline, and a day in the past is a field problem', () => {
    const late = refusal(() => assertDueDay('2027-01-01', '2026-10-26', '2026-12-31'));
    expect([late.status, late.code, late.detail, late.extensions]).toEqual([422, 'DUE_AFTER_CONCLUSION_DEADLINE', 'due_on', { implementation_due_on: '2026-12-31' }]);
    const past = refusal(() => assertDueDay('2026-10-25', '2026-10-26', '2026-12-31'));
    expect([past.status, past.code, past.detail]).toEqual([422, 'VALIDATION_FAILED', 'due_on']);
  });
});

describe('the money of a recommendation that is to be closed (BR-AUD-04)', () => {
  it('closes a financial one when everything was recovered, or when the authority accepted the dispute, and one that is not financial at any time', () => {
    expect(() => assertRecoveryComplete({ financial: true, amountVnd: '400000000', recoveredVnd: '400000000', disputeAccepted: false })).not.toThrow();
    expect(() => assertRecoveryComplete({ financial: true, amountVnd: '400000000', recoveredVnd: '300000000', disputeAccepted: true })).not.toThrow();
    expect(() => assertRecoveryComplete({ financial: false, amountVnd: null, recoveredVnd: '0', disputeAccepted: false })).not.toThrow();
  });

  it('AC-ST-AUD-003-3: refuses a financial one that is not recovered in full and not accepted, with 422 RECOVERY_INCOMPLETE and the figures', () => {
    const error = refusal(() => assertRecoveryComplete({ financial: true, amountVnd: '400000000', recoveredVnd: '300000000', disputeAccepted: false }));
    expect([error.status, error.code]).toEqual([422, 'RECOVERY_INCOMPLETE']);
    expect(error.extensions).toEqual({ amount_vnd: '400000000', recovered_vnd: '300000000', remaining_vnd: '100000000' });
  });
});
