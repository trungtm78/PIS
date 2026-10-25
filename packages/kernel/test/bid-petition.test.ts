import type { DomainError } from '../src/errors';
import { OPEN_PETITION_STATUSES, PETITION_OUTCOMES, PETITION_STATUSES, assertPetitionTransition, isPetitionOverdue, petitionTarget } from '../src/bid-petition';

function refusal(work: () => unknown): DomainError {
  try {
    work();
  } catch (error) {
    return error as DomainError;
  }
  throw new Error('expected a refusal');
}

describe('the petitions of contractors (ST-BID-007)', () => {
  it('answers an open petition with the outcome, and a petition passed on to the level above only with a resolution', () => {
    for (const status of OPEN_PETITION_STATUSES) {
      expect(petitionTarget('RESOLVED', status)).toBe('RESOLVED');
      expect(petitionTarget('ESCALATED', status)).toBe('ESCALATED');
    }
    expect(petitionTarget('RESOLVED', 'ESCALATED')).toBe('RESOLVED');
    expect(petitionTarget('ESCALATED', 'ESCALATED')).toBeUndefined();
    for (const outcome of PETITION_OUTCOMES) {
      expect(petitionTarget(outcome, 'RESOLVED')).toBeUndefined();
      expect(petitionTarget(outcome, 'WITHDRAWN')).toBeUndefined();
    }
  });

  it('refuses with 409 PETITION_STATE_INVALID and the status for an answer that does not apply', () => {
    expect(assertPetitionTransition('RESOLVED', 'RECEIVED')).toBe('RESOLVED');
    expect(refusal(() => assertPetitionTransition('RESOLVED', 'RESOLVED'))).toMatchObject({ code: 'PETITION_STATE_INVALID', status: 409, extensions: { petition_status: 'RESOLVED' } });
    expect(refusal(() => assertPetitionTransition('ESCALATED', 'ESCALATED'))).toMatchObject({ code: 'PETITION_STATE_INVALID' });
    expect(PETITION_STATUSES.filter((status) => petitionTarget('RESOLVED', status) !== undefined)).toEqual(['RECEIVED', 'PROCESSING', 'ESCALATED']);
  });

  it('counts a petition overdue only while it waits and the last day of its deadline has passed', () => {
    expect(isPetitionOverdue('RECEIVED', '2026-12-04', '2026-12-04')).toBe(false);
    expect(isPetitionOverdue('RECEIVED', '2026-12-04', '2026-12-05')).toBe(true);
    expect(isPetitionOverdue('PROCESSING', '2026-12-04', '2026-12-05')).toBe(true);
    for (const status of ['RESOLVED', 'ESCALATED', 'WITHDRAWN'] as const) expect(isPetitionOverdue(status, '2026-12-04', '2027-01-01')).toBe(false);
  });
});
