import { DomainError, canonicalJson, sha256Hex } from '@machvon/kernel';
import type { pwfSchedule, pwfWorkflow } from '@machvon/kernel';
import { WORK_CALENDAR_CODE } from './home-work-clock-store.ts';
import type { TenantTx } from './tenant-database.ts';

/**
 * What the commands of the workflow of a project share (PWF-1, PWF-2): the calendars pinned by version, the rows of the tasks and their links as the pure scheduler takes them, the persistence of a computed schedule, and
 * the hashes that make a published schedule reproducible (R32). Nothing here decides who may do what; the stores do.
 */

/** A project longer than this many years has more calendar than anyone publishes: the scan stops there and the tasks beyond say CALENDAR_UNAVAILABLE (never a guessed day). */
export const MAX_CALENDAR_YEARS = 12;

export type TaskStatus = 'NOT_STARTED' | 'IN_PROGRESS' | 'AWAITING_APPROVAL' | 'DONE' | 'ON_HOLD' | 'CANCELLED';
export type PinnedCalendar = pwfSchedule.PinnedCalendar;
export interface CalendarPin {
  year: number;
  version: number;
}

interface CalendarSql {
  year: number;
  revision: number;
  working_days: number[];
  holidays: Array<{ date: string; name?: string }>;
  compensated_workdays: string[] | null;
  legal_basis_ref: string;
}

const CALENDAR_COLUMNS = 'year, revision, working_days, holidays, compensated_workdays, legal_basis_ref';

const toPinned = (row: CalendarSql): PinnedCalendar => ({
  year: row.year,
  version: row.revision,
  content: { calendar_code: WORK_CALENDAR_CODE, year: row.year, working_days: row.working_days, holidays: row.holidays as never, compensated_workdays: row.compensated_workdays ?? [], legal_basis_ref: row.legal_basis_ref },
});

/** The published calendars of the years from `fromYear` on, consecutive (the line of working days joins year after year, so a gap ends the list). */
export async function pinPublishedCalendars(tx: TenantTx, fromYear: number): Promise<PinnedCalendar[]> {
  const rows = await tx.query<CalendarSql>(
    `select ${CALENDAR_COLUMNS} from machvon.work_calendar_version where calendar_code = $1 and status = 'Published' and year between $2::int and $3::int order by year`,
    [WORK_CALENDAR_CODE, fromYear, fromYear + MAX_CALENDAR_YEARS],
  );
  const pinned: PinnedCalendar[] = [];
  for (const row of rows) {
    if (row.year !== fromYear + pinned.length) break;
    pinned.push(toPinned(row));
  }
  return pinned;
}

/** The calendar versions a published schedule was computed on, whatever has been published since. */
export async function loadPinnedCalendars(tx: TenantTx, pins: readonly CalendarPin[]): Promise<PinnedCalendar[]> {
  if (pins.length === 0) return [];
  const rows = await tx.query<CalendarSql>(
    `select ${CALENDAR_COLUMNS} from machvon.work_calendar_version where calendar_code = $1 and (year, revision) in (select * from unnest($2::int[], $3::int[])) order by year`,
    [WORK_CALENDAR_CODE, pins.map((pin) => pin.year), pins.map((pin) => pin.version)],
  );
  return rows.map(toPinned);
}

export const pinsOf = (calendars: readonly PinnedCalendar[]): CalendarPin[] => calendars.map((one) => ({ year: one.year, version: one.version }));

// ---- the rows of the tasks ---------------------------------------------------------------------------------------------------------------------------------------------------------------

export interface TaskRow {
  id: string;
  workflowId: string;
  projectId: string;
  code: string;
  name: string;
  phaseCode: string;
  sortOrder: number;
  kind: 'TASK' | 'MILESTONE';
  required: boolean;
  responsibleRole: string;
  approverRole: string | null;
  priority: 'LOW' | 'NORMAL' | 'HIGH' | 'CRITICAL';
  durationWorkingDays: number;
  ownTask: boolean;
  status: TaskStatus;
  excluded: boolean;
  tracked: boolean;
  state: 'SCHEDULED' | 'COMPLETED' | 'PASS_THROUGH' | 'CALENDAR_UNAVAILABLE';
  plannedStart: string | null;
  plannedFinish: string | null;
  baselineStart: string | null;
  baselineFinish: string | null;
  /** The days of the schedule last RELEASED by a decision (R49): the official deadline of the task is `committedFinish`; `plannedStart`/`plannedFinish` are the current computation (the forecast). */
  committedStart: string | null;
  committedFinish: string | null;
  lateStart: string | null;
  lateFinish: string | null;
  totalFloat: number | null;
  freeFloat: number | null;
  critical: boolean;
  drivingPredecessor: string | null;
  missingYear: number | null;
  constraintKind: string | null;
  constraintOffset: number | null;
  scheduleVersion: number;
  actualStart: string | null;
  actualFinish: string | null;
  remainingWorkingDays: number | null;
  percentComplete: number | null;
  returnCount: number;
  rescheduleCount: number;
  earlyStartReason: string | null;
  estimateVnd: string | null;
  actualVnd: string | null;
  completionRequestedBy: string | null;
  approvedBy: string | null;
  cancelledBy: string | null;
  milestoneId: string | null;
  version: number;
}

export interface TaskSql {
  id: string;
  workflow_id: string;
  project_id: string;
  task_code: string;
  name: string;
  phase_code: string;
  sort_order: number;
  kind: TaskRow['kind'];
  required: boolean;
  responsible_role: string;
  approver_role: string | null;
  priority: TaskRow['priority'];
  duration_working_days: number;
  own_task: boolean;
  status: TaskStatus;
  excluded: boolean;
  tracked: boolean;
  state: TaskRow['state'];
  planned_start: string | null;
  planned_finish: string | null;
  baseline_start: string | null;
  baseline_finish: string | null;
  committed_start: string | null;
  committed_finish: string | null;
  late_start: string | null;
  late_finish: string | null;
  total_float: number | null;
  free_float: number | null;
  critical: boolean;
  driving_predecessor: string | null;
  missing_year: number | null;
  constraint_kind: string | null;
  constraint_offset: number | null;
  schedule_version: number;
  actual_start: string | null;
  actual_finish: string | null;
  remaining_working_days: number | null;
  percent_complete: number | null;
  return_count: number;
  reschedule_count: number;
  early_start_reason: string | null;
  estimate_vnd: string | null;
  actual_vnd: string | null;
  completion_requested_by: string | null;
  approved_by: string | null;
  cancelled_by: string | null;
  milestone_id: string | null;
  version: number;
}

/** The columns of a task as `toTaskRow` reads them, for the alias `t`. */
export const TASK_COLUMNS = `t.id, t.workflow_id, t.project_id, t.task_code, t.name, t.phase_code, t.sort_order, t.kind, t.required, t.responsible_role, t.approver_role, t.priority, t.duration_working_days, t.own_task, t.status,
  t.excluded, t.tracked, t.state, t.planned_start::text as planned_start, t.planned_finish::text as planned_finish, t.baseline_start::text as baseline_start, t.baseline_finish::text as baseline_finish,
  t.committed_start::text as committed_start, t.committed_finish::text as committed_finish,
  t.late_start::text as late_start, t.late_finish::text as late_finish, t.total_float, t.free_float, t.critical, t.driving_predecessor, t.missing_year, t.constraint_kind, t.constraint_offset, t.schedule_version,
  t.actual_start::text as actual_start, t.actual_finish::text as actual_finish, t.remaining_working_days, t.percent_complete, t.return_count, t.reschedule_count, t.early_start_reason,
  t.estimate_vnd::text as estimate_vnd, t.actual_vnd::text as actual_vnd, t.completion_requested_by, t.approved_by, t.cancelled_by, t.milestone_id, t.version`;

export const toTaskRow = (row: TaskSql): TaskRow => ({
  id: row.id,
  workflowId: row.workflow_id,
  projectId: row.project_id,
  code: row.task_code,
  name: row.name,
  phaseCode: row.phase_code,
  sortOrder: row.sort_order,
  kind: row.kind,
  required: row.required,
  responsibleRole: row.responsible_role,
  approverRole: row.approver_role,
  priority: row.priority,
  durationWorkingDays: row.duration_working_days,
  ownTask: row.own_task,
  status: row.status,
  excluded: row.excluded,
  tracked: row.tracked,
  state: row.state,
  plannedStart: row.planned_start,
  plannedFinish: row.planned_finish,
  baselineStart: row.baseline_start,
  baselineFinish: row.baseline_finish,
  committedStart: row.committed_start,
  committedFinish: row.committed_finish,
  lateStart: row.late_start,
  lateFinish: row.late_finish,
  totalFloat: row.total_float,
  freeFloat: row.free_float,
  critical: row.critical,
  drivingPredecessor: row.driving_predecessor,
  missingYear: row.missing_year,
  constraintKind: row.constraint_kind,
  constraintOffset: row.constraint_offset,
  scheduleVersion: row.schedule_version,
  actualStart: row.actual_start,
  actualFinish: row.actual_finish,
  remainingWorkingDays: row.remaining_working_days,
  percentComplete: row.percent_complete,
  returnCount: row.return_count,
  rescheduleCount: row.reschedule_count,
  earlyStartReason: row.early_start_reason,
  estimateVnd: row.estimate_vnd,
  actualVnd: row.actual_vnd,
  completionRequestedBy: row.completion_requested_by,
  approvedBy: row.approved_by,
  cancelledBy: row.cancelled_by,
  milestoneId: row.milestone_id,
  version: Number(row.version),
});

export async function loadTasks(tx: TenantTx, workflowId: string): Promise<TaskRow[]> {
  const rows = await tx.query<TaskSql>(`select ${TASK_COLUMNS} from machvon.project_task t where t.workflow_id = $1::uuid order by t.sort_order, t.task_code`, [workflowId]);
  return rows.map(toTaskRow);
}

export interface TaskLink {
  taskId: string;
  predecessorId: string;
  predecessor: string;
  kind: 'FS' | 'SS' | 'FF' | 'SF';
  lagWorkingDays: number;
}

export async function loadLinks(tx: TenantTx, workflowId: string): Promise<TaskLink[]> {
  const rows = await tx.query<{ task_id: string; predecessor_id: string; predecessor: string; kind: TaskLink['kind']; lag_working_days: number }>(
    `select d.task_id, d.predecessor_id, p.task_code as predecessor, d.kind, d.lag_working_days
       from machvon.project_task_dependency d join machvon.project_task p on p.tenant_id = d.tenant_id and p.id = d.predecessor_id
      where d.workflow_id = $1::uuid order by p.task_code, d.kind`,
    [workflowId],
  );
  return rows.map((row) => ({ taskId: row.task_id, predecessorId: row.predecessor_id, predecessor: row.predecessor, kind: row.kind, lagWorkingDays: row.lag_working_days }));
}

const SCHEDULE_STATUS: Readonly<Record<TaskStatus, pwfSchedule.TaskStatus>> = {
  NOT_STARTED: 'NOT_STARTED',
  IN_PROGRESS: 'IN_PROGRESS',
  AWAITING_APPROVAL: 'IN_PROGRESS',
  ON_HOLD: 'IN_PROGRESS',
  DONE: 'DONE',
  CANCELLED: 'CANCELLED',
};

/** What a stored task is to the scheduler: a task awaiting approval or on hold is still being worked on; a cancelled task or a branch left out is a node of zero length. */
export function scheduleTasksOf(rows: readonly TaskRow[], links: readonly TaskLink[]): pwfSchedule.ScheduleTask[] {
  const byTask = new Map<string, TaskLink[]>();
  for (const link of links) byTask.set(link.taskId, [...(byTask.get(link.taskId) ?? []), link]);
  return rows.map((row): pwfSchedule.ScheduleTask => {
    const awaiting = row.status === 'AWAITING_APPROVAL';
    return {
      code: row.code,
      kind: row.kind,
      durationWorkingDays: row.durationWorkingDays,
      predecessors: (byTask.get(row.id) ?? []).map((link) => ({ task: link.predecessor, kind: link.kind, lagWorkingDays: link.lagWorkingDays })),
      ...(row.constraintKind === null ? {} : { constraint: { kind: row.constraintKind, offsetWorkingDays: row.constraintOffset ?? 0 } as pwfSchedule.ScheduleConstraint }),
      status: SCHEDULE_STATUS[row.status],
      ...(row.excluded ? { excluded: true } : {}),
      actualStart: row.actualStart,
      actualFinish: row.actualFinish,
      remainingWorkingDays: awaiting ? 0 : row.remainingWorkingDays,
      percentComplete: row.percentComplete,
    };
  });
}

export const baselineOfRows = (rows: readonly TaskRow[]): pwfSchedule.ScheduleBaseline => {
  const baseline: pwfSchedule.ScheduleBaseline = {};
  for (const row of rows) if (row.baselineStart !== null && row.baselineFinish !== null) baseline[row.code] = { start: row.baselineStart, finish: row.baselineFinish };
  return baseline;
};

/** The official deadline of a task (R49): its finish in the schedule last released by a decision; a task that was never dated has none. */
export const dueOf = (row: Pick<TaskRow, 'committedFinish' | 'plannedFinish'>): string | null => row.committedFinish ?? row.plannedFinish;
/** The official start of a task: its start in the schedule last released by a decision. */
export const dueStartOf = (row: Pick<TaskRow, 'committedStart' | 'plannedStart'>): string | null => row.committedStart ?? row.plannedStart;

/**
 * The schedule in force as the pure functions of reschedule take it: rebuilt from the stored days, so a preview is measured against what people see, not against a recomputation. `days` says which days: the current computation
 * (`FORECAST`, what a recomputation from progress is compared with) or the days last released by a decision (`COMMITTED`, what a proposal to move the schedule is compared with: it asks to move the official days, R49).
 */
export function resultOfRows(rows: readonly TaskRow[], days: 'FORECAST' | 'COMMITTED' = 'FORECAST'): pwfSchedule.ScheduleResult {
  const committed = days === 'COMMITTED';
  return {
    tasks: rows.map((row) => ({
      code: row.code,
      kind: row.kind,
      state: row.state,
      start: committed ? dueStartOf(row) : row.plannedStart,
      finish: committed ? dueOf(row) : row.plannedFinish,
      lateStart: row.lateStart,
      lateFinish: row.lateFinish,
      startSlot: 0,
      endSlot: 0,
      totalFloat: row.totalFloat,
      freeFloat: row.freeFloat,
      critical: row.critical,
      drivingPredecessor: row.drivingPredecessor,
      findings: [],
      missingYear: row.missingYear,
      startVarianceDays: null,
      finishVarianceDays: null,
    })),
    projectStart: null,
    projectFinish: null,
    criticalPath: [],
    longestPath: [],
    calendarVersions: [],
    findings: [],
    hash: '',
  };
}

/** The hash of what a schedule was computed from: the same tasks, start, status day and calendar versions give the same hash (R32). */
export function inputHashOf(input: { tasks: readonly pwfSchedule.ScheduleTask[]; plannedStart: string; statusDate?: string | null; calendars: readonly PinnedCalendar[] }): string {
  return sha256Hex(canonicalJson({ tasks: input.tasks, plannedStart: input.plannedStart, statusDate: input.statusDate ?? null, calendars: pinsOf(input.calendars) }));
}

/** The calendar pins stored on a workflow, read back as typed values. */
export function pinsFromJson(value: unknown): CalendarPin[] {
  if (!Array.isArray(value)) throw new DomainError('PWF_SCHEDULE_INVALID', 422, 'calendar_pins');
  return value.map((entry) => ({ year: Number((entry as CalendarPin).year), version: Number((entry as CalendarPin).version) }));
}

/**
 * Writes the days of a computed schedule on the tasks in one statement, whatever the number of tasks. `baseline: true` sets the first baseline of the tasks that have none yet (it is never changed afterwards). `release: true`
 * (the first schedule, an adoption, an approved reschedule) also writes the COMMITTED days of the tasks that are not over: the official deadline moves only then (R49). A recomputation from progress (`release: false`) writes the
 * forecast alone; a task that had no day at all takes its first days as committed ones either way (there was nothing to keep). The database refuses any other move of a committed day (`pwf.release`).
 */
export async function writeScheduleDays(tx: TenantTx, workflowId: string, result: pwfSchedule.ScheduleResult, scheduleVersion: number, baseline: boolean, release = false): Promise<void> {
  const payload = result.tasks.map((task) => ({
    code: task.code,
    state: task.state,
    start: task.start,
    finish: task.finish,
    late_start: task.lateStart,
    late_finish: task.lateFinish,
    total_float: task.totalFloat,
    free_float: task.freeFloat,
    critical: task.critical,
    driving: task.drivingPredecessor,
    missing_year: task.missingYear,
  }));
  // The committed days are written for a task that is not over when a schedule is released, and for a task that has none yet.
  const commits = `(($5::boolean and t.status not in ('DONE', 'CANCELLED')) or t.committed_finish is null)`;
  if (release) await tx.query("select set_config('pwf.release', 'on', true)");
  try {
    await tx.query(
      `update machvon.project_task t
          set state = x.state, planned_start = x.start, planned_finish = x.finish, late_start = x.late_start, late_finish = x.late_finish, total_float = x.total_float, free_float = x.free_float,
              critical = x.critical, driving_predecessor = x.driving, missing_year = x.missing_year, schedule_version = $2::int,
              baseline_start = case when $3::boolean and t.baseline_start is null then x.start else t.baseline_start end,
              baseline_finish = case when $3::boolean and t.baseline_finish is null then x.finish else t.baseline_finish end,
              committed_start = case when ${commits} then x.start else t.committed_start end,
              committed_finish = case when ${commits} then x.finish else t.committed_finish end,
              updated_at = now(), version = t.version + 1
         from jsonb_to_recordset($4::jsonb) as x(code text, state text, start date, finish date, late_start date, late_finish date, total_float int, free_float int, critical boolean, driving text, missing_year int)
        where t.workflow_id = $1::uuid and t.task_code = x.code
          and ((t.state, t.planned_start, t.planned_finish, t.late_start, t.late_finish, t.total_float, t.free_float, t.critical, t.driving_predecessor, t.missing_year)
               is distinct from (x.state, x.start, x.finish, x.late_start, x.late_finish, x.total_float, x.free_float, x.critical, x.driving, x.missing_year)
               or ($3::boolean and t.baseline_start is null and x.start is not null)
               or (${commits} and (t.committed_start, t.committed_finish) is distinct from (x.start, x.finish)))`,
      [workflowId, scheduleVersion, baseline, JSON.stringify(payload), release],
    );
  } finally {
    if (release) await tx.query("select set_config('pwf.release', 'off', true)");
  }
}

/** The first calendar year a schedule reaches: the line of working days starts at the earliest day it mentions (the planned start, the day of the status, the first baseline, the real dates), so the calendars are pinned from that year (a year without a calendar is never guessed). */
export function earliestYear(days: ReadonlyArray<string | null | undefined>): number {
  const years = days.filter((day): day is string => typeof day === 'string').map((day) => Number(day.slice(0, 4)));
  if (years.length === 0) throw new DomainError('PWF_SCHEDULE_INVALID', 422, 'planned_start');
  return Math.min(...years);
}

/** What a task of the project's own (added by an approved override, never in the frozen template) asks of its completion: nothing but being done and, when its role says so, approved. */
export function ownTaskDefinition(row: TaskRow): pwfWorkflow.TemplateTask {
  return {
    code: row.code,
    name: row.name,
    phase: row.phaseCode,
    kind: row.kind,
    durationWorkingDays: row.durationWorkingDays,
    required: row.required,
    responsibleRole: row.responsibleRole,
    approverRole: row.approverRole,
    priority: row.priority,
    predecessors: [],
    constraint: null,
    legalDocTypes: [],
    formTemplates: [],
    checklist: [],
    kpiCodes: [],
    when: [],
  };
}

/** The reason of the line that the workflow writes for the leader in charge when it starts: such a line is handed over by the next assignment of the role (the ledger closes its open period, it never edits it). */
export const DEFAULT_ASSIGNMENT_REASON = 'Default: the leader in charge of the project';
