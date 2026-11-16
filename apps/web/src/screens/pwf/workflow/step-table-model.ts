import { hasBand } from '../model';
import { phaseStandingOf } from './model';
import type { Band, Schedule, WorkflowDetail, WorkflowTask } from '../model';
import type { WorkflowStep } from '../process/model';

/**
 * The pure side of the step table of PWF-03 (the default view "Bảng bước"): the rows a person reads (phase, step, tasks of a multi-task step), what blocks a row, what a row may do for the permissions held, and the figures of the
 * header. Nothing here computes a colour or a deadline: the band, the remaining days and the day are the server's (R73), the model only picks and groups what the one response of the workflow already says.
 */

const OPEN_STATUSES = new Set<WorkflowTask['status']>(['NOT_STARTED', 'IN_PROGRESS', 'AWAITING_APPROVAL', 'ON_HOLD']);

/** A task that is still to be done: not done, not cancelled, not cut out of the project. */
export const isOpen = (task: Pick<WorkflowTask, 'status' | 'excluded'>): boolean => !task.excluded && OPEN_STATUSES.has(task.status);

// ---- what stands in the way of a row -----------------------------------------------------------------------------------------------------------------------------------

export type BlockedBy = { kind: 'approval' } | { kind: 'evidence'; open: number } | { kind: 'predecessor'; code: string; name: string };

/**
 * What a task waits for, from the answers the screen already holds (the workflow and, when it is read, the schedule): the approver of its completion, the items of its checklist or evidence still open, or the task that drives its
 * start while that one is not done. No request per row. A task that is over, left out or not followed is blocked by nothing.
 */
export function blockedByOf(task: WorkflowTask, tasks: ReadonlyMap<string, WorkflowTask>, schedule: Schedule | undefined): BlockedBy[] {
  if (!isOpen(task) || !task.tracked) return [];
  const found: BlockedBy[] = [];
  if (task.status === 'AWAITING_APPROVAL') found.push({ kind: 'approval' });
  const open = (task.checklist_total ?? 0) - (task.checklist_done ?? 0);
  if (task.status === 'IN_PROGRESS' && open > 0) found.push({ kind: 'evidence', open });
  if (task.status === 'NOT_STARTED') {
    const driving = schedule?.tasks.find((row) => row.task_code === task.task_code)?.driving_predecessor ?? null;
    const before = driving === null ? undefined : tasks.get(driving);
    if (before !== undefined && isOpen(before)) found.push({ kind: 'predecessor', code: before.task_code, name: before.name });
  }
  return found;
}

// ---- what a row may do -------------------------------------------------------------------------------------------------------------------------------------------------------

export interface Capabilities {
  /** `pwf.task.work` and not a read-only session. */
  work: boolean;
  /** `pwf.task.approve`. */
  approve: boolean;
  /** `pwf.schedule.propose`. */
  propose: boolean;
}

export type RowAction = 'claim' | 'approve' | 'submit' | 'complete';

const checklistOpen = (task: Pick<WorkflowTask, 'checklist_total' | 'checklist_done'>): number => Math.max(0, (task.checklist_total ?? 0) - (task.checklist_done ?? 0));

/**
 * The one action a row offers, by state and by what the person holds. A task nobody has taken is claimed first ("Nhận việc": the server decides whether this person belongs to the unit and holds the role, and says why not at the row);
 * a task waiting for its approver is approved by who may approve; one in progress goes to its evidence while the checklist is open ("Nộp hồ sơ", the many fields are on PWF-04) and is completed when nothing is open.
 */
export function rowActionOf(task: WorkflowTask, can: Capabilities): RowAction | null {
  if (!isOpen(task) || !task.tracked) return null;
  if (task.unclaimed === true) return can.work ? 'claim' : null;
  if (task.status === 'AWAITING_APPROVAL') return can.approve ? 'approve' : null;
  if (task.status === 'IN_PROGRESS' && can.work) return checklistOpen(task) > 0 ? 'submit' : 'complete';
  return null;
}

export interface ExtensionOffer {
  /** How many times and how much of the limit is used, as the server counts it. */
  timesUsed: number;
  maxTimes: number | null;
  valueUsed: number;
  maxValue: number | null;
  unit: NonNullable<WorkflowTask['extension']>['unit'];
  /** A cap is reached: no request can be made (the server would refuse it), and the row says so instead of offering it. */
  capped: boolean;
}

/** The extension a row may ask for: only a task whose frozen template allows it, that is still to be done, for a person who may propose a schedule change. */
export function extensionOffer(task: Pick<WorkflowTask, 'status' | 'excluded' | 'tracked' | 'extension'>, can: Capabilities): ExtensionOffer | null {
  const rule = task.extension;
  if (rule === undefined || !rule.allowed || !can.propose || !isOpen(task) || !task.tracked) return null;
  const capped = (rule.max_times !== null && rule.times_used >= rule.max_times) || (rule.max_value !== null && rule.value_used >= rule.max_value);
  return { timesUsed: rule.times_used, maxTimes: rule.max_times, valueUsed: rule.value_used, maxValue: rule.max_value, unit: rule.unit, capped };
}

// ---- the rows ------------------------------------------------------------------------------------------------------------------------------------------------------------------

/** One line of the table: a step (with the tasks that belong to it) or a task the project added itself (no step). A step with one task is ONE row; a step with several tasks is a row with child rows. */
export interface StepEntry {
  key: string;
  /** "3" for a step; the child tasks are numbered "3.1". */
  number: string;
  step: WorkflowStep | null;
  tasks: WorkflowTask[];
}

export interface PhaseRows {
  code: string;
  name: string;
  order: number;
  requiredDone: number;
  requiredTotal: number;
  /** The phase the project is in now (the server's `current`, else the open phase). */
  current: boolean;
  entries: StepEntry[];
}

const visible = (tasks: readonly WorkflowTask[]): WorkflowTask[] => tasks.filter((task) => !task.excluded);

/**
 * The phases of the workflow as band rows, each with its steps in order: a step with its tasks (those left out of the project are not rows), then the tasks of the phase that belong to no step. A workflow read from before steps
 * existed has none: every task is then a row of its phase. Numbers run across the phases.
 */
export function phaseRows(detail: WorkflowDetail): PhaseRows[] {
  const steps = detail.steps ?? [];
  let n = 0;
  return [...detail.phases]
    .sort((a, b) => a.order - b.order)
    .map((phase): PhaseRows => {
      const inPhase = detail.tasks.filter((task) => task.phase_code === phase.code);
      const mine = steps.filter((step) => step.phase_code === phase.code).sort((a, b) => a.order - b.order);
      const known = new Set(mine.map((step) => step.code));
      const entries: StepEntry[] = [];
      const add = (key: string, step: WorkflowStep | null, tasks: WorkflowTask[]): void => {
        if (tasks.length === 0) return;
        n += 1;
        entries.push({ key, number: String(n), step, tasks });
      };
      for (const step of mine) add(`step:${step.code}`, step, visible(inPhase.filter((task) => task.step_code === step.code)));
      for (const task of visible(inPhase.filter((one) => one.step_code === null || one.step_code === undefined || !known.has(one.step_code)))) add(`task:${task.task_code}`, null, [task]);
      return {
        code: phase.code,
        name: phase.name,
        order: phase.order,
        requiredDone: phase.required_done,
        requiredTotal: phase.required_total,
        current: phaseStandingOf(phase, detail.phases) === 'CURRENT',
        entries,
      };
    });
}

const RANK: Readonly<Record<Band, number>> = { RED: 0, YELLOW: 1, UNKNOWN: 2, GREEN: 3, NONE: 4 };

/**
 * The task of a step that carries the worst official colour (red, then yellow, then a deadline that cannot be counted, then green): the row of a step with several tasks shows ITS colour, as the server gave it, so the step never
 * looks better than its worst task. A step whose tasks have no colour (all done) has none.
 */
export function worstBandTask(tasks: readonly WorkflowTask[]): WorkflowTask | null {
  const banded = tasks.filter(hasBand);
  if (banded.length === 0) return null;
  return banded.reduce((worst, task) => (RANK[task.band.band] < RANK[worst.band.band] ? task : worst));
}

/** The earliest deadline among the open tasks of a step, else the latest of the tasks that are over: what the row of a step with several tasks says it is due. */
export function stepDue(entry: StepEntry): string | null {
  if (entry.step?.planned_finish !== undefined && entry.step.planned_finish !== null) return entry.step.planned_finish;
  const days = entry.tasks.flatMap((task) => (task.planned_finish === null ? [] : [task.planned_finish])).sort();
  return days.length === 0 ? null : (days[days.length - 1] ?? null);
}

// ---- the header ----------------------------------------------------------------------------------------------------------------------------------------------------------------

export interface Progress {
  done: number;
  total: number;
  /** What is counted: the steps of the template, or the tasks when the workflow has no steps. */
  of: 'steps' | 'tasks';
}

/** How far the workflow is: steps done of the steps that apply; a workflow with no steps counts its tasks (those left out are not counted). */
export function progressOf(detail: WorkflowDetail): Progress {
  const steps = (detail.steps ?? []).filter((step) => step.status !== 'NOT_APPLICABLE');
  if (steps.length > 0) return { done: steps.filter((step) => step.status === 'DONE').length, total: steps.length, of: 'steps' };
  const tasks = detail.tasks.filter((task) => !task.excluded && task.status !== 'CANCELLED');
  return { done: tasks.filter((task) => task.status === 'DONE').length, total: tasks.length, of: 'tasks' };
}

/** The phase the project is in, by name; null when every phase is done or the workflow does not say. */
export function openPhaseName(detail: WorkflowDetail): string | null {
  const phase = detail.phases.find((one) => phaseStandingOf(one, detail.phases) === 'CURRENT');
  return phase?.name ?? null;
}

/**
 * How many days the deadline of the whole file stands behind the first baseline, as the schedule counts it (working days, the server's figure); null when the schedule is not read or the task has no variance. Zero or less is "on time".
 */
export function overallSlip(detail: WorkflowDetail, schedule: Schedule | undefined): number | null {
  const overall = detail.overall_deadline ?? null;
  if (overall === null || schedule === undefined) return null;
  return schedule.tasks.find((task) => task.task_code === overall.task_code)?.finish_variance_days ?? null;
}
