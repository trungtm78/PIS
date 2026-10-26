import { ENGAGEMENT_EDGES, ENGAGEMENT_STATUSES, ENGAGEMENT_TYPES, ENDED_STATUSES, holdKindOf, nextEngagementStatus } from '../src/aud-engagement.ts';
import type { EngagementAction, EngagementStatus } from '../src/aud-engagement.ts';
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

describe('the state machine of an engagement (AUD 4)', () => {
  it('leads from PLANNED to ONGOING to AWAITING_CONCLUSION to FOLLOW_UP to CLOSED, and cancels before any conclusion', () => {
    expect(nextEngagementStatus('PLANNED', 'start')).toBe('ONGOING');
    expect(nextEngagementStatus('ONGOING', 'endFieldwork')).toBe('AWAITING_CONCLUSION');
    expect(nextEngagementStatus('ONGOING', 'recordConclusion')).toBe('FOLLOW_UP');
    expect(nextEngagementStatus('AWAITING_CONCLUSION', 'recordConclusion')).toBe('FOLLOW_UP');
    expect(nextEngagementStatus('FOLLOW_UP', 'close')).toBe('CLOSED');
    for (const status of ['PLANNED', 'ONGOING', 'AWAITING_CONCLUSION'] as const) expect(nextEngagementStatus(status, 'cancel')).toBe('CANCELLED');
  });

  it('AC-ST-AUD-001-3: refuses a conclusion and a closure on a PLANNED engagement, and a start after the cancellation, each with 409 ENGAGEMENT_STATE_INVALID', () => {
    for (const action of ['recordConclusion', 'close', 'endFieldwork'] as const) {
      const error = refusal(() => nextEngagementStatus('PLANNED', action));
      expect([error.status, error.code, error.detail]).toEqual([409, 'ENGAGEMENT_STATE_INVALID', `PLANNED->${action}`]);
    }
    const cancelled = nextEngagementStatus('PLANNED', 'cancel');
    expect(cancelled).toBe('CANCELLED');
    expect([refusal(() => nextEngagementStatus(cancelled, 'start')).status, refusal(() => nextEngagementStatus(cancelled, 'start')).code]).toEqual([409, 'ENGAGEMENT_STATE_INVALID']);
  });

  it('allows each command from exactly the states of its edge and no other', () => {
    for (const action of Object.keys(ENGAGEMENT_EDGES) as EngagementAction[]) {
      for (const status of ENGAGEMENT_STATUSES as readonly EngagementStatus[]) {
        const allowed = ENGAGEMENT_EDGES[action].from.includes(status);
        if (allowed) expect(nextEngagementStatus(status, action)).toBe(ENGAGEMENT_EDGES[action].to);
        else expect(refusal(() => nextEngagementStatus(status, action)).code).toBe('ENGAGEMENT_STATE_INVALID');
      }
    }
  });

  it('leaves nothing to do for an engagement that is over, and cancels none that has a conclusion', () => {
    for (const status of ENDED_STATUSES) {
      for (const action of Object.keys(ENGAGEMENT_EDGES) as EngagementAction[]) expect(refusal(() => nextEngagementStatus(status, action)).code).toBe('ENGAGEMENT_STATE_INVALID');
    }
    expect(refusal(() => nextEngagementStatus('FOLLOW_UP', 'cancel')).code).toBe('ENGAGEMENT_STATE_INVALID');
  });

  it('places an AUDIT hold for an audit and an INSPECTION hold for an inspection or a check', () => {
    expect(ENGAGEMENT_TYPES.map((type) => [type, holdKindOf(type)])).toEqual([
      ['ADMINISTRATIVE_INSPECTION', 'INSPECTION'],
      ['SPECIALIZED_INSPECTION', 'INSPECTION'],
      ['STATE_AUDIT', 'AUDIT'],
      ['INTERNAL_AUDIT', 'AUDIT'],
      ['SUPERVISORY_CHECK', 'INSPECTION'],
    ]);
  });
});
