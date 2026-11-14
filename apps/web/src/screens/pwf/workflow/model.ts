import type { Translator } from '../../../i18n';
import type { DayStripBar, ProcessTreeNode, StepperStep, TimelineGroup } from '../../../ui';
import { bandWord, gateWord, kindWord, statusWord } from '../labels';
import { bandTone, calendarMissing, hasBand, missingYears } from '../model';
import type { Band, GateAssessment, GateTarget, Schedule, TaskPage, WorkflowDetail, WorkflowPhase, WorkflowTask } from '../model';

type T = Translator['t'];
type Health = NonNullable<ProcessTreeNode['health']>;

/** What the server computed is read again when it is older than this by the time the screen read it (the figures of a cache that stopped refreshing are not today's). */
export const STALE_AFTER_MS = 15 * 60_000;
export const PAGE_SIZE = 50;

/** The numbers of a workflow are stale when the instant the server computed them is much older than the moment the screen read them. */
export function isStale(asOf: string, readAt: number, limit: number = STALE_AFTER_MS): boolean {
  const at = Date.parse(asOf);
  return !Number.isNaN(at) && readAt - at > limit;
}

// ---- health: how the tree, the board and the stepper say "late", "needs attention", "fine" --------------------------------------------------------------------------------

/** The health of one task: its official colour read as a word (the colour of a task that has none says nothing); a task whose deadline cannot be counted needs attention, it is never fine. */
export function healthOf(task: WorkflowTask): Health {
  if (task.excluded || !task.tracked || task.status === 'CANCELLED') return 'none';
  if (task.status === 'DONE') return 'ok';
  if (task.status === 'ON_HOLD') return 'hold';
  switch (task.band.band) {
    case 'RED':
      return 'late';
    case 'YELLOW':
    case 'UNKNOWN':
      return 'attention';
    case 'GREEN':
      return 'ok';
    case 'NONE':
      return 'none';
  }
}

const SEVERITY: readonly Health[] = ['late', 'attention', 'hold', 'ok', 'none'];

/** The worst health of a set of tasks. */
export function worstHealth(tasks: readonly WorkflowTask[]): Health {
  const found = new Set(tasks.map(healthOf));
  return SEVERITY.find((health) => found.has(health)) ?? 'none';
}

const isTracked = (task: WorkflowTask): boolean => !task.excluded;

const orderedPhases = (detail: WorkflowDetail): WorkflowPhase[] => [...detail.phases].sort((a, b) => a.order - b.order);

export const phaseNodeId = (code: string): string => `phase:${code}`;
export const taskNodeId = (id: string): string => `task:${id}`;

/** The id of a task node as the task id, or undefined for a phase node. */
export const taskIdOfNode = (nodeId: string): string | undefined => (nodeId.startsWith('task:') ? nodeId.slice('task:'.length) : undefined);
/** The code of a phase node, or undefined for a task node. */
export const phaseOfNode = (nodeId: string): string | undefined => (nodeId.startsWith('phase:') ? nodeId.slice('phase:'.length) : undefined);

/** The tasks of the workflow as the tree of the phases: a phase holds its tasks (tasks left out of the schedule are not in it). The sentence a screen reader hears names the status, the colour and the critical path. */
export function treeNodes(detail: WorkflowDetail, t: T): ProcessTreeNode[] {
  const phases = orderedPhases(detail);
  const known = new Set(phases.map((phase) => phase.code));
  const tasks = detail.tasks.filter(isTracked);
  const phaseNodes = phases.map((phase): ProcessTreeNode => {
    const own = tasks.filter((task) => task.phase_code === phase.code);
    return {
      id: phaseNodeId(phase.code),
      label: phase.name,
      count: own.length,
      health: worstHealth(own),
      lateCount: own.filter((task) => healthOf(task) === 'late').length,
      heldCount: own.filter((task) => task.status === 'ON_HOLD').length,
      parentId: null,
      ariaLabel: t('pwf.flow.tree.phase.aria', { name: phase.name, done: phase.required_done, total: phase.required_total, count: own.length }),
    };
  });
  const taskNodes = tasks.map(
    (task): ProcessTreeNode => ({
      id: taskNodeId(task.id),
      label: `${task.task_code} · ${task.name}`,
      count: 1,
      health: healthOf(task),
      parentId: known.has(task.phase_code) ? phaseNodeId(task.phase_code) : null,
      ariaLabel: taskSentence(t, task),
    }),
  );
  return [...phaseNodes, ...taskNodes];
}

/** What is said about a task in one sentence: code and name, the kind, the status, the colour and whether it is on the critical path. */
export function taskSentence(t: T, task: WorkflowTask): string {
  const parts = [`${task.task_code} ${task.name}`, kindWord(t, task.kind), statusWord(t, task.status)];
  if (hasBand(task)) parts.push(bandWord(t, task.band.band));
  if (task.critical) parts.push(t('pwf.flow.critical.aria'));
  return parts.join(', ');
}

// ---- the stepper of the phases ------------------------------------------------------------------------------------------------------------------------------------------------

/** The phases in order: before the open phase they are done, the open phase is current (late when one of its tasks is red, on hold when the workflow is), after it they are still to come. */
export function stepperSteps(detail: WorkflowDetail, t: T): StepperStep[] {
  const phases = orderedPhases(detail);
  const open = phases.find((phase) => phase.open);
  return phases.map((phase): StepperStep => {
    const own = detail.tasks.filter((task) => task.phase_code === phase.code && isTracked(task));
    const note = t('pwf.flow.stepper.progress.text', { done: phase.required_done, total: phase.required_total });
    if (phase.open) {
      const status = detail.status === 'ON_HOLD' ? 'hold' : own.some((task) => healthOf(task) === 'late') ? 'late' : 'current';
      return { code: phase.code, label: phase.name, status, current: true, note };
    }
    const status = open === undefined || phase.order < open.order ? 'done' : 'upcoming';
    return { code: phase.code, label: phase.name, status, note };
  });
}

// ---- the Gantt: bars of the current schedule against the first baseline ---------------------------------------------------------------------------------------------

/**
 * One bar for each task of the schedule that has dates. The solid bar is the current schedule; the dashed bar is the first baseline: the contract of the list gives the baseline finish of a task (its baseline start is
 * in the task detail only), so the dashed bar runs from the scheduled start to the baseline finish and the overrun past it is the delay against the baseline. The critical path is said in the label, not by colour.
 */
export function ganttBars(schedule: Schedule, tasks: readonly WorkflowTask[], t: T): DayStripBar[] {
  const baseline = new Map(tasks.map((task) => [task.task_code, task.baseline_finish]));
  return schedule.tasks
    .filter((task) => task.state !== 'PASS_THROUGH')
    .map((task): DayStripBar => {
      const mark = task.critical ? ` (${t('pwf.flow.gantt.critical.mark')})` : '';
      if (task.start === null || task.finish === null) return { code: task.task_code, label: `${task.task_code}${mark} (${t('pwf.flow.gantt.noDate.mark')})`, planned: null, actual: null };
      const baselineFinish = baseline.get(task.task_code) ?? null;
      const planned = baselineFinish === null ? null : { from: baselineFinish < task.start ? baselineFinish : task.start, to: baselineFinish };
      return { code: task.task_code, label: `${task.task_code}${mark}`, planned, actual: { from: task.start, to: task.finish } };
    });
}

/** The window the calendar strip covers: from the first scheduled day to the last, or null when no task has a date (the strip then says so). */
export function ganttRange(schedule: Schedule): { from: string; to: string } | null {
  const days = schedule.tasks.flatMap((task) => [task.start, task.finish].filter((day): day is string => day !== null));
  if (days.length === 0) return null;
  const sorted = [...days].sort();
  return { from: sorted[0] as string, to: sorted[sorted.length - 1] as string };
}

/** The days a completed task finished and the days an open task falls due: the marks of the strip. */
export function ganttMarks(schedule: Schedule): { changes: string[]; deadlines: string[] } {
  const done = schedule.tasks.filter((task) => task.state === 'COMPLETED' && task.finish !== null).map((task) => task.finish as string);
  const open = schedule.tasks.filter((task) => task.state === 'SCHEDULED' && task.finish !== null).map((task) => task.finish as string);
  return { changes: [...new Set(done)], deadlines: [...new Set(open)] };
}

/** The largest delay of a task against the first baseline in the schedule (positive is late), or null when no task has a variance. */
export function worstVariance(schedule: Schedule): { days: number; task: string } | null {
  let worst: { days: number; task: string } | null = null;
  for (const task of schedule.tasks) {
    if (task.finish_variance_days !== null && (worst === null || task.finish_variance_days > worst.days)) worst = { days: task.finish_variance_days, task: task.task_code };
  }
  return worst;
}

/** The years that have no working calendar: those of the tasks that could not be dated and those the schedule names in its findings. */
export function calendarYears(detail: WorkflowDetail, schedule: Schedule | undefined): number[] {
  const fromFindings = (schedule?.findings ?? []).flatMap((finding) => (finding.code === 'CALENDAR_UNAVAILABLE' && typeof finding.year === 'number' ? [finding.year] : []));
  const fromTasks = missingYears(detail.tasks.filter(calendarMissing));
  return [...new Set([...fromTasks, ...fromFindings])].sort((a, b) => a - b);
}

// ---- the milestones by day ----------------------------------------------------------------------------------------------------------------------------------------------

/** The milestones that have a date, a day after another, each with the word and tone of its official colour. A milestone with no date is left out: the screen says why (missing calendar). */
export function milestoneGroups(detail: WorkflowDetail, t: T): TimelineGroup[] {
  const byDay = new Map<string, TimelineGroup['entries'][number][]>();
  for (const task of detail.tasks) {
    if (task.kind !== 'MILESTONE' || task.excluded || task.planned_finish === null) continue;
    const entries = byDay.get(task.planned_finish) ?? [];
    entries.push({
      id: task.id,
      at: `${task.planned_finish}T00:00:00.000+07:00`,
      kind: 'note',
      title: t('pwf.flow.timeline.entry.text', { code: task.task_code, name: task.name }),
      ...(hasBand(task) ? { badge: bandWord(t, task.band.band), tone: bandTone(task.band.band) } : {}),
      note: statusWord(t, task.status),
    });
    byDay.set(task.planned_finish, entries);
  }
  return [...byDay.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([date, entries]) => ({ date, entries }));
}

// ---- the list: filters, cursor and the board by phase -----------------------------------------------------------------------------------------------------------------

export interface TaskFilter {
  phase: string;
  band: '' | Band;
  status: string;
  assignee: string;
}

export const NO_FILTER: TaskFilter = { phase: '', band: '', status: '', assignee: '' };

export const appliedFilters = (filter: TaskFilter): number => Object.values(filter).filter((value) => value !== '').length;

/** The query of the list of tasks: a filter left empty is not sent. */
export function taskQuery(filter: TaskFilter, cursor?: string): { phase?: string; band?: string; status?: string; assignee_id?: string; limit: number; cursor?: string } {
  return {
    ...(filter.phase === '' ? {} : { phase: filter.phase }),
    ...(filter.band === '' ? {} : { band: filter.band }),
    ...(filter.status === '' ? {} : { status: filter.status }),
    ...(filter.assignee === '' ? {} : { assignee_id: filter.assignee }),
    limit: PAGE_SIZE,
    ...(cursor === undefined ? {} : { cursor }),
  };
}

/** The people tasks are given to, each once, by name: the choices of the filter. */
export function assigneeOptions(tasks: readonly WorkflowTask[]): { id: string; name: string }[] {
  const byId = new Map<string, string>();
  for (const task of tasks) if (task.assignee !== null) byId.set(task.assignee.membership_id, task.assignee.display_name);
  return [...byId.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
}

export interface BoardColumn {
  code: string;
  name: string;
  required: { done: number; total: number } | null;
  items: TaskPage['items'];
}

/** The tasks read so far as columns, one for each phase in order; a task whose phase the workflow does not list gets a column of its own at the end (never dropped). */
export function boardColumns(phases: readonly WorkflowPhase[], items: TaskPage['items']): BoardColumn[] {
  const ordered = [...phases].sort((a, b) => a.order - b.order);
  const known = new Set(ordered.map((phase) => phase.code));
  const columns: BoardColumn[] = ordered.map((phase) => ({ code: phase.code, name: phase.name, required: { done: phase.required_done, total: phase.required_total }, items: items.filter((item) => item.phase_code === phase.code) }));
  const strays = [...new Set(items.filter((item) => !known.has(item.phase_code)).map((item) => item.phase_code))];
  return [...columns, ...strays.map((code): BoardColumn => ({ code, name: code, required: null, items: items.filter((item) => item.phase_code === code) }))];
}

// ---- the gates of the commands of the project ------------------------------------------------------------------------------------------------------------------------

export interface GateRow {
  target: GateTarget;
  word: string;
  /** From the workflow: how many required tasks still stand in the way. */
  missingCount: number;
  /** From the assessment of the gate, once it was read. */
  assessment: GateAssessment | undefined;
  failed: boolean;
  /** How the gate stands for the reader (the assessment once read, else what the workflow says): a closed gate of a phase the project has not reached is NOT_DUE, never CLOSED. */
  standing: GateStanding;
}

export type GateStanding = 'UNGATED' | 'OPEN' | 'CLOSED' | 'NOT_DUE';

/** The standing the server gives; a server that gives none is read as before (ungated, open or closed). */
export function gateStandingOf(gate: { open: boolean; standing?: GateStanding | undefined }, assessment: (GateAssessment & { standing?: GateStanding | undefined }) | undefined): GateStanding {
  const told = assessment?.standing ?? (assessment === undefined ? gate.standing : undefined);
  if (told !== undefined) return told;
  if (assessment !== undefined && !assessment.gated) return 'UNGATED';
  return (assessment?.open ?? gate.open) ? 'OPEN' : 'CLOSED';
}

/** The gates the workflow declares, each with the assessment read for it (a gate whose assessment failed to read says so and keeps what the workflow knows). */
export function gateRows(detail: WorkflowDetail, results: readonly { data: GateAssessment | undefined; failed: boolean }[], t: T): GateRow[] {
  return detail.gates.map((gate, index) => ({ target: gate.target, word: gateWord(t, gate.target), missingCount: gate.missing_count, assessment: results[index]?.data, failed: results[index]?.failed ?? false, standing: gateStandingOf(gate, results[index]?.data) }));
}
