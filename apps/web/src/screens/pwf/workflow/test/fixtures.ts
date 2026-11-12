import { detail as projectDetail } from '../../../prj/test-support';
import type { Schedule, TaskPage, WorkflowDetail, WorkflowTask } from '../../model';
import { PROJECT_ID, band, scheduleTask, serve, workflowDetail, workflowTask } from '../../test/fixtures';
import type { Answer } from '../../test/fixtures';

/** The instant the server computed the figures, now: a read that is not older than the stale limit. */
export const fresh = (): string => new Date().toISOString();

const T1 = workflowTask(1, { status: 'DONE', band: band('NONE', { reason: 'NO_DUE' }) });
const T2 = workflowTask(2, { status: 'IN_PROGRESS', band: band('RED'), critical: true });
const T3 = workflowTask(3, { phase_code: 'EXECUTION', planned_start: '2027-01-04', planned_finish: '2027-02-12', baseline_finish: '2027-02-05', band: band('YELLOW'), assignee: null });
const T4 = workflowTask(4, { phase_code: 'EXECUTION', kind: 'MILESTONE', name: 'Mốc khởi công', planned_start: '2027-02-12', planned_finish: '2027-02-12', baseline_finish: '2027-02-12', band: band('GREEN') });
const T5 = workflowTask(5, { phase_code: 'EXECUTION', state: 'CALENDAR_UNAVAILABLE', missing_year: 2028, planned_start: null, planned_finish: null, baseline_finish: null, band: band('UNKNOWN', { reason: 'CALENDAR_UNAVAILABLE' }) });

export const TASKS: readonly WorkflowTask[] = [T1, T2, T3, T4, T5];

/** A workflow with five tasks: one done, one red on the critical path, one yellow, a green milestone and one whose year has no calendar. */
export const detail = (over: Partial<WorkflowDetail> = {}): WorkflowDetail =>
  workflowDetail({
    as_of: fresh(),
    tasks: [...TASKS],
    counts_by_band: { NONE: 1, GREEN: 1, YELLOW: 1, RED: 1, UNKNOWN: 1 },
    ...over,
  });

export const schedule = (over: Partial<Schedule> = {}): Schedule => ({
  workflow_id: detail().id,
  schedule_version: 2,
  planned_start_date: '2026-12-01',
  published_at: fresh(),
  project_start: '2026-12-01',
  project_finish: '2027-02-12',
  critical_path: ['T2', 'T3'],
  longest_path: ['T2', 'T3'],
  calendar_versions: [{ year: 2026, version: 1 }],
  tasks: [
    scheduleTask('T1', { state: 'COMPLETED', start: '2026-12-01', finish: '2026-12-05', critical: false, finish_variance_days: -1 }),
    scheduleTask('T2', { start: '2026-12-06', finish: '2026-12-10', finish_variance_days: 2 }),
    scheduleTask('T3', { phase_code: 'EXECUTION', start: '2027-01-04', finish: '2027-02-12', finish_variance_days: 5 }),
    scheduleTask('T4', { phase_code: 'EXECUTION', kind: 'MILESTONE', start: '2027-02-12', finish: '2027-02-12', critical: false }),
    scheduleTask('T5', { phase_code: 'EXECUTION', state: 'CALENDAR_UNAVAILABLE', start: null, finish: null, critical: false, missing_year: 2028, total_float: null, free_float: null }),
  ],
  excluded_tasks: [],
  findings: [{ code: 'CALENDAR_UNAVAILABLE', task: 'T5', year: 2028 }],
  result_hash: 'c'.repeat(64),
  as_of: fresh(),
  ...over,
});

const pageOf = (items: readonly WorkflowTask[], over: Partial<TaskPage> = {}): TaskPage => ({ items: [...items], next_cursor: null, total: items.length, as_of: fresh(), ...over });

/** The list of tasks as the server filters it by phase, colour, status and person. */
export const taskList = (input: Record<string, unknown>): TaskPage => {
  const query = (input.query ?? {}) as Record<string, string>;
  const items = TASKS.filter(
    (task) => (query.phase === undefined || task.phase_code === query.phase) && (query.band === undefined || task.band.band === query.band) && (query.status === undefined || task.status === query.status) && (query.assignee_id === undefined || task.assignee?.membership_id === query.assignee_id),
  );
  return pageOf(items);
};

/** The assessment of a gate: open when it has no missing task. */
export const gate = (input: Record<string, unknown>) => {
  const target = ((input.path ?? {}) as { target: WorkflowDetail['gates'][number]['target'] }).target;
  const closed = target === 'submitProjectForAppraisal';
  return {
    target,
    gated: true,
    open: !closed,
    missing: closed ? [{ task: 'T2', task_id: T2.id, phase: 'PREPARATION', reason: 'NOT_DONE' as const }, { task: 'T9', task_id: null, phase: 'PREPARATION', reason: 'NO_STATE' as const }] : [],
    as_of: fresh(),
  };
};

export interface Setup {
  workflow?: Answer;
  schedule?: Answer;
  tasks?: Answer;
  gate?: Answer;
  project?: Answer;
}

/** A client over the reads of the screen. */
export const open = (setup: Setup = {}) =>
  serve({
    getProjectWorkflow: setup.workflow ?? (() => detail()),
    getProjectSchedule: setup.schedule ?? (() => schedule()),
    listProjectTasks: setup.tasks ?? taskList,
    evaluateProjectGate: setup.gate ?? gate,
    get_resources_project_id: setup.project ?? { ...projectDetail(1), id: PROJECT_ID },
  });
