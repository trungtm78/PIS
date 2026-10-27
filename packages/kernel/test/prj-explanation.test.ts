import { answeredStatus, becomesOverdue, canRespond, canReview, concludedStatus, dueMomentOf, isAnswerLate } from '../src/prj-explanation.ts';

describe('the explanation request (ST-PRJ-006)', () => {
  it('takes an answer in time or late, and not after it was answered, accepted or withdrawn', () => {
    expect(['REQUESTED', 'OVERDUE', 'RETURNED'].map((status) => answeredStatus(status as 'REQUESTED'))).toEqual(['RESPONDED', 'RESPONDED', 'RESPONDED']);
    expect(() => answeredStatus('RESPONDED')).toThrow(expect.objectContaining({ code: 'EXPLANATION_ALREADY_SUBMITTED' }));
    expect(() => answeredStatus('ACCEPTED')).toThrow(expect.objectContaining({ code: 'EXPLANATION_ALREADY_SUBMITTED' }));
    expect(() => answeredStatus('CANCELLED')).toThrow(expect.objectContaining({ code: 'STAGE_TRANSITION_DENIED', status: 409 }));
    expect([canRespond('OVERDUE'), canRespond('ACCEPTED')]).toEqual([true, false]);
  });

  it('concludes only an answer that waits: accepted or returned, never a request nobody answered', () => {
    expect([concludedStatus('RESPONDED', 'ACCEPTED'), concludedStatus('RESPONDED', 'RETURNED')]).toEqual(['ACCEPTED', 'RETURNED']);
    for (const status of ['REQUESTED', 'OVERDUE', 'RETURNED', 'ACCEPTED', 'CANCELLED'] as const) {
      expect(() => concludedStatus(status, 'ACCEPTED')).toThrow(expect.objectContaining({ code: 'STAGE_TRANSITION_DENIED' }));
    }
    expect([canReview('RESPONDED'), canReview('REQUESTED')]).toEqual([true, false]);
  });

  it('is overdue only when asked or returned and past its moment, and an answer is late only after it', () => {
    const due = new Date('2027-03-10T16:59:59.999Z');
    expect(becomesOverdue('REQUESTED', due, new Date('2027-03-10T17:00:00.000Z'))).toBe(true);
    expect(becomesOverdue('REQUESTED', due, new Date('2027-03-10T16:59:59.999Z'))).toBe(false);
    expect(becomesOverdue('RETURNED', due, new Date('2027-03-11T00:00:00Z'))).toBe(true);
    expect(['RESPONDED', 'OVERDUE', 'ACCEPTED'].map((status) => becomesOverdue(status as 'RESPONDED', due, new Date('2028-01-01T00:00:00Z')))).toEqual([false, false, false]);
    expect([isAnswerLate(new Date('2027-03-10T17:00:00Z'), due), isAnswerLate(due, due)]).toEqual([true, false]);
  });

  it('ends a due date at the last moment of that day in Vietnam, and refuses a date that is not one', () => {
    expect(dueMomentOf('2027-03-10').toISOString()).toBe('2027-03-10T16:59:59.999Z');
    expect(() => dueMomentOf('10/03/2027')).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
  });
});
