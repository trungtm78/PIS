import { describe, expect, it } from 'vitest';
import { band, text, workflowTask } from '../test/fixtures';
import { TASKS, detail, schedule } from './test/fixtures';
import {
  NO_FILTER,
  PAGE_SIZE,
  appliedFilters,
  assigneeOptions,
  boardColumns,
  calendarYears,
  ganttAt,
  ganttDayWidth,
  ganttGroups,
  ganttRows,
  ganttScale,
  gateRows,
  gateStandingOf,
  healthOf,
  isStale,
  milestoneRows,
  stepperSteps,
  taskQuery,
  worstHealth,
  worstVariance,
} from './model';
import type { GanttRow } from './model';

const t = (key: string, params?: Record<string, string | number>) => text(key, params);

describe('PWF-03 model: health', () => {
  it('reads the official colour as a word and never calls a task whose deadline cannot be counted fine', () => {
    const health = (over: Parameters<typeof workflowTask>[1]) => healthOf(workflowTask(1, over));
    expect(health({ band: band('RED') })).toBe('late');
    expect(health({ band: band('YELLOW') })).toBe('attention');
    expect(health({ band: band('UNKNOWN') })).toBe('attention');
    expect(health({ band: band('GREEN') })).toBe('ok');
    expect(health({ band: band('NONE') })).toBe('none');
    expect(health({ status: 'DONE', band: band('RED') })).toBe('ok');
    expect(health({ status: 'ON_HOLD', band: band('RED') })).toBe('hold');
    expect(health({ status: 'CANCELLED' })).toBe('none');
    expect(health({ excluded: true })).toBe('none');
    expect(health({ tracked: false })).toBe('none');
  });

  it('takes the worst health of a set', () => {
    expect(worstHealth([workflowTask(1, { band: band('GREEN') }), workflowTask(2, { band: band('RED') })])).toBe('late');
    expect(worstHealth([workflowTask(1, { band: band('GREEN') }), workflowTask(2, { status: 'ON_HOLD' })])).toBe('hold');
    expect(worstHealth([workflowTask(1, { band: band('NONE') })])).toBe('none');
    expect(worstHealth([])).toBe('none');
  });
});

describe('PWF-03 model: freshness', () => {
  it('says the figures are old when the server computed them long before they were read', () => {
    expect(isStale('2026-11-12T03:00:00.000Z', Date.parse('2026-11-12T03:10:00.000Z'))).toBe(false);
    expect(isStale('2026-11-12T03:00:00.000Z', Date.parse('2026-11-12T03:30:00.000Z'))).toBe(true);
    expect(isStale('2026-11-12T03:00:00.000Z', Date.parse('2026-11-12T03:30:00.000Z'), 60 * 60_000)).toBe(false);
    expect(isStale('not a date', Date.now())).toBe(false);
  });
});

describe('PWF-03 model: the stepper', () => {
  it('puts the phases before the open one as done, the open one as current (late when a task of it is red) and the rest as upcoming', () => {
    const steps = stepperSteps(detail(), t);
    expect(steps.map((step) => [step.code, step.status])).toEqual([
      ['PREPARATION', 'late'],
      ['EXECUTION', 'upcoming'],
    ]);
    expect(steps[0]?.current).toBe(true);
    expect(steps[0]?.note).toBe(text('pwf.flow.stepper.progress.text', { done: 1, total: 2 }));
    const second = detail({ open_phase: 'EXECUTION', phases: detail().phases.map((phase) => ({ ...phase, open: phase.code === 'EXECUTION' })) });
    expect(stepperSteps(second, t).map((step) => step.status)).toEqual(['done', 'current']);
    const hold = detail({ status: 'ON_HOLD', phases: detail().phases.map((phase) => ({ ...phase, open: phase.code === 'EXECUTION' })) });
    expect(stepperSteps(hold, t).map((step) => step.status)).toEqual(['done', 'hold']);
    const finished = detail({ open_phase: null, phases: detail().phases.map((phase) => ({ ...phase, open: false })) });
    expect(stepperSteps(finished, t).map((step) => step.status)).toEqual(['done', 'done']);
  });

  it('says "here" of ONE phase: the phase the server names as current; a later phase with work in parallel has started', () => {
    const phase = (code: string, order: number, standing: 'DONE' | 'CURRENT' | 'STARTED' | 'UPCOMING') => ({ code, name: code, order, gates: [], required_total: 2, required_done: standing === 'DONE' ? 2 : 0, open: standing !== 'DONE', current: standing === 'CURRENT', standing });
    // Three phases still have required work (`open`): only one of them is where the project is.
    const parallel = detail({ open_phase: 'B', tasks: [], phases: [phase('A', 1, 'DONE'), phase('B', 2, 'CURRENT'), phase('C', 3, 'STARTED'), phase('D', 4, 'STARTED'), phase('E', 5, 'UPCOMING')] });
    const steps = stepperSteps(parallel, t);
    expect(steps.map((step) => step.status)).toEqual(['done', 'current', 'started', 'started', 'upcoming']);
    expect(steps.filter((step) => step.current === true || step.status === 'current').map((step) => step.code)).toEqual(['B']);
    // An answer kept from before the server named the current phase: the open phase of the workflow is the one, never every phase that is still open.
    const older = detail({ open_phase: 'B', tasks: [], phases: parallel.phases.map(({ current: _current, standing: _standing, ...rest }) => rest) });
    expect(stepperSteps(older, t).map((step) => step.status)).toEqual(['done', 'current', 'upcoming', 'upcoming', 'upcoming']);
  });
});

describe('PWF-03 model: the Gantt', () => {
  it('draws the current schedule against the first baseline, names each task, marks the critical path and keeps a task with no date as a row', () => {
    const rows = ganttRows(schedule(), detail().tasks);
    expect(rows.map((row) => row.code)).toEqual(['T1', 'T2', 'T3', 'T4', 'T5']);
    const second = rows[1];
    expect(second).toMatchObject({ name: 'Việc T2', critical: true, done: false, variance: 2 });
    expect(second?.actual).toEqual({ from: '2026-12-06', to: '2026-12-10' });
    expect(second?.baseline).toEqual({ from: '2026-12-06', to: '2026-12-08' });
    expect(rows[0]?.done).toBe(true);
    expect(rows[3]?.milestone).toBe(true);
    expect(rows[4]).toMatchObject({ baseline: null, actual: null });
  });

  it('starts the baseline bar at the baseline finish when it is before the scheduled start, and has none without a baseline', () => {
    const early = ganttRows(schedule(), [workflowTask(1, { task_code: 'T1', baseline_finish: '2026-11-20' })])[0];
    expect(early?.baseline).toEqual({ from: '2026-11-20', to: '2026-11-20' });
    const none = ganttRows(schedule(), [workflowTask(1, { task_code: 'T1', baseline_finish: null })])[0];
    expect(none?.baseline).toBeNull();
  });

  it('leaves out the tasks that pass through, and lays the axis over whole months with the Mondays of the window', () => {
    const pass = schedule({ tasks: [...schedule().tasks, { ...schedule().tasks[0], task_code: 'T6', state: 'PASS_THROUGH' } as never] });
    expect(ganttRows(pass, []).map((row) => row.code)).not.toContain('T6');
    const scale = ganttScale(ganttRows(schedule(), detail().tasks));
    expect(scale).toMatchObject({ from: '2026-12-01', to: '2027-02-28', days: 90 });
    expect(scale?.months.map((month) => [month.key, month.offset, month.days])).toEqual([
      ['2026-12', 0, 31],
      ['2027-01', 31, 31],
      ['2027-02', 62, 28],
    ]);
    expect(scale?.weeks[0]).toEqual({ day: '2026-12-07', offset: 6 });
    expect(ganttScale(ganttRows(schedule({ tasks: [schedule().tasks[4] as never] }), []))).toBeNull();
  });

  it('places a day on the axis as a share of its width, the end of a day at its right edge, and nothing outside the window', () => {
    const scale = ganttScale(ganttRows(schedule(), detail().tasks));
    if (scale === null) throw new Error('the schedule has dates');
    expect(ganttAt(scale, '2026-12-01')).toBe(0);
    expect(ganttAt(scale, '2027-02-28', true)).toBe(100);
    expect(ganttAt(scale, '2026-12-10')).toBeCloseTo(10, 5);
    expect(ganttAt(scale, '2026-11-30')).toBeNull();
    expect(ganttAt(scale, '2027-03-01')).toBeNull();
    // A short schedule gets wide days, a schedule of years narrow ones, both within limits.
    expect(ganttDayWidth(30)).toBe(14);
    expect(ganttDayWidth(90)).toBeCloseTo(10.7, 1);
    expect(ganttDayWidth(2000)).toBe(3);
  });

  it('groups the rows under their phases in order, a task of an unknown phase last under its code', () => {
    const rows = [...ganttRows(schedule(), detail().tasks), { ...(ganttRows(schedule(), detail().tasks)[0] as GanttRow), code: 'T8', phase: 'OTHER' }];
    const groups = ganttGroups(rows, detail().phases);
    expect(groups.map((group) => [group.code, group.rows.map((row) => row.code)])).toEqual([
      ['PREPARATION', ['T1', 'T2']],
      ['EXECUTION', ['T3', 'T4', 'T5']],
      ['OTHER', ['T8']],
    ]);
    expect(groups[0]?.name).toBe('Chuẩn bị đầu tư');
  });

  it('finds the worst delay against the baseline, and none when no task has one', () => {
    expect(worstVariance(schedule())).toEqual({ days: 5, task: 'T3' });
    expect(worstVariance(schedule({ tasks: [schedule().tasks[4] as never] }))).toBeNull();
  });

  it('names the years with no calendar from the tasks and from the findings of the schedule, each once', () => {
    expect(calendarYears(detail(), schedule())).toEqual([2028]);
    expect(calendarYears(detail({ tasks: [] }), schedule({ findings: [{ code: 'CALENDAR_UNAVAILABLE', task: null, year: 2029 }, { code: 'ACTUAL_DATES_MISSING', task: 'T1', year: 2030 }] }))).toEqual([2029]);
    expect(calendarYears(detail({ tasks: [] }), undefined)).toEqual([]);
  });
});

describe('PWF-03 model: milestones', () => {
  it('lists the milestones of the plan by their day, one without a day last, and leaves out the ones the schedule left out', () => {
    const base = detail();
    const rows = milestoneRows(
      detail({
        tasks: [...base.tasks, workflowTask(6, { kind: 'MILESTONE', planned_finish: '2026-12-20', status: 'DONE' }), workflowTask(7, { kind: 'MILESTONE', excluded: true, planned_finish: '2026-12-21' }), workflowTask(8, { kind: 'MILESTONE', planned_finish: null })],
      }),
    );
    expect(rows.map((row) => [row.code, row.day])).toEqual([
      ['T6', '2026-12-20'],
      ['T4', '2027-02-12'],
      ['T8', null],
    ]);
    expect(rows[1]).toMatchObject({ name: 'Mốc khởi công', phase: 'EXECUTION' });
  });
});

describe('PWF-03 model: the list, the board and the gates', () => {
  it('sends only the filters that are set, with the page size and the cursor', () => {
    expect(taskQuery(NO_FILTER)).toEqual({ limit: PAGE_SIZE });
    expect(taskQuery({ phase: 'EXECUTION', band: 'RED', status: 'IN_PROGRESS', assignee: 'm1' }, 'c2')).toEqual({ phase: 'EXECUTION', band: 'RED', status: 'IN_PROGRESS', assignee_id: 'm1', limit: PAGE_SIZE, cursor: 'c2' });
    expect(appliedFilters(NO_FILTER)).toBe(0);
    expect(appliedFilters({ ...NO_FILTER, band: 'RED', phase: 'X' })).toBe(2);
  });

  it('offers each assignee once, by name', () => {
    const tasks = [workflowTask(1, { assignee: { membership_id: 'b', display_name: 'Bùi Hai' } }), workflowTask(2, { assignee: { membership_id: 'a', display_name: 'An Ba' } }), workflowTask(3, { assignee: { membership_id: 'b', display_name: 'Bùi Hai' } }), workflowTask(4, { assignee: null })];
    expect(assigneeOptions(tasks)).toEqual([
      { id: 'a', name: 'An Ba' },
      { id: 'b', name: 'Bùi Hai' },
    ]);
  });

  it('makes a column for each phase in order and one more for a task of a phase the workflow does not list', () => {
    const items = [...TASKS, workflowTask(9, { phase_code: 'STRAY' })];
    const columns = boardColumns(detail().phases, items);
    expect(columns.map((column) => [column.code, column.items.length])).toEqual([
      ['PREPARATION', 2],
      ['EXECUTION', 3],
      ['STRAY', 1],
    ]);
    expect(columns[0]?.required).toEqual({ done: 1, total: 2 });
    expect(columns[2]?.required).toBeNull();
  });

  it('B15: a closed gate of a phase the project has not reached stands NOT_DUE; a server that tells no standing is read as open or closed', () => {
    expect(gateStandingOf({ open: false, standing: 'NOT_DUE' }, undefined)).toBe('NOT_DUE');
    expect(gateStandingOf({ open: false, standing: 'NOT_DUE' }, { target: 'closeProject', gated: true, open: false, missing: [], as_of: 'x', standing: 'CLOSED' })).toBe('CLOSED');
    expect(gateStandingOf({ open: false }, undefined)).toBe('CLOSED');
    expect(gateStandingOf({ open: true }, undefined)).toBe('OPEN');
    expect(gateStandingOf({ open: false }, { target: 'closeProject', gated: false, open: true, missing: [], as_of: 'x' })).toBe('UNGATED');
    expect(gateStandingOf({ open: false }, { target: 'closeProject', gated: true, open: true, missing: [], as_of: 'x' })).toBe('OPEN');
  });

  it('pairs each gate of the workflow with the assessment read for it, and says when one could not be read', () => {
    const rows = gateRows(detail(), [{ data: { target: 'submitProjectForAppraisal', gated: true, open: false, missing: [], as_of: 'x' }, failed: false }], t);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ target: 'submitProjectForAppraisal', word: text('pwf.gate.submit.word'), missingCount: 1, failed: false });
    expect(rows[0]?.assessment?.open).toBe(false);
    expect(rows[1]).toMatchObject({ assessment: undefined, failed: false });
    expect(gateRows(detail(), [{ data: undefined, failed: true }], t)[0]?.failed).toBe(true);
  });
});
