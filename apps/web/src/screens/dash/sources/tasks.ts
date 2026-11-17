import type { TaskRow } from '../db';
import { plainText } from './assemble';

/**
 * The tasks bundle of the dashboard (the directives of the steering meetings and the tasks of the project workflows) from what the system holds. Nothing here asks the
 * server: `system-tasks.ts` reads, this file turns what was read into the rows.
 *
 * The charts of the template draw the groups by name (viz.js lists three kinds of meeting and five phases, and leaves any other name out), so the meeting types and
 * the phases of the system are written with the names of the template.
 */
export interface SystemDirective {
  code: string; text: string;
  /** The status a reader sees: OPEN, IN_PROGRESS, DONE, OVERDUE or CANCELLED. */
  status: string;
  unit_code: string | null; project_code: string | null; meeting_id: string | null; meeting_code: string | null;
  due_on: string | null; closed_at: string | null; overdue_days: number | null;
}
export interface SystemMeeting { id: string; meeting_type: string }
export interface SystemProjectTask {
  project_id: string; task_code: string; name: string; phase_code: string; kind: string;
  /** NOT_STARTED, IN_PROGRESS, AWAITING_APPROVAL, DONE, ON_HOLD or CANCELLED. */
  status: string;
  excluded: boolean; tracked: boolean; planned_finish: string | null;
  /** Working days past the deadline, as the system counts them; 0 when the task is not overdue. */
  late_days: number;
  receiving_unit_id: string | null;
  /** The day the task was finished: read from the task in full, for a finished task only. */
  actual_finish: string | null;
}
export interface SystemTaskProject { id: string; code: string; investor_unit_id: string | null }
export interface SystemTaskUnit { id: string; code: string }
export interface SystemPhase { code: string; name: string }

/** What `system-tasks.ts` reads. */
export interface TasksRead {
  /** The day the screen is read (ISO). */
  today: string;
  directives: readonly SystemDirective[];
  meetings: readonly SystemMeeting[];
  tasks: readonly SystemProjectTask[];
  projects: readonly SystemTaskProject[];
  units: readonly SystemTaskUnit[];
  /** The phases of the workflow of each project, by project id. */
  phases: Readonly<Record<string, readonly SystemPhase[]>>;
}
export interface TasksInput extends TasksRead {
  /** The codes of the units and of the projects of the capital tables in use, as the tables write them (`plainText`): a row that names another one is left out. */
  knownUnitCodes: ReadonlySet<string>;
  knownProjectCodes: ReadonlySet<string>;
}
export interface TasksResult {
  /** The rows, when the system holds enough to draw every page that reads them. */
  rows?: TaskRow[];
  /** Why the bundle stays on the template. Empty when `rows` is given. */
  reasons: string[];
}

/** What the bundle needs before it replaces the template's: fewer would leave the pages of tasks (the groups, the tree by unit, the weekly rhythm) with a few marks or none. */
export const TASKS_FLOOR = { directives: 20, projectTasks: 100, projectsWithTasks: 5, finishedWithDay: 20 } as const;

export const DIRECTIVE = 'Chỉ đạo';
export const PROJECT_TASK = 'Quy trình dự án';
/** The kinds of meeting the template draws. A meeting called outside the calendar is one the steering committee calls itself: its directives stand under 'Ban chỉ đạo'. */
const REGULAR_MEETING = 'Giao ban tháng';
const TOPIC_MEETING = 'Họp chuyên đề';
const COMMITTEE_MEETING = 'Ban chỉ đạo';
const MEETING_GROUP: Readonly<Record<string, string>> = {
  WEEKLY: REGULAR_MEETING, MONTHLY: REGULAR_MEETING, QUARTERLY: REGULAR_MEETING, EXTRAORDINARY: COMMITTEE_MEETING, SITE_VISIT: TOPIC_MEETING, OTHER: TOPIC_MEETING,
};
/** The five phases the template draws, and the phase of the standard workflows of the system each one stands for. */
const PHASE_GROUP: Readonly<Record<string, string>> = {
  PREPARATION: 'Chuẩn bị đầu tư', FEASIBILITY: 'Đánh giá khả thi', APPROVAL: 'Chuẩn bị thực hiện', IMPLEMENTATION: 'Thi công', ACCEPTANCE: 'Nghiệm thu, quyết toán', SETTLEMENT: 'Nghiệm thu, quyết toán',
};

/** The group of a directive: the kind of meeting it was given at; a meeting of a type the template has no name for, or one that is not known, is a topic meeting. */
export function meetingGroup(meetingType: string | undefined): string {
  return MEETING_GROUP[meetingType ?? ''] ?? TOPIC_MEETING;
}

/** The engine joins the kind and the group with a bar and splits them again: a group never holds one. */
const groupName = (value: string): string => plainText(value).replace(/\|/g, '/');

/** The group of a project task: its phase under the name of the template; a phase of a workflow of the tenant's own keeps its name (the chart by group does not draw it, the other pages count it). */
export function phaseGroup(phaseCode: string, phases: readonly SystemPhase[] | undefined): string {
  const known = PHASE_GROUP[phaseCode];
  if (known !== undefined) return known;
  const name = phases?.find((phase) => phase.code === phaseCode)?.name;
  return groupName(name ?? phaseCode);
}

/** A calendar day (2026-11-17) out of a day or a moment; anything that is not a day that exists is absent. */
export function dayOf(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const day = value.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const moment = Date.parse(`${day}T00:00:00Z`);
  // The parser rolls 30 February over into March: a day is one that reads back the same.
  return Number.isNaN(moment) || new Date(moment).toISOString().slice(0, 10) !== day ? null : day;
}

const daysBetween = (from: string, to: string): number => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
const whole = (value: number | null): number => (value === null || !Number.isFinite(value) ? 0 : Math.max(0, Math.round(value)));

/** The status of a directive as the engine reads it. It tells an overdue directive by its deadline, so OVERDUE is an open one. */
export function directiveStatus(status: string): string {
  return status === 'DONE' ? 'DONE' : status === 'CANCELLED' ? 'CANCELLED' : 'OPEN';
}

/** The status of a project task as the engine reads it: a task left out of the project, or one that is not tracked, is not counted in the completion rate. */
export function taskStatus(task: Pick<SystemProjectTask, 'status' | 'excluded' | 'tracked'>): string {
  if (task.excluded) return 'NOT_TRACKED';
  if (task.status === 'DONE' || task.status === 'CANCELLED') return task.status;
  if (!task.tracked) return 'NOT_TRACKED';
  return task.status === 'ON_HOLD' ? 'PAUSED' : 'OPEN';
}

/** The day a row was finished and how many days after its deadline that was. A day that has not come yet is not a completion day. */
function finish(status: string, finishedOn: string | null, deadline: string | null, today: string): { ngay_xong: string | null; late: number | null } {
  const day = status === 'DONE' ? dayOf(finishedOn) : null;
  if (day === null || day > today) return { ngay_xong: null, late: null };
  return { ngay_xong: day, late: deadline === null ? 0 : Math.max(0, daysBetween(deadline, day)) };
}

/** The tasks bundle from the system, or the reasons the system does not hold enough for it. */
export function tasksFromSystem(input: TasksInput): TasksResult {
  const rows: TaskRow[] = [];
  const today = dayOf(input.today) ?? '9999-12-31';

  const typeOfMeeting = new Map(input.meetings.map((meeting) => [meeting.id, meeting.meeting_type]));
  let directives = 0;
  for (const directive of input.directives) {
    // The pages by document group the directives by the meeting they were given at: a directive without one, or one of a unit or a project the tables do not have, is left out.
    const unit = directive.unit_code === null ? null : plainText(directive.unit_code);
    const project = directive.project_code === null ? null : plainText(directive.project_code);
    if (unit === null || !input.knownUnitCodes.has(unit) || directive.meeting_code === null) continue;
    if (project !== null && !input.knownProjectCodes.has(project)) continue;
    const status = directiveStatus(directive.status);
    const han = dayOf(directive.due_on);
    const done = finish(status, directive.closed_at, han, today);
    const meeting = plainText(directive.meeting_code);
    rows.push({
      ma: plainText(directive.code), loai: DIRECTIVE, nhom: meetingGroup(directive.meeting_id === null ? undefined : typeOfMeeting.get(directive.meeting_id)), noi_dung: plainText(directive.text),
      du_an: project, don_vi: unit, la_moc: 0, cho_duyet: 0, han, ngay_xong: done.ngay_xong,
      ngay_tre: done.late ?? (status === 'OPEN' ? whole(directive.overdue_days) : 0), trang_thai: status, cuoc_hop: meeting, van_ban: meeting,
    });
    directives += 1;
  }

  const projectById = new Map(input.projects.map((project) => [project.id, project]));
  const unitCodeById = new Map(input.units.map((unit) => [unit.id, plainText(unit.code)]));
  const projectsWithTasks = new Set<string>();
  let projectTasks = 0;
  for (const task of input.tasks) {
    const project = projectById.get(task.project_id);
    if (project === undefined) continue;
    const projectCode = plainText(project.code);
    if (!input.knownProjectCodes.has(projectCode)) continue;
    // The unit that receives the task; when the system does not know it, the investor of the project.
    const unit = (task.receiving_unit_id === null ? undefined : unitCodeById.get(task.receiving_unit_id)) ?? (project.investor_unit_id === null ? undefined : unitCodeById.get(project.investor_unit_id));
    if (unit === undefined || !input.knownUnitCodes.has(unit)) continue;
    const status = taskStatus(task);
    const han = dayOf(task.planned_finish);
    const done = finish(status, task.actual_finish, han, today);
    rows.push({
      ma: plainText(`${project.code}/${task.task_code}`), loai: PROJECT_TASK, nhom: phaseGroup(task.phase_code, input.phases[task.project_id]), noi_dung: plainText(task.name),
      du_an: projectCode, don_vi: unit, la_moc: task.kind === 'MILESTONE' ? 1 : 0, cho_duyet: status === 'OPEN' && task.status === 'AWAITING_APPROVAL' ? 1 : 0, han, ngay_xong: done.ngay_xong,
      ngay_tre: done.late ?? (status === 'OPEN' ? whole(task.late_days) : 0), trang_thai: status, cuoc_hop: null, van_ban: null,
    });
    projectTasks += 1;
    projectsWithTasks.add(projectCode);
  }

  const finished = rows.filter((row) => row.ngay_xong !== null).length;
  const reasons: string[] = [];
  if (directives < TASKS_FLOOR.directives) reasons.push(`${directives} directives name a unit of the tables (at least ${TASKS_FLOOR.directives} are needed)`);
  if (projectTasks < TASKS_FLOOR.projectTasks) reasons.push(`${projectTasks} project tasks name a unit and a project of the tables (at least ${TASKS_FLOOR.projectTasks} are needed)`);
  if (projectsWithTasks.size < TASKS_FLOOR.projectsWithTasks) reasons.push(`${projectsWithTasks.size} projects run a workflow (at least ${TASKS_FLOOR.projectsWithTasks} are needed)`);
  if (finished < TASKS_FLOOR.finishedWithDay) reasons.push(`${finished} finished rows carry the day they were finished (at least ${TASKS_FLOOR.finishedWithDay} are needed for the weekly rhythm)`);
  return reasons.length > 0 ? { reasons } : { rows, reasons: [] };
}
