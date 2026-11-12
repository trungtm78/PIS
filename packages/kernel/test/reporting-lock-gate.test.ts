import { LOCK_HOLDS, periodLockVerdict } from '../src/reporting-lock-gate.ts';
import { buildBoard } from '../src/reporting-board.ts';
import { scheduleDefaults, schedulePolicyOf, stepDeadlines } from '../src/reporting-schedule.ts';

// September 2027 with the defaults: entry 5 October, review 10 October, close 12 October, push 15 October (10:00 local, 03:00 UTC).
const deadlines = stepDeadlines(schedulePolicyOf(scheduleDefaults('MONTH')), { endsOn: '2027-09-30' }, '10:00');
const at = (instant: string): Date => new Date(instant);

describe('when the job may lock a period of the enterprise calendar (INT-2)', () => {
  it('holds the lock until the review deadline, then until the close deadline, when no record runs the staged approval', () => {
    // Three working days after the entry deadline (5 October) is 8 October: the public rule would lock here.
    expect(periodLockVerdict(deadlines, {}, at('2027-10-08T04:00:00Z'))).toEqual({ open: false, hold: 'PLANNING_REVIEW_NOT_DUE' });
    expect(periodLockVerdict(deadlines, {}, at('2027-10-10T02:59:00Z'))).toEqual({ open: false, hold: 'PLANNING_REVIEW_NOT_DUE' });
    expect(periodLockVerdict(deadlines, {}, at('2027-10-10T03:00:00Z'))).toEqual({ open: false, hold: 'PERIOD_CLOSE_NOT_DUE' });
    expect(periodLockVerdict(deadlines, {}, at('2027-10-12T02:59:00Z'))).toEqual({ open: false, hold: 'PERIOD_CLOSE_NOT_DUE' });
    expect(periodLockVerdict(deadlines, {}, at('2027-10-12T03:00:00Z'))).toEqual({ open: true });
  });

  it('holds the lock for as long as one record has not passed a step that has a fact, whatever the deadline says', () => {
    const late = at('2027-11-30T00:00:00Z');
    expect(periodLockVerdict(deadlines, { planningReviewAt: null }, late)).toEqual({ open: false, hold: 'PLANNING_REVIEW_PENDING' });
    expect(periodLockVerdict(deadlines, { planningReviewAt: '2027-10-09T01:00:00.000Z', periodCloseAt: null }, late)).toEqual({ open: false, hold: 'PERIOD_CLOSE_PENDING' });
  });

  it('lets the period go before the deadlines once every record passed both steps', () => {
    const early = at('2027-10-08T04:00:00Z');
    expect(periodLockVerdict(deadlines, { planningReviewAt: '2027-10-07T01:00:00.000Z', periodCloseAt: '2027-10-07T05:00:00.000Z' }, early)).toEqual({ open: true });
  });

  it('judges a step with a fact by the fact and the other one by its deadline', () => {
    const early = at('2027-10-08T04:00:00Z');
    expect(periodLockVerdict(deadlines, { planningReviewAt: '2027-10-07T01:00:00.000Z' }, early)).toEqual({ open: false, hold: 'PERIOD_CLOSE_NOT_DUE' });
  });

  it('does not hold on a step the schedule has no deadline for', () => {
    expect(periodLockVerdict([], {}, at('2027-10-08T04:00:00Z'))).toEqual({ open: true });
  });

  it('names every hold once', () => {
    expect(new Set(LOCK_HOLDS).size).toBe(LOCK_HOLDS.length);
  });

  it('shows the review and the push on the board once the platform has their facts, and keeps them untracked without', () => {
    const now = at('2027-10-20T00:00:00Z');
    const unit = { unitId: 'u', unitCode: 'U', unitName: 'Unit', projects: 1, entered: 1, enteredAt: '2027-10-01T00:00:00.000Z', approved: 1, approvedAt: '2027-10-02T00:00:00.000Z' };
    const tracked = buildBoard(deadlines, [unit], { planningReviewAt: '2027-10-09T00:00:00.000Z', closedAt: '2027-10-12T00:00:00.000Z', pushedAt: null }, now);
    expect(tracked.periodSteps.map((step) => [step.kind, step.state])).toEqual([['PLANNING_REVIEW', 'DONE'], ['PERIOD_CLOSE', 'DONE'], ['PUSH', 'OVERDUE']]);
    const untracked = buildBoard(deadlines, [unit], {}, now);
    expect(untracked.periodSteps.map((step) => step.state)).toEqual(['NOT_TRACKED', 'NOT_TRACKED', 'NOT_TRACKED']);
  });
});
