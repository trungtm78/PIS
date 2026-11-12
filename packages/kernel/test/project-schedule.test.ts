import { DomainError } from '../src/errors.ts';
import { builtInDefault } from '../src/governance-rules.ts';
import { PROJECT_WORKFLOW_RULE_TYPE, parseProjectWorkflowTemplate } from '../src/project-workflow.ts';
import { applyOverrides, baselineOf, diffSchedules, rescheduleProject, scheduleProject, tasksFromTemplate } from '../src/project-schedule.ts';
import type { PinnedCalendar, ScheduleInput, ScheduleTask, ScheduledTask } from '../src/project-schedule.ts';
import type { WorkCalendarContent } from '../src/working-time.ts';

/** 2026: Monday to Friday, with Wednesday 11 November a holiday (a made-up day for the fixture). */
const calendar = (year: number, holidays: Array<{ date: string; name: string }> = []): WorkCalendarContent => ({ calendar_code: 'WORKDAY_VN', year, working_days: [1, 2, 3, 4, 5], holidays, legal_basis_ref: 'fixture' });
const pinned = (year: number, version = 1, holidays: Array<{ date: string; name: string }> = []): PinnedCalendar => ({ year, version, content: calendar(year, holidays) });
const CAL_2026: PinnedCalendar[] = [pinned(2026, 3, [{ date: '2026-11-11', name: 'Ngày nghỉ thử' }])];

/*
 * Working days from Monday 2 November 2026 (slot: date): 0 Nov 2, 1 Nov 3, 2 Nov 4, 3 Nov 5, 4 Nov 6, 5 Nov 9, 6 Nov 10, 7 Nov 12 (the 11th is a holiday), 8 Nov 13, 9 Nov 16, 10 Nov 17, 11 Nov 18, 12 Nov 19, 13 Nov 20.
 */
const task = (code: string, durationWorkingDays: number, extra: Partial<ScheduleTask> = {}): ScheduleTask => ({ code, kind: 'TASK', durationWorkingDays, predecessors: [], ...extra });
const milestone = (code: string, extra: Partial<ScheduleTask> = {}): ScheduleTask => ({ code, kind: 'MILESTONE', durationWorkingDays: 0, predecessors: [], ...extra });
const link = (taskCode: string, kind: 'FS' | 'SS' | 'FF' | 'SF' = 'FS', lagWorkingDays = 0) => ({ task: taskCode, kind, lagWorkingDays });
const run = (tasks: ScheduleTask[], extra: Partial<ScheduleInput> = {}) => scheduleProject({ tasks, plannedStart: '2026-11-02', calendars: CAL_2026, ...extra });
const find = (result: ReturnType<typeof run>, code: string): ScheduledTask => {
  const one = result.tasks.find((candidate) => candidate.code === code);
  if (one === undefined) throw new Error(`no task ${code}`);
  return one;
};
const dates = (result: ReturnType<typeof run>, code: string): [string | null, string | null] => [find(result, code).start, find(result, code).finish];

describe('scheduleProject: the forward pass on a working calendar', () => {
  it('lays tasks end to end from the planned start and skips weekends and the holiday', () => {
    const result = run([task('A', 3), task('B', 2, { predecessors: [link('A')] }), task('C', 4, { predecessors: [link('B')] })]);
    expect(dates(result, 'A')).toEqual(['2026-11-02', '2026-11-04']);
    expect(dates(result, 'B')).toEqual(['2026-11-05', '2026-11-06']);
    expect(dates(result, 'C')).toEqual(['2026-11-09', '2026-11-13']);
    expect(result.projectStart).toBe('2026-11-02');
    expect(result.projectFinish).toBe('2026-11-13');
  });

  it('starts on the first working day on or after a planned start that falls on a weekend', () => {
    const result = run([task('A', 2)], { plannedStart: '2026-11-07' });
    expect(dates(result, 'A')).toEqual(['2026-11-09', '2026-11-10']);
  });

  it('gives a milestone the day its last predecessor ends, and a milestone with nothing before it the first working day', () => {
    const result = run([milestone('KICK'), task('A', 3, { predecessors: [link('KICK')] }), milestone('DONE', { predecessors: [link('A')] })]);
    expect(dates(result, 'KICK')).toEqual(['2026-11-02', '2026-11-02']);
    expect(dates(result, 'A')).toEqual(['2026-11-02', '2026-11-04']);
    expect(dates(result, 'DONE')).toEqual(['2026-11-04', '2026-11-04']);
  });

  it('applies a lag and a lead to a finish-to-start link', () => {
    const base = [task('A', 3)];
    expect(dates(run([...base, task('B', 2, { predecessors: [link('A', 'FS', 1)] })]), 'B')).toEqual(['2026-11-06', '2026-11-09']);
    expect(dates(run([...base, task('B', 2, { predecessors: [link('A', 'FS', -1)] })]), 'B')).toEqual(['2026-11-04', '2026-11-05']);
  });

  it('never starts a task before the planned start, even with a lead', () => {
    const result = run([task('A', 2), task('B', 2, { predecessors: [link('A', 'FS', -9)] })]);
    expect(dates(result, 'B')).toEqual(['2026-11-02', '2026-11-03']);
  });

  it('ties starts with start-to-start, finishes with finish-to-finish and a finish to a start with start-to-finish', () => {
    const ss = run([task('A', 5), task('B', 3, { predecessors: [link('A', 'SS', 2)] })]);
    expect(dates(ss, 'B')).toEqual(['2026-11-04', '2026-11-06']);
    const ff = run([task('A', 5), task('B', 3, { predecessors: [link('A', 'FF')] })]);
    expect(dates(ff, 'B')).toEqual(['2026-11-04', '2026-11-06']);
    const ffLag = run([task('A', 5), task('B', 3, { predecessors: [link('A', 'FF', 2)] })]);
    expect(dates(ffLag, 'B')).toEqual(['2026-11-06', '2026-11-10']);
    const sf = run([task('Y', 5), task('X', 4, { predecessors: [link('Y')] }), task('B', 2, { predecessors: [link('X', 'SF')] })]);
    expect(dates(sf, 'X')).toEqual(['2026-11-09', '2026-11-13']);
    expect(dates(sf, 'B')).toEqual(['2026-11-05', '2026-11-06']);
  });

  it('takes the latest of several predecessors', () => {
    const result = run([task('A', 2), task('B', 6), task('C', 1, { predecessors: [link('A'), link('B')] })]);
    expect(dates(result, 'C')).toEqual(['2026-11-10', '2026-11-10']);
  });

  it('reports the working-day slots of every task for the Gantt and for the tests', () => {
    const result = run([task('A', 3), task('B', 2, { predecessors: [link('A')] })]);
    expect([find(result, 'B').startSlot, find(result, 'B').endSlot]).toEqual([3, 5]);
  });
});

describe('scheduleProject: the backward pass, float and the critical path', () => {
  const diamond = [task('A', 2), task('B', 5, { predecessors: [link('A')] }), task('C', 2, { predecessors: [link('A')] }), task('D', 1, { predecessors: [link('B'), link('C')] })];

  it('computes total and free float and marks the longest chain critical', () => {
    const result = run(diamond);
    expect(find(result, 'C').totalFloat).toBe(3);
    expect(find(result, 'C').freeFloat).toBe(3);
    expect(find(result, 'B').totalFloat).toBe(0);
    expect(find(result, 'B').critical).toBe(true);
    expect(find(result, 'C').critical).toBe(false);
    expect(result.criticalPath).toEqual(['A', 'B', 'D']);
    expect(result.longestPath).toEqual(['A', 'B', 'D']);
    expect(find(result, 'C').lateStart).toBe('2026-11-09');
    expect(find(result, 'D').drivingPredecessor).toBe('B');
  });

  it('gives the free float of a task that feeds another, not the total', () => {
    const result = run([task('A', 2), task('B', 3, { predecessors: [link('A')] }), task('C', 1, { predecessors: [link('A')] }), task('D', 1, { predecessors: [link('B')] }), task('E', 1, { predecessors: [link('C'), link('D')] })]);
    expect(find(result, 'C').totalFloat).toBe(3);
    expect(find(result, 'C').freeFloat).toBe(3);
    const chain = run([task('A', 2), task('X', 1, { predecessors: [link('A')] }), task('Y', 1, { predecessors: [link('X')] }), task('B', 6, { predecessors: [link('A')] }), task('Z', 1, { predecessors: [link('Y'), link('B')] })]);
    expect(find(chain, 'X').totalFloat).toBe(4);
    expect(find(chain, 'X').freeFloat).toBe(0);
    expect(find(chain, 'Y').freeFloat).toBe(4);
  });

  it('widens the critical set with a float threshold', () => {
    const result = run(diamond, { criticalFloatDays: 3 });
    expect(find(result, 'C').critical).toBe(true);
  });

  it('makes the float negative when the project must finish before the schedule allows', () => {
    const result = run([task('A', 5)], { targetFinish: '2026-11-04' });
    expect(find(result, 'A').totalFloat).toBe(-2);
    expect(find(result, 'A').critical).toBe(true);
  });

  it('has no float for a task that is done or left out', () => {
    const result = run([task('A', 2, { status: 'DONE', actualStart: '2026-11-02', actualFinish: '2026-11-03' }), task('B', 2, { predecessors: [link('A')] })]);
    expect(find(result, 'A').totalFloat).toBeNull();
    expect(find(result, 'A').critical).toBe(false);
    expect(result.criticalPath).toEqual(['B']);
  });
});

describe('scheduleProject: constraints', () => {
  it('moves a start-no-earlier-than task and a finish-no-earlier-than task', () => {
    const snet = run([task('A', 2, { constraint: { kind: 'SNET', date: '2026-11-10' } })]);
    expect(dates(snet, 'A')).toEqual(['2026-11-10', '2026-11-12']);
    const fnet = run([task('A', 2, { constraint: { kind: 'FNET', date: '2026-11-10' } })]);
    expect(dates(fnet, 'A')).toEqual(['2026-11-09', '2026-11-10']);
  });

  it('resolves a constraint given as working days after the planned start', () => {
    const result = run([task('A', 2, { constraint: { kind: 'SNET', offsetWorkingDays: 5 } })]);
    expect(dates(result, 'A')).toEqual(['2026-11-09', '2026-11-10']);
  });

  it('keeps a must-start-on and a must-finish-on date, and says when the logic wanted a later one', () => {
    const mso = run([task('A', 2, { constraint: { kind: 'MSO', date: '2026-11-12' } })]);
    expect(dates(mso, 'A')).toEqual(['2026-11-12', '2026-11-13']);
    expect(find(mso, 'A').findings).toEqual([]);
    const conflict = run([task('P', 8), task('A', 2, { predecessors: [link('P')], constraint: { kind: 'MSO', date: '2026-11-12' } })]);
    expect(dates(conflict, 'A')).toEqual(['2026-11-12', '2026-11-13']);
    expect(find(conflict, 'A').findings.map((one) => one.code)).toEqual(['CONSTRAINT_CONFLICT']);
    const mfo = run([task('A', 2, { constraint: { kind: 'MFO', date: '2026-11-13' } })]);
    expect(dates(mfo, 'A')).toEqual(['2026-11-12', '2026-11-13']);
  });

  it('flags a deadline the schedule cannot meet and gives the task negative float', () => {
    const late = run([task('A', 5, { constraint: { kind: 'FNLT', date: '2026-11-04' } })]);
    expect(find(late, 'A').findings.map((one) => one.code)).toEqual(['CONSTRAINT_VIOLATED']);
    expect(find(late, 'A').totalFloat).toBe(-2);
    const startLate = run([task('P', 4), task('A', 2, { predecessors: [link('P')], constraint: { kind: 'SNLT', date: '2026-11-04' } })]);
    expect(find(startLate, 'A').findings.map((one) => one.code)).toEqual(['CONSTRAINT_VIOLATED']);
    expect(find(startLate, 'A').totalFloat).toBe(-2);
    const ok = run([task('A', 2, { constraint: { kind: 'FNLT', date: '2026-11-13' } }), task('B', 10)]);
    expect(find(ok, 'A').findings).toEqual([]);
    expect(find(ok, 'A').totalFloat).toBe(7);
  });

  it('holds a milestone to a date', () => {
    const result = run([task('A', 1), milestone('M', { predecessors: [link('A')], constraint: { kind: 'SNET', date: '2026-11-10' } })]);
    expect(dates(result, 'M')).toEqual(['2026-11-10', '2026-11-10']);
  });
});

describe('scheduleProject: progress, cancelled and left-out tasks', () => {
  it('keeps the actual dates of a task that is done and lets its successors follow them', () => {
    const result = run([task('A', 5, { status: 'DONE', actualStart: '2026-11-02', actualFinish: '2026-11-04' }), task('B', 2, { predecessors: [link('A')] })], { statusDate: '2026-11-05' });
    expect(dates(result, 'A')).toEqual(['2026-11-02', '2026-11-04']);
    expect(find(result, 'A').state).toBe('COMPLETED');
    expect(dates(result, 'B')).toEqual(['2026-11-05', '2026-11-06']);
  });

  it('schedules what is left of a task in progress from the status date, from the remaining duration', () => {
    const tasks = [task('A', 5, { status: 'IN_PROGRESS', actualStart: '2026-11-02', remainingWorkingDays: 2 }), task('B', 1, { predecessors: [link('A')] })];
    const result = run(tasks, { statusDate: '2026-11-10' });
    expect(dates(result, 'A')).toEqual(['2026-11-02', '2026-11-12']);
    expect(dates(result, 'B')).toEqual(['2026-11-13', '2026-11-13']);
  });

  it('derives the remaining duration from the percent complete, or from the days gone when neither is given', () => {
    const percent = run([task('A', 10, { status: 'IN_PROGRESS', actualStart: '2026-11-02', percentComplete: 70 })], { statusDate: '2026-11-09' });
    expect(find(percent, 'A').finish).toBe('2026-11-12');
    const elapsed = run([task('A', 10, { status: 'IN_PROGRESS', actualStart: '2026-11-02' })], { statusDate: '2026-11-09' });
    expect(find(elapsed, 'A').finish).toBe('2026-11-16');
  });

  it('does not let a task that has not started begin before the status date', () => {
    const result = run([task('A', 2)], { statusDate: '2026-11-10' });
    expect(dates(result, 'A')).toEqual(['2026-11-10', '2026-11-12']);
  });

  it('treats a cancelled task and a branch left out as a node of zero length that keeps the order around it', () => {
    const result = run([task('A', 3), task('B', 2, { predecessors: [link('A')], status: 'CANCELLED' }), task('C', 2, { predecessors: [link('B')] }), task('X', 4, { excluded: true }), task('D', 1, { predecessors: [link('X'), link('C')] })]);
    expect(find(result, 'B').state).toBe('PASS_THROUGH');
    expect(find(result, 'B').start).toBeNull();
    expect(find(result, 'X').state).toBe('PASS_THROUGH');
    expect(dates(result, 'C')).toEqual(['2026-11-05', '2026-11-06']);
    expect(dates(result, 'D')).toEqual(['2026-11-09', '2026-11-09']);
    expect(result.criticalPath).toEqual(['A', 'C', 'D']);
  });

  it('carries a lag through a task that is left out', () => {
    const result = run([task('A', 2), task('X', 1, { excluded: true, predecessors: [link('A', 'FS', 1)] }), task('B', 2, { predecessors: [link('X', 'FS', 2)] })]);
    expect(dates(result, 'B')).toEqual(['2026-11-09', '2026-11-10']);
  });

  it('keeps the actual days of a task that is done, even on a day nobody works, and does not place one that the calendars do not reach', () => {
    const sunday = run([task('A', 2, { status: 'DONE', actualStart: '2026-11-06', actualFinish: '2026-11-08' })]);
    expect(dates(sunday, 'A')).toEqual(['2026-11-06', '2026-11-08']);
    const beyond = run([task('A', 2, { status: 'DONE', actualStart: '2026-12-30', actualFinish: '2027-01-06' })]);
    expect(find(beyond, 'A').state).toBe('CALENDAR_UNAVAILABLE');
    expect(find(beyond, 'A').finish).toBeNull();
  });

  it('says when a task is marked done with no actual finish and plans it as it was', () => {
    const result = run([task('A', 2, { status: 'DONE' })]);
    expect(find(result, 'A').findings.map((one) => one.code)).toEqual(['ACTUAL_DATES_MISSING']);
    expect(find(result, 'A').state).toBe('SCHEDULED');
  });
});

describe('scheduleProject: the calendars', () => {
  it('says which year has no calendar for each task instead of guessing a day', () => {
    const result = run([task('A', 20), task('B', 30, { predecessors: [link('A')] }), task('C', 2, { predecessors: [link('B')] })], { plannedStart: '2026-12-01' });
    expect(find(result, 'A').state).toBe('SCHEDULED');
    expect(find(result, 'B').state).toBe('CALENDAR_UNAVAILABLE');
    expect(find(result, 'B').start).toBeNull();
    expect(find(result, 'B').missingYear).toBe(2027);
    expect(find(result, 'C').state).toBe('CALENDAR_UNAVAILABLE');
    expect(result.projectFinish).toBeNull();
    expect(result.findings.map((one) => one.code)).toContain('CALENDAR_UNAVAILABLE');
  });

  it('cannot date anything when the year of the planned start has no calendar', () => {
    const result = run([task('A', 2)], { plannedStart: '2027-03-01' });
    expect(find(result, 'A').state).toBe('CALENDAR_UNAVAILABLE');
    expect(find(result, 'A').missingYear).toBe(2027);
    expect(result.projectStart).toBeNull();
  });

  it('plans a project longer than the three years the day scan stops at, one year after the other', () => {
    const calendars = [2026, 2027, 2028, 2029, 2030, 2031, 2032].map((year) => pinned(year));
    const result = scheduleProject({ tasks: [task('LONG', 1500)], plannedStart: '2026-01-05', calendars });
    let counted = 0;
    let cursor = Date.UTC(2026, 0, 5);
    let last = '';
    while (counted < 1500) {
      const day = new Date(cursor).getUTCDay();
      if (day !== 0 && day !== 6) {
        counted += 1;
        last = new Date(cursor).toISOString().slice(0, 10);
      }
      cursor += 86_400_000;
    }
    expect(find(result, 'LONG').finish).toBe(last);
    expect(result.calendarVersions).toEqual([2026, 2027, 2028, 2029, 2030, 2031].map((year) => ({ year, version: 1 })));
    expect(last.startsWith('2031')).toBe(true);
  });

  it('names the version of each calendar year it relied on, so a later reschedule can pin the same ones', () => {
    const result = run([task('A', 2)]);
    expect(result.calendarVersions).toEqual([{ year: 2026, version: 3 }]);
  });

  it('refuses two calendars for one year and an input that is not a schedule', () => {
    expect(() => run([task('A', 1)], { calendars: [pinned(2026), pinned(2026, 2)] })).toThrow(DomainError);
    expect(() => run([task('A', 1)], { plannedStart: '2026-02-30' })).toThrow(DomainError);
    expect(() => run([task('A', 1), task('A', 1)])).toThrow(DomainError);
    expect(() => run([task('A', 1, { predecessors: [link('NOPE')] })])).toThrow(DomainError);
    expect(() => run([task('A', 1, { predecessors: [link('A')] })])).toThrow(DomainError);
    expect(() => run([milestone('M', { durationWorkingDays: 2 })])).toThrow(DomainError);
    expect(() => run([task('A', -1)])).toThrow(DomainError);
    expect(() => run([task('A', 1, { constraint: { kind: 'SNET', date: 'nope' } })])).toThrow(DomainError);
    expect(() => run([task('A', 1, { status: 'DONE', actualStart: 'nope', actualFinish: '2026-11-03' })])).toThrow(DomainError);
  });

  it('refuses a loop of dependencies with its own error code', () => {
    try {
      run([task('A', 1, { predecessors: [link('B')] }), task('B', 1, { predecessors: [link('A')] })]);
      throw new Error('expected a loop');
    } catch (failure) {
      expect((failure as DomainError).code).toBe('PWF_DEPENDENCY_CYCLE');
    }
  });

  it('is the same for the same input: the hash does not depend on the order of the tasks given', () => {
    const tasks = [task('A', 2), task('B', 3, { predecessors: [link('A')] }), task('C', 1, { predecessors: [link('A')] })];
    expect(run(tasks).hash).toBe(run([...tasks].reverse()).hash);
    expect(run(tasks).hash).toMatch(/^[0-9a-f]{64}$/);
    expect(run(tasks).hash).not.toBe(run([task('A', 3), ...tasks.slice(1)]).hash);
  });
});

describe('rescheduling the part that is not done and keeping the baseline', () => {
  const plan = [task('A', 3), task('B', 2, { predecessors: [link('A')] }), task('C', 2, { predecessors: [link('B')] })];

  it('keeps the first plan as the baseline and reports how far each task has moved, in working days', () => {
    const first = run(plan);
    const baseline = baselineOf(first);
    expect(baseline.B).toEqual({ start: '2026-11-05', finish: '2026-11-06' });
    const slipped = rescheduleProject({
      before: first,
      input: { tasks: [task('A', 3, { status: 'DONE', actualStart: '2026-11-02', actualFinish: '2026-11-06' }), ...plan.slice(1)], plannedStart: '2026-11-02', calendars: CAL_2026, statusDate: '2026-11-09' },
    });
    expect(find(slipped.schedule, 'B').startVarianceDays).toBe(2);
    expect(find(slipped.schedule, 'C').finishVarianceDays).toBe(2);
    expect(find(slipped.schedule, 'A').finishVarianceDays).toBe(2);
    expect(slipped.diff.map((one) => one.code)).toEqual(['A', 'B', 'C']);
    expect(slipped.diff.find((one) => one.code === 'C')).toMatchObject({ startShiftDays: 2, finishShiftDays: 2 });
    expect(slipped.baseline).toEqual(baseline);
  });

  it('measures the variance of a project that starts later than its baseline', () => {
    const first = run([task('A', 2)]);
    const moved = rescheduleProject({ before: first, input: { tasks: [task('A', 2)], plannedStart: '2026-11-09', calendars: CAL_2026 } });
    expect(find(moved.schedule, 'A').startVarianceDays).toBe(5);
    expect(find(moved.schedule, 'A').finishVarianceDays).toBe(5);
  });

  it('does not move a task that is done, and uses the baseline given rather than the schedule before when there is one', () => {
    const first = run(plan);
    const own = { A: { start: '2026-11-02', finish: '2026-11-03' } };
    const result = rescheduleProject({ before: first, input: { tasks: plan, plannedStart: '2026-11-02', calendars: CAL_2026 }, baseline: own });
    expect(find(result.schedule, 'A').finishVarianceDays).toBe(1);
    expect(find(result.schedule, 'B').startVarianceDays).toBeNull();
    expect(result.diff).toEqual([]);
  });

  it('lists the tasks whose float or critical state changed, not only their dates', () => {
    const before = run([task('A', 2), task('B', 5), task('C', 1, { predecessors: [link('A'), link('B')] })]);
    const after = run([task('A', 8), task('B', 5), task('C', 1, { predecessors: [link('A'), link('B')] })]);
    const diff = diffSchedules(before, after, CAL_2026);
    expect(diff.find((one) => one.code === 'A')).toMatchObject({ becameCritical: true, becameNonCritical: false });
    expect(diff.find((one) => one.code === 'B')).toMatchObject({ becameCritical: false, becameNonCritical: true });
    expect(diffSchedules(before, before, CAL_2026)).toEqual([]);
  });
});

describe('the project overrides of a template and the tasks a template gives', () => {
  it('turns a template and the facts of a project into tasks, and schedules them', () => {
    const template = parseProjectWorkflowTemplate(builtInDefault(PROJECT_WORKFLOW_RULE_TYPE, 'PUBLIC_INVESTMENT')?.params);
    const tasks = tasksFromTemplate(template, { project_group: 'B', funding_source: 'BUDGET' });
    expect(tasks.filter((one) => one.excluded === true).map((one) => one.code)).toEqual(['PREP_PRE_FEASIBILITY', 'FEAS_ODA_AGREEMENT']);
    const calendars = [2026, 2027, 2028, 2029].map((year) => pinned(year));
    const result = scheduleProject({ tasks, plannedStart: '2026-11-02', calendars });
    expect(result.projectFinish).not.toBeNull();
    expect(result.longestPath[0]).toBe('PREP_NEEDS');
    expect(result.longestPath[result.longestPath.length - 1]).toBe('SET_EVALUATION');
    expect(find(result, 'PREP_PRE_FEASIBILITY').state).toBe('PASS_THROUGH');
    expect(result.tasks.filter((one) => one.state === 'SCHEDULED').length).toBe(tasks.length - 2);
  });

  it('carries the constraint of a template task as an offset and the progress of a project onto the tasks', () => {
    const template = parseProjectWorkflowTemplate({
      name: 'Test',
      phases: [{ code: 'P1', name: 'One', gates: [] }],
      tasks: [
        {
          code: 'AA', name: 'A', phase: 'P1', kind: 'TASK', duration_working_days: 2, required: true, responsible_role: 'PLANNER', priority: 'NORMAL', predecessors: [], legal_doc_types: [], form_templates: [], checklist: [], kpi_codes: [], when: [],
          constraint: { kind: 'SNET', offset_working_days: 3 },
        },
      ],
    });
    const tasks = tasksFromTemplate(template, {}, { AA: { status: 'IN_PROGRESS', actualStart: '2026-11-05', remainingWorkingDays: 1 } });
    expect(tasks[0]).toMatchObject({ code: 'AA', durationWorkingDays: 2, constraint: { kind: 'SNET', offsetWorkingDays: 3 }, status: 'IN_PROGRESS', remainingWorkingDays: 1 });
  });

  it('adds, changes and removes tasks of one project without touching the template', () => {
    const base = [task('A', 2), task('B', 2, { predecessors: [link('A')] })];
    const changed = applyOverrides(base, { add: [task('C', 1, { predecessors: [link('B')] })], change: { A: { durationWorkingDays: 4 } }, remove: ['B'] });
    expect(changed.map((one) => `${one.code}:${one.durationWorkingDays}:${one.excluded === true}`)).toEqual(['A:4:false', 'B:2:true', 'C:1:false']);
    expect(base[0]?.durationWorkingDays).toBe(2);
    expect(() => applyOverrides(base, { add: [task('A', 1)] })).toThrow(DomainError);
    expect(() => applyOverrides(base, { change: { NOPE: {} } })).toThrow(DomainError);
    expect(() => applyOverrides(base, { remove: ['NOPE'] })).toThrow(DomainError);
  });
});

describe('the cost of a schedule', () => {
  it('plans 500 tasks well inside the budget', () => {
    const tasks: ScheduleTask[] = [];
    for (let index = 0; index < 500; index += 1) {
      const predecessors = index === 0 ? [] : [link(`T${index - 1}`), ...(index > 10 ? [link(`T${index - 10}`, 'SS', 1)] : [])];
      tasks.push(task(`T${index}`, 1 + (index % 5), { predecessors }));
    }
    const calendars = [2026, 2027, 2028, 2029, 2030].map((year) => pinned(year));
    const started = performance.now();
    const result = scheduleProject({ tasks, plannedStart: '2026-11-02', calendars });
    const elapsed = performance.now() - started;
    expect(result.tasks.length).toBe(500);
    expect(elapsed).toBeLessThan(200);
  });
});
