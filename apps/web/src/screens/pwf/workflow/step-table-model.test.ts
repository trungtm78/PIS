import { describe, expect, it } from 'vitest';
import type { WorkflowStep } from '../process/model';
import { band, scheduleTask, uuid, workflowDetail, workflowTask } from '../test/fixtures';
import { schedule } from './test/fixtures';
import { blockedByOf, extensionOffer, isOpen, openPhaseName, overallSlip, phaseRows, progressOf, rowActionOf, stepDue, worstBandTask } from './step-table-model';
import type { Capabilities } from './step-table-model';

const ALL: Capabilities = { work: true, approve: true, propose: true };
const NONE: Capabilities = { work: false, approve: false, propose: false };
const by = (...tasks: ReturnType<typeof workflowTask>[]) => new Map(tasks.map((task) => [task.task_code, task]));

const step = (code: string, phase: string, order: number, over: Partial<WorkflowStep> = {}): WorkflowStep => ({
  code,
  name: `Bước ${code}`,
  phase_code: phase,
  order,
  implicit: false,
  responsible_role: null,
  status: 'NOT_STARTED',
  standard_working_days: 5,
  planned_start: null,
  planned_finish: null,
  task_total: 1,
  task_done: 0,
  required_total: 1,
  required_done: 0,
  checklist_total: 0,
  checklist_done: 0,
  legal_basis: [],
  ...over,
});

describe('step table: what blocks a row', () => {
  it('says a task waiting for its approver is blocked by the approver', () => {
    const task = workflowTask(1, { status: 'AWAITING_APPROVAL' });
    expect(blockedByOf(task, by(task), undefined)).toEqual([{ kind: 'approval' }]);
  });

  it('counts the evidence still open of a task in progress, and says nothing once the checklist is complete', () => {
    expect(blockedByOf(workflowTask(1, { status: 'IN_PROGRESS', checklist_total: 3, checklist_done: 1 }), new Map(), undefined)).toEqual([{ kind: 'evidence', open: 2 }]);
    expect(blockedByOf(workflowTask(1, { status: 'IN_PROGRESS', checklist_total: 3, checklist_done: 3 }), new Map(), undefined)).toEqual([]);
    // A task that has not started is not asked for evidence yet.
    expect(blockedByOf(workflowTask(1, { status: 'NOT_STARTED', checklist_total: 3, checklist_done: 0 }), new Map(), undefined)).toEqual([]);
  });

  it('names the task that drives the start while that task is not done, from the schedule already read', () => {
    const before = workflowTask(1, { status: 'IN_PROGRESS' });
    const task = workflowTask(2, { status: 'NOT_STARTED' });
    const plan = schedule({ tasks: [scheduleTask('T1'), scheduleTask('T2', { driving_predecessor: 'T1' })] });
    expect(blockedByOf(task, by(before, task), plan)).toEqual([{ kind: 'predecessor', code: 'T1', name: 'Công việc 1' }]);
    expect(blockedByOf(task, by({ ...before, status: 'DONE' }, task), plan)).toEqual([]);
    // No schedule read, or the predecessor is not a task of the project: nothing is guessed.
    expect(blockedByOf(task, by(before, task), undefined)).toEqual([]);
    expect(blockedByOf(task, by(task), plan)).toEqual([]);
  });

  it('blocks nothing that is over, left out or not followed', () => {
    for (const over of [{ status: 'DONE' as const }, { status: 'CANCELLED' as const }, { excluded: true }, { tracked: false }]) {
      expect(blockedByOf(workflowTask(1, { status: 'AWAITING_APPROVAL', ...over }), new Map(), undefined)).toEqual([]);
    }
  });
});

describe('step table: the action of a row', () => {
  it('offers "claim" to a person who may work on a task nobody took, and to nobody else', () => {
    const task = workflowTask(1, { unclaimed: true, assignee: null });
    expect(rowActionOf(task, ALL)).toBe('claim');
    expect(rowActionOf(task, { ...ALL, work: false })).toBeNull();
    // A task that has a holder is not claimable even when the person may work.
    expect(rowActionOf(workflowTask(1, { unclaimed: false, status: 'NOT_STARTED' }), ALL)).toBeNull();
  });

  it('offers "approve" while the completion waits, to the approver only', () => {
    const task = workflowTask(1, { status: 'AWAITING_APPROVAL' });
    expect(rowActionOf(task, ALL)).toBe('approve');
    expect(rowActionOf(task, { ...ALL, approve: false })).toBeNull();
  });

  it('sends a task in progress to its evidence while the checklist is open and offers "complete" once it is not', () => {
    expect(rowActionOf(workflowTask(1, { status: 'IN_PROGRESS', checklist_total: 2, checklist_done: 1 }), ALL)).toBe('submit');
    expect(rowActionOf(workflowTask(1, { status: 'IN_PROGRESS', checklist_total: 2, checklist_done: 2 }), ALL)).toBe('complete');
    expect(rowActionOf(workflowTask(1, { status: 'IN_PROGRESS' }), ALL)).toBe('complete');
    expect(rowActionOf(workflowTask(1, { status: 'IN_PROGRESS' }), NONE)).toBeNull();
  });

  it('offers nothing for a task that is over or left out', () => {
    for (const over of [{ status: 'DONE' as const }, { status: 'CANCELLED' as const }, { excluded: true }, { tracked: false }]) {
      expect(rowActionOf(workflowTask(1, { unclaimed: true, ...over }), ALL)).toBeNull();
    }
  });

  it('offers an extension only where the frozen template allows it, the person may propose and a cap is not reached', () => {
    const rule = { allowed: true, max_times: 1, max_value: 10, unit: 'WORKING_DAY' as const, times_used: 0, value_used: 0 };
    const task = workflowTask(1, { status: 'IN_PROGRESS', extension: rule });
    expect(extensionOffer(task, ALL)).toMatchObject({ timesUsed: 0, maxTimes: 1, maxValue: 10, capped: false });
    expect(extensionOffer(task, NONE)).toBeNull();
    expect(extensionOffer(workflowTask(1, { status: 'IN_PROGRESS' }), ALL)).toBeNull();
    expect(extensionOffer(workflowTask(1, { status: 'IN_PROGRESS', extension: { ...rule, allowed: false } }), ALL)).toBeNull();
    expect(extensionOffer(workflowTask(1, { status: 'DONE', extension: rule }), ALL)).toBeNull();
    expect(extensionOffer(workflowTask(1, { status: 'IN_PROGRESS', extension: { ...rule, times_used: 1 } }), ALL)?.capped).toBe(true);
    expect(extensionOffer(workflowTask(1, { status: 'IN_PROGRESS', extension: { ...rule, value_used: 10 } }), ALL)?.capped).toBe(true);
    // A limit of null is no limit.
    expect(extensionOffer(workflowTask(1, { status: 'IN_PROGRESS', extension: { ...rule, max_times: null, max_value: null, times_used: 9, value_used: 99 } }), ALL)?.capped).toBe(false);
  });

  it('calls a task open while it is to be done, and not a task that is over or cut out', () => {
    expect(isOpen(workflowTask(1, { status: 'ON_HOLD' }))).toBe(true);
    expect(isOpen(workflowTask(1, { status: 'DONE' }))).toBe(false);
    expect(isOpen(workflowTask(1, { excluded: true }))).toBe(false);
  });
});

describe('step table: the rows', () => {
  const t1 = workflowTask(1, { step_code: 'S1' });
  const t2 = workflowTask(2, { step_code: 'S2' });
  const t3 = workflowTask(3, { step_code: 'S2' });
  const t4 = workflowTask(4, { phase_code: 'EXECUTION', step_code: null });
  const gone = workflowTask(5, { step_code: 'S2', excluded: true });
  const detail = workflowDetail({
    tasks: [t1, t2, t3, t4, gone],
    steps: [step('S1', 'PREPARATION', 1), step('S2', 'PREPARATION', 2)],
  });

  it('puts the steps of a phase in order, numbers them across the phases and leaves out the tasks cut from the project', () => {
    const rows = phaseRows(detail);
    expect(rows.map((phase) => phase.code)).toEqual(['PREPARATION', 'EXECUTION']);
    const first = rows[0]?.entries ?? [];
    expect(first.map((entry) => [entry.number, entry.step?.code, entry.tasks.map((task) => task.task_code)])).toEqual([
      ['1', 'S1', ['T1']],
      ['2', 'S2', ['T2', 'T3']],
    ]);
    // A task of no step is a row of its phase.
    expect((rows[1]?.entries ?? []).map((entry) => [entry.number, entry.step, entry.tasks.map((task) => task.task_code)])).toEqual([['3', null, ['T4']]]);
  });

  it('marks the phase the project is in, by the server', () => {
    expect(phaseRows(detail).map((phase) => phase.current)).toEqual([true, false]);
    const told = workflowDetail({ phases: [{ code: 'PREPARATION', name: 'A', order: 1, gates: [], required_total: 1, required_done: 1, open: false, current: false }, { code: 'EXECUTION', name: 'B', order: 2, gates: [], required_total: 1, required_done: 0, open: true, current: true }] });
    expect(phaseRows(told).map((phase) => phase.current)).toEqual([false, true]);
  });

  it('reads a workflow from before steps existed as one row per task', () => {
    const old = workflowDetail({ tasks: [t1, t2], steps: undefined });
    expect((phaseRows(old)[0]?.entries ?? []).map((entry) => [entry.number, entry.step, entry.tasks.length])).toEqual([
      ['1', null, 1],
      ['2', null, 1],
    ]);
  });

  it('gives the step with several tasks the worst official colour of its tasks, as the server said it, and none when all are over', () => {
    const green = workflowTask(1, { band: band('GREEN') });
    const red = workflowTask(2, { band: band('RED') });
    const yellow = workflowTask(3, { band: band('YELLOW') });
    const unknown = workflowTask(4, { band: band('UNKNOWN', { reason: 'CALENDAR_UNAVAILABLE' }) });
    expect(worstBandTask([green, red, yellow])).toBe(red);
    expect(worstBandTask([green, unknown])).toBe(unknown);
    expect(worstBandTask([green, yellow])).toBe(yellow);
    expect(worstBandTask([workflowTask(5, { status: 'DONE', band: band('RED') })])).toBeNull();
  });

  it('says a step is due when its template says so, else on the latest day of its tasks', () => {
    const entry = { key: 'k', number: '1', step: step('S', 'P', 1, { planned_finish: '2026-12-30' }), tasks: [workflowTask(1, { planned_finish: '2026-12-10' })] };
    expect(stepDue(entry)).toBe('2026-12-30');
    expect(stepDue({ ...entry, step: null, tasks: [workflowTask(1, { planned_finish: '2026-12-10' }), workflowTask(2, { planned_finish: '2026-12-20' })] })).toBe('2026-12-20');
    expect(stepDue({ ...entry, step: null, tasks: [workflowTask(1, { planned_finish: null })] })).toBeNull();
  });
});

describe('step table: the header', () => {
  it('counts the steps done of those that apply, else the tasks', () => {
    const steps = [step('A', 'PREPARATION', 1, { status: 'DONE' }), step('B', 'PREPARATION', 2), step('C', 'PREPARATION', 3, { status: 'NOT_APPLICABLE' })];
    expect(progressOf(workflowDetail({ steps }))).toEqual({ done: 1, total: 2, of: 'steps' });
    expect(progressOf(workflowDetail({ steps: undefined, tasks: [workflowTask(1, { status: 'DONE' }), workflowTask(2), workflowTask(3, { excluded: true }), workflowTask(4, { status: 'CANCELLED' })] }))).toEqual({ done: 1, total: 2, of: 'tasks' });
  });

  it('names the phase the project is in', () => {
    expect(openPhaseName(workflowDetail())).toBe('Chuẩn bị đầu tư');
    expect(openPhaseName(workflowDetail({ open_phase: null }))).toBeNull();
  });

  it('reads the slip of the overall deadline from the schedule, and nothing without it', () => {
    const overall = { task_id: uuid(1), task_code: 'T3', task_name: 'Quyết định', due_on: '2027-02-12', band: 'YELLOW' as const, band_tier: 'STEP' as const, remaining_days: 5 };
    const detail = workflowDetail({ overall_deadline: overall });
    expect(overallSlip(detail, schedule())).toBe(5);
    expect(overallSlip(detail, undefined)).toBeNull();
    expect(overallSlip(workflowDetail({ overall_deadline: null }), schedule())).toBeNull();
    expect(overallSlip(workflowDetail({ overall_deadline: { ...overall, task_code: 'T404' } }), schedule())).toBeNull();
  });
});
