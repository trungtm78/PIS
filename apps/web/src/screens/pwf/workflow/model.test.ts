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
  ganttBars,
  ganttMarks,
  ganttRange,
  gateRows,
  healthOf,
  isStale,
  milestoneGroups,
  phaseNodeId,
  phaseOfNode,
  stepperSteps,
  taskIdOfNode,
  taskNodeId,
  taskQuery,
  taskSentence,
  treeNodes,
  worstHealth,
  worstVariance,
} from './model';

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

describe('PWF-03 model: the tree', () => {
  it('makes the phases the parents of their tasks, with counts, late counts and a sentence that names the colour and the critical path', () => {
    const nodes = treeNodes(detail(), t);
    const phase = nodes.find((node) => node.id === phaseNodeId('PREPARATION'));
    expect(phase).toMatchObject({ label: 'Chuẩn bị đầu tư', count: 2, health: 'late', lateCount: 1, parentId: null });
    expect(phase?.ariaLabel).toBe(text('pwf.flow.tree.phase.aria', { name: 'Chuẩn bị đầu tư', done: 1, total: 2, count: 2 }));
    const task = nodes.find((node) => node.id === taskNodeId(TASKS[1]?.id ?? ''));
    expect(task).toMatchObject({ label: 'T2 · Công việc 2', count: 1, health: 'late', parentId: phaseNodeId('PREPARATION') });
    expect(task?.ariaLabel).toContain(text('pwf.flow.critical.aria'));
    expect(task?.ariaLabel).toContain(text('pwf.band.red.word'));
    expect(nodes).toHaveLength(7);
  });

  it('leaves out the tasks the schedule left out, and keeps a task of an unknown phase at the root', () => {
    const base = detail();
    const nodes = treeNodes(detail({ tasks: [...base.tasks, workflowTask(9, { excluded: true }), workflowTask(8, { phase_code: 'OTHER' })] }), t);
    expect(nodes.some((node) => node.label.startsWith('T9'))).toBe(false);
    expect(nodes.find((node) => node.label.startsWith('T8'))?.parentId).toBeNull();
  });

  it('says nothing about the colour of a finished task and tells a node id apart', () => {
    expect(taskSentence(t, workflowTask(1, { status: 'DONE' }))).not.toContain(text('pwf.band.green.word'));
    expect(taskIdOfNode('task:abc')).toBe('abc');
    expect(taskIdOfNode('phase:X')).toBeUndefined();
    expect(phaseOfNode('phase:X')).toBe('X');
    expect(phaseOfNode('task:abc')).toBeUndefined();
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
});

describe('PWF-03 model: the Gantt', () => {
  it('draws the current schedule against the first baseline, marks the critical path in words and keeps a task with no date as a label', () => {
    const bars = ganttBars(schedule(), detail().tasks, t);
    expect(bars.map((bar) => bar.code)).toEqual(['T1', 'T2', 'T3', 'T4', 'T5']);
    const second = bars[1];
    expect(second?.label).toBe(`T2 (${text('pwf.flow.gantt.critical.mark')})`);
    expect(second?.actual).toEqual({ from: '2026-12-06', to: '2026-12-10' });
    expect(second?.planned).toEqual({ from: '2026-12-06', to: '2026-12-08' });
    const last = bars[4];
    expect(last).toMatchObject({ planned: null, actual: null });
    expect(last?.label).toContain(text('pwf.flow.gantt.noDate.mark'));
  });

  it('starts the baseline bar at the baseline finish when it is before the scheduled start, and has none without a baseline', () => {
    const early = ganttBars(schedule(), [workflowTask(1, { task_code: 'T1', baseline_finish: '2026-11-20' })], t)[0];
    expect(early?.planned).toEqual({ from: '2026-11-20', to: '2026-11-20' });
    const none = ganttBars(schedule(), [workflowTask(1, { task_code: 'T1', baseline_finish: null })], t)[0];
    expect(none?.planned).toBeNull();
  });

  it('leaves out the tasks that pass through, finds the window of the strip and the days to mark', () => {
    const pass = schedule({ tasks: [...schedule().tasks, { ...schedule().tasks[0], task_code: 'T6', state: 'PASS_THROUGH' } as never] });
    expect(ganttBars(pass, [], t).map((bar) => bar.code)).not.toContain('T6');
    expect(ganttRange(schedule())).toEqual({ from: '2026-12-01', to: '2027-02-12' });
    expect(ganttRange(schedule({ tasks: [schedule().tasks[4] as never] }))).toBeNull();
    expect(ganttMarks(schedule())).toEqual({ changes: ['2026-12-05'], deadlines: ['2026-12-10', '2027-02-12'] });
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
  it('groups the milestones that have a date by day, in order, each with the word of its colour', () => {
    const base = detail();
    const groups = milestoneGroups(detail({ tasks: [...base.tasks, workflowTask(6, { kind: 'MILESTONE', planned_finish: '2026-12-20', status: 'DONE' }), workflowTask(7, { kind: 'MILESTONE', excluded: true, planned_finish: '2026-12-21' }), workflowTask(8, { kind: 'MILESTONE', planned_finish: null })] }), t);
    expect(groups.map((group) => group.date)).toEqual(['2026-12-20', '2027-02-12']);
    expect(groups[1]?.entries[0]).toMatchObject({ badge: text('pwf.band.green.word'), tone: 'success' });
    expect(groups[0]?.entries[0]?.badge).toBeUndefined();
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

  it('pairs each gate of the workflow with the assessment read for it, and says when one could not be read', () => {
    const rows = gateRows(detail(), [{ data: { target: 'submitProjectForAppraisal', gated: true, open: false, missing: [], as_of: 'x' }, failed: false }], t);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ target: 'submitProjectForAppraisal', word: text('pwf.gate.submit.word'), missingCount: 1, failed: false });
    expect(rows[0]?.assessment?.open).toBe(false);
    expect(rows[1]).toMatchObject({ assessment: undefined, failed: false });
    expect(gateRows(detail(), [{ data: undefined, failed: true }], t)[0]?.failed).toBe(true);
  });
});
