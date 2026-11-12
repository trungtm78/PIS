import { buildBoard, chainStepFact } from '../src/reporting-board.ts';
import type { UnitPeriodFacts } from '../src/reporting-board.ts';
import { scheduleDefaults, schedulePolicyOf, stepDeadlines } from '../src/reporting-schedule.ts';

const deadlines = stepDeadlines(schedulePolicyOf(scheduleDefaults('MONTH')), { endsOn: '2027-09-30' }, '10:00');
const unit = (over: Partial<UnitPeriodFacts>): UnitPeriodFacts => ({ unitId: 'u', unitCode: 'U', unitName: 'Unit', projects: 4, entered: 0, enteredAt: null, approved: 0, approvedAt: null, ...over });

describe('the status board of a period by input point (QT.02)', () => {
  it('shows each step of each unit against the deadline of the step, and counts the units by state', () => {
    const before = new Date('2027-10-03T00:00:00Z');
    const board = buildBoard(deadlines, [unit({ unitId: 'a', entered: 4, enteredAt: '2027-10-01T01:00:00.000Z' }), unit({ unitId: 'b', entered: 2 })], {}, before);
    const [a, b] = board.units;
    expect(a?.steps.map((step) => [step.kind, step.state])).toEqual([['ENTRY', 'DONE'], ['UNIT_APPROVAL', 'OPEN'], ['PLANNING_REVIEW', 'NOT_TRACKED'], ['PERIOD_CLOSE', 'NOT_TRACKED'], ['PUSH', 'NOT_TRACKED']]);
    expect(b?.steps[0]).toMatchObject({ state: 'DUE_SOON', done: 2, of: 4, doneAt: null });
    expect(board.tally.ENTRY).toMatchObject({ DONE: 1, DUE_SOON: 1, OVERDUE: 0 });
  });

  it('is overdue once the deadline has passed without the unit finishing, and late when it finished after it', () => {
    const after = new Date('2027-10-08T00:00:00Z');
    const board = buildBoard(deadlines, [unit({ unitId: 'a', entered: 3 }), unit({ unitId: 'b', entered: 4, enteredAt: '2027-10-06T00:00:00.000Z' })], {}, after);
    expect(board.units[0]?.steps[0]?.state).toBe('OVERDUE');
    expect(board.units[1]?.steps[0]?.state).toBe('DONE_LATE');
    expect(board.units[0]?.steps[1]?.state).toBe('OVERDUE');
  });

  it('never calls a step done or open without a fact: no project, review and push are not tracked, the close follows the period', () => {
    const board = buildBoard(deadlines, [unit({ projects: 0 })], { closedAt: '2027-10-11T00:00:00.000Z' }, new Date('2027-10-20T00:00:00Z'));
    expect(board.units[0]?.steps[0]).toMatchObject({ state: 'NOT_TRACKED', of: 0 });
    expect(board.periodSteps.map((step) => [step.kind, step.state])).toEqual([['PLANNING_REVIEW', 'NOT_TRACKED'], ['PERIOD_CLOSE', 'DONE'], ['PUSH', 'NOT_TRACKED']]);
    const open = buildBoard(deadlines, [unit({})], { closedAt: null }, new Date('2027-10-20T00:00:00Z'));
    expect(open.periodSteps[1]?.state).toBe('OVERDUE');
  });
});

describe('the fact of a chain step of the period (QT.02, ENT-3c)', () => {
  it('is not tracked when no report of the period runs a chain with that step, which is what a single decision tenant has', () => {
    expect(chainStepFact({ total: 0, passed: 0, doneAt: null })).toBeUndefined();
  });

  it('is open while one report has not passed the step, and done at the instant the last one did', () => {
    expect(chainStepFact({ total: 3, passed: 2, doneAt: '2027-10-04T01:00:00.000Z' })).toBeNull();
    expect(chainStepFact({ total: 3, passed: 3, doneAt: '2027-10-04T01:00:00.000Z' })).toBe('2027-10-04T01:00:00.000Z');
  });

  it('never shows a step done without the instant it was done', () => {
    expect(chainStepFact({ total: 1, passed: 1, doneAt: null })).toBeNull();
  });

  it('puts the facts of the review and the push on the period steps of the board, and keeps the others as they were', () => {
    const board = buildBoard(deadlines, [unit({ unitId: 'a' })], { planningReviewAt: '2027-10-18T01:00:00.000Z', pushedAt: null }, new Date('2027-10-20T00:00:00Z'));
    expect(board.periodSteps.map((step) => [step.kind, step.state])).toEqual([['PLANNING_REVIEW', 'DONE_LATE'], ['PERIOD_CLOSE', 'NOT_TRACKED'], ['PUSH', 'OVERDUE']]);
  });
});
