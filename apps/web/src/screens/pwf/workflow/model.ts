import type { Translator } from '../../../i18n';
import type { StepperStep } from '../../../ui';
import { gateWord } from '../labels';
import { calendarMissing, missingYears } from '../model';
import type { Band, GateAssessment, GateTarget, Schedule, TaskPage, WorkflowDetail, WorkflowPhase, WorkflowTask } from '../model';

type T = Translator['t'];
export type Health = 'late' | 'attention' | 'hold' | 'ok' | 'none';

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

// ---- the stepper of the phases ------------------------------------------------------------------------------------------------------------------------------------------------

export type PhaseStanding = NonNullable<WorkflowPhase['standing']>;

/**
 * Where a phase stands, as the server says it (`standing`: exactly one phase is CURRENT, the earliest with required work left; a later phase with work in parallel has STARTED). An answer kept from before the server said so is read by
 * the same rule as far as it can be: the earliest phase that is still open is the current one, the ones before it are done and the ones after it are to come. `open` alone is never "here": several phases are open at once.
 */
export function phaseStandingOf(phase: WorkflowPhase, phases: readonly WorkflowPhase[]): PhaseStanding {
  if (phase.standing !== undefined) return phase.standing;
  const first = [...phases].sort((a, b) => a.order - b.order).find((one) => one.open);
  if (first === undefined || phase.order < first.order) return 'DONE';
  return phase.code === first.code ? 'CURRENT' : 'UPCOMING';
}

/** The phases in order: the one the project is at is current (late when one of its tasks is red, on hold when the workflow is), and it is the only one; the others are done, have started in parallel, or are still to come. */
export function stepperSteps(detail: WorkflowDetail, t: T): StepperStep[] {
  const phases = orderedPhases(detail);
  return phases.map((phase): StepperStep => {
    const own = detail.tasks.filter((task) => task.phase_code === phase.code && isTracked(task));
    const note = t('pwf.flow.stepper.progress.text', { done: phase.required_done, total: phase.required_total });
    switch (phaseStandingOf(phase, phases)) {
      case 'CURRENT': {
        const status = detail.status === 'ON_HOLD' ? 'hold' : own.some((task) => healthOf(task) === 'late') ? 'late' : 'current';
        return { code: phase.code, label: phase.name, status, current: true, note };
      }
      case 'STARTED':
        return { code: phase.code, label: phase.name, status: 'started', note };
      case 'DONE':
        return { code: phase.code, label: phase.name, status: 'done', note };
      case 'UPCOMING':
        return { code: phase.code, label: phase.name, status: 'upcoming', note };
    }
  });
}

// ---- the Gantt: bars of the current schedule against the first baseline, on a time axis --------------------------------------------------------------------------

export interface GanttSpan {
  from: string;
  to: string;
}

export interface GanttRow {
  code: string;
  name: string;
  phase: string;
  milestone: boolean;
  critical: boolean;
  done: boolean;
  /** The current schedule of the task; null when it has no dates (its calendar is missing). */
  actual: GanttSpan | null;
  /**
   * The first baseline: the list gives the baseline finish of a task (its baseline start is in the task detail only), so the dashed bar runs from the scheduled start to the baseline finish and what the solid bar
   * runs past it is the delay against the baseline.
   */
  baseline: GanttSpan | null;
  /** Days the finish is later than the baseline (positive is late). */
  variance: number | null;
}

/** One row for each task of the schedule that is worked on (a task passed through is left out), in the order of the schedule. */
export function ganttRows(schedule: Schedule, tasks: readonly WorkflowTask[]): GanttRow[] {
  const baseline = new Map(tasks.map((task) => [task.task_code, task.baseline_finish]));
  return schedule.tasks
    .filter((task) => task.state !== 'PASS_THROUGH')
    .map((task): GanttRow => {
      const common = { code: task.task_code, name: task.name, phase: task.phase_code, milestone: task.kind === 'MILESTONE', critical: task.critical, done: task.state === 'COMPLETED', variance: task.finish_variance_days };
      if (task.start === null || task.finish === null) return { ...common, actual: null, baseline: null };
      const baselineFinish = baseline.get(task.task_code) ?? null;
      return { ...common, actual: { from: task.start, to: task.finish }, baseline: baselineFinish === null ? null : { from: baselineFinish < task.start ? baselineFinish : task.start, to: baselineFinish } };
    });
}

const utc = (day: string): number => Date.parse(`${day}T00:00:00Z`);
const iso = (at: number): string => new Date(at).toISOString().slice(0, 10);
const DAY_MS = 86_400_000;

export interface GanttScale {
  /** The first day of the month the earliest bar starts in. */
  from: string;
  /** The last day of the month the latest bar ends in. */
  to: string;
  days: number;
  months: { key: string; month: number; year: number; offset: number; days: number }[];
  /** The Mondays of the window, as the offset of each in days from `from`. */
  weeks: { day: string; offset: number }[];
}

/** The time axis of the chart: whole months around every bar (current and baseline); null when no task has a date. */
export function ganttScale(rows: readonly GanttRow[]): GanttScale | null {
  const days = rows.flatMap((row) => [row.actual?.from, row.actual?.to, row.baseline?.from, row.baseline?.to].filter((day): day is string => day !== undefined));
  if (days.length === 0) return null;
  const sorted = [...days].sort();
  const first = sorted[0] as string;
  const last = sorted[sorted.length - 1] as string;
  const from = `${first.slice(0, 7)}-01`;
  const lastYear = Number(last.slice(0, 4));
  const lastMonth = Number(last.slice(5, 7));
  const to = iso(Date.UTC(lastYear, lastMonth, 0));
  const total = Math.round((utc(to) - utc(from)) / DAY_MS) + 1;
  const months: GanttScale['months'] = [];
  let year = Number(from.slice(0, 4));
  let month = Number(from.slice(5, 7));
  while (year < lastYear || (year === lastYear && month <= lastMonth)) {
    const start = Date.UTC(year, month - 1, 1);
    months.push({ key: `${year}-${String(month).padStart(2, '0')}`, month, year, offset: Math.round((start - utc(from)) / DAY_MS), days: new Date(Date.UTC(year, month, 0)).getUTCDate() });
    if (month === 12) {
      month = 1;
      year += 1;
    } else month += 1;
  }
  const weeks: GanttScale['weeks'] = [];
  for (let at = utc(from); at <= utc(to); at += DAY_MS) if (new Date(at).getUTCDay() === 1) weeks.push({ day: iso(at), offset: Math.round((at - utc(from)) / DAY_MS) });
  return { from, to, days: total, months, weeks };
}

/** Where a day sits on the axis, as a share of its width (0 to 100); a day outside the window is null. `end` puts the mark at the end of the day (the right edge of a bar). */
export function ganttAt(scale: GanttScale, day: string, end = false): number | null {
  const offset = Math.round((utc(day) - utc(scale.from)) / DAY_MS);
  if (Number.isNaN(offset) || offset < 0 || offset >= scale.days) return null;
  return ((offset + (end ? 1 : 0)) / scale.days) * 100;
}

/** The pixels a day takes on the axis: wide enough to read a short schedule, narrow enough that a schedule of years still scrolls in a few screens. */
export const ganttDayWidth = (days: number): number => Math.min(14, Math.max(3, Math.round((960 / days) * 10) / 10));

/** The rows of the chart under the phase each belongs to, phases in their order; a task of a phase the workflow does not list comes last under its code. */
export function ganttGroups(rows: readonly GanttRow[], phases: readonly WorkflowPhase[]): { code: string; name: string; rows: GanttRow[] }[] {
  const ordered = [...phases].sort((a, b) => a.order - b.order);
  const known = new Set(ordered.map((phase) => phase.code));
  const strays = [...new Set(rows.filter((row) => !known.has(row.phase)).map((row) => row.phase))];
  return [...ordered.map((phase) => ({ code: phase.code, name: phase.name })), ...strays.map((code) => ({ code, name: code }))].map((phase) => ({ ...phase, rows: rows.filter((row) => row.phase === phase.code) })).filter((group) => group.rows.length > 0);
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

export interface MilestoneRow {
  id: string;
  code: string;
  name: string;
  phase: string;
  /** The planned day; null when it cannot be counted (the calendar of its year is missing). */
  day: string | null;
  task: WorkflowTask;
}

/** The milestones of the plan in the order of their dates; one that has no date comes last (the screen says why: missing calendar). */
export function milestoneRows(detail: WorkflowDetail): MilestoneRow[] {
  return detail.tasks
    .filter((task) => task.kind === 'MILESTONE' && !task.excluded)
    .map((task): MilestoneRow => ({ id: task.id, code: task.task_code, name: task.name, phase: task.phase_code, day: task.planned_finish, task }))
    .sort((a, b) => (a.day === b.day ? a.code.localeCompare(b.code) : a.day === null ? 1 : b.day === null ? -1 : a.day < b.day ? -1 : 1));
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
