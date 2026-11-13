import { ApiError } from '@machvon/api-client';
import type { components } from '@machvon/contracts';
import type { Tone } from '../../ui';

type Schemas = components['schemas'];

// ---- the shapes of the contract (generated; the screens never describe a shape a second time) -----------------------------------------------------------------------------

export type TemplateParams = Schemas['PwfTemplateParams'];
export type TemplateTask = TemplateParams['tasks'][number];
export type TemplatePhase = TemplateParams['phases'][number];
export type TemplateValidation = Schemas['PwfTemplateValidation'];
export type SchedulePreview = Schemas['PwfSchedulePreview'];
export type ScheduleTask = SchedulePreview['tasks'][number];
export type Schedule = Schemas['PwfSchedule'];
export type WorkflowDetail = Schemas['PwfWorkflowDetail'];
export type WorkflowTask = WorkflowDetail['tasks'][number];
export type WorkflowPhase = WorkflowDetail['phases'][number];
export type TaskPage = Schemas['PwfTaskPage'];
export type GateAssessment = Schemas['PwfGateAssessment'];
export type TaskDetail = Schemas['PwfTaskDetail'];
export type AssignmentPage = Schemas['PwfAssignmentPage'];
export type Assignment = AssignmentPage['items'][number];
export type AdoptResult = Schemas['PwfAdoptResult'];
export type ReschedulePreview = Schemas['PwfReschedulePreview'];
export type DeadlineBoard = Schemas['PwfDeadlineBoard'];
export type DeadlineCalendar = Schemas['PwfDeadlineCalendar'];
export type MilestoneList = Schemas['PwfMilestoneList'];
export type Workload = Schemas['PwfWorkload'];
export type BandPreview = Schemas['PwfBandPreview'];
export type TaskBand = WorkflowTask['band'];

export type Band = TaskBand['band'];
export type BandUnit = TaskBand['unit'];
export type TaskStatus = WorkflowTask['status'];
export type TaskKind = WorkflowTask['kind'];
export type Priority = WorkflowTask['priority'];
export type GateTarget = GateAssessment['target'];
export type DependencyKind = TemplateTask['predecessors'][number]['kind'];
export type ExceptionKind = TaskDetail['exceptions'][number]['kind'];
export type AssignmentRole = Assignment['role'];
export type BlockerCode = TaskDetail['completion']['blockers'][number]['code'];
export type Blocker = TaskDetail['completion']['blockers'][number];
export type ProjectFacts = NonNullable<Schemas['PwfWorkflowStart']['facts']>;

// ---- permissions (the same names as the contract) -----------------------------------------------------------------------------------------------------------------------

export const PERMISSIONS = {
  read: 'pwf.read',
  templateManage: 'pwf.template.manage',
  workflowManage: 'pwf.workflow.manage',
  workflowAdopt: 'pwf.workflow.adopt',
  taskWork: 'pwf.task.work',
  taskApprove: 'pwf.task.approve',
  taskAssign: 'pwf.task.assign',
  schedulePropose: 'pwf.schedule.propose',
  scheduleApprove: 'pwf.schedule.approve',
  preferenceOwn: 'pwf.preference.own',
} as const;
export type PwfPermission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

/** The rule store (governance) permissions the template and band policy editors write with: maker and checker are different people. */
export const RULE_PERMISSIONS = { read: 'adm.governance.read', manage: 'adm.governance.manage', approve: 'adm.governance.approve' } as const;

/** The rule types the editors write into the governance rule store. */
export const TEMPLATE_RULE_TYPE = 'PROJECT_WORKFLOW_TEMPLATE';
export const BAND_RULE_TYPE = 'DEADLINE_BAND_POLICY';

/** Holds a permission, or the session does not say what is held (the server decides then); a frozen (read-only) session holds none that writes. */
export const holds = (permissions: readonly string[] | undefined, permission: PwfPermission, frozen = false): boolean => !frozen && (permissions === undefined || permissions.includes(permission));

// ---- limits the contract states ----------------------------------------------------------------------------------------------------------------------------------------

/** A reason for an exception, a pause, a cancellation, a return or a decision is at least this long once trimmed (PWF.md, F5). */
export const MIN_REASON = 20;
export const MAX_REASON = 2000;
export const MAX_TEMPLATE_TASKS = 400;
export const MAX_TEMPLATE_PHASES = 12;
export const MAX_PREDECESSORS = 20;

// ---- the routes of the module and the links between them ------------------------------------------------------------------------------------------------------------

export const PATHS = {
  library: '/pwf/pwf-01',
  editor: '/pwf/pwf-02',
  workflow: '/pwf/pwf-03',
  task: '/pwf/pwf-04',
  start: '/pwf/pwf-05',
  reschedule: '/pwf/pwf-06',
  board: '/pwf/pwf-07',
  bandPolicy: '/pwf/pwf-08',
  assignments: '/pwf/pwf-16',
  preference: '/pwf/pwf-15',
  project: '/prj/prj-03',
  ruleDiff: '/adm/adm-22',
  ruleDraft: '/adm/adm-21',
} as const;

const query = (params: Record<string, string | undefined>): string => {
  const pairs = Object.entries(params).flatMap(([name, value]) => (value === undefined || value === '' ? [] : [`${name}=${encodeURIComponent(value)}`]));
  return pairs.length === 0 ? '' : `?${pairs.join('&')}`;
};

/** The workflow of a project is a tab of PRJ-03 (`?tab=workflow`). */
export const workflowLink = (projectId: string): string => `${PATHS.project}${query({ id: projectId, tab: 'workflow' })}`;
export const taskLink = (taskId: string, projectId?: string): string => `${PATHS.task}${query({ id: taskId, project: projectId })}`;
export const startLink = (projectId: string): string => `${PATHS.start}${query({ id: projectId })}`;
export const rescheduleLink = (projectId: string, proposalId?: string): string => `${PATHS.reschedule}${query({ id: projectId, proposal: proposalId })}`;
export const assignmentsLink = (taskId: string): string => `${PATHS.assignments}${query({ id: taskId })}`;
export const editorLink = (code?: string, from?: string): string => `${PATHS.editor}${query({ code, from })}`;

// ---- the three colours --------------------------------------------------------------------------------------------------------------------------------------------------

export const BANDS: readonly Band[] = ['RED', 'YELLOW', 'GREEN', 'NONE', 'UNKNOWN'];

/** The tone of a band; the colour is never the only cue (see `BandBadge`: icon and words go with it). */
export function bandTone(band: Band): Tone {
  switch (band) {
    case 'RED':
      return 'danger';
    case 'YELLOW':
      return 'warning';
    case 'GREEN':
      return 'success';
    case 'NONE':
    case 'UNKNOWN':
      return 'neutral';
  }
}

/** The glyph that goes with the colour (a second cue next to the words). */
export function bandIcon(band: Band): string {
  switch (band) {
    case 'RED':
      return '⛔';
    case 'YELLOW':
      return '⚠';
    case 'GREEN':
      return '✓';
    case 'NONE':
      return '○';
    case 'UNKNOWN':
      return '?';
  }
}

/** A task that has no colour (done, cancelled, left out of the schedule) never carries a band. */
export const hasBand = (task: Pick<WorkflowTask, 'status' | 'excluded' | 'tracked'>): boolean => task.status !== 'DONE' && task.status !== 'CANCELLED' && !task.excluded && task.tracked;

/** The deadline of a task cannot be counted because the working calendar of a year is not published (BR-PWF-26): no date is guessed. */
export const calendarMissing = (task: Pick<WorkflowTask, 'state' | 'missing_year'>): boolean => task.state === 'CALENDAR_UNAVAILABLE' || task.missing_year !== null;

/** The years a schedule needs a calendar for and does not have, from its tasks, each once, ascending. */
export function missingYears(tasks: readonly Pick<WorkflowTask, 'missing_year'>[]): number[] {
  return [...new Set(tasks.flatMap((task) => (task.missing_year === null ? [] : [task.missing_year])))].sort((a, b) => a - b);
}

/** The counts of the bands as the board and the workflow give them, in the order red, yellow, green; the other two are kept apart. */
export function bandCounts(counts: Readonly<Record<Band, number>>): { red: number; yellow: number; green: number; none: number; unknown: number } {
  return { red: counts.RED, yellow: counts.YELLOW, green: counts.GREEN, none: counts.NONE, unknown: counts.UNKNOWN };
}

// ---- dates (Vietnam time, `YYYY-MM-DD`) ----------------------------------------------------------------------------------------------------------------------------------

const VIETNAM_OFFSET_MS = 7 * 3_600_000;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Today in Vietnam (UTC+7). */
export const todayInVietnam = (now: Date = new Date()): string => new Date(now.getTime() + VIETNAM_OFFSET_MS).toISOString().slice(0, 10);

export function isDay(value: string): boolean {
  if (!DAY.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** The day as `dd/mm/yyyy`; a day that is not there reads as a dash (never a guessed date). */
export function dayText(value: string | null | undefined): string {
  if (value === null || value === undefined || !DAY.test(value)) return '–';
  return `${value.slice(8, 10)}/${value.slice(5, 7)}/${value.slice(0, 4)}`;
}

/** The instant as `dd/mm/yyyy HH:mm` in Vietnam time. */
export function stampText(value: string | null | undefined): string {
  if (value === null || value === undefined) return '–';
  const at = Date.parse(value);
  if (Number.isNaN(at)) return '–';
  const local = new Date(at + VIETNAM_OFFSET_MS).toISOString();
  return `${dayText(local.slice(0, 10))} ${local.slice(11, 16)}`;
}

/** Whole days from `from` to `to` (negative when `to` is earlier); a day that is not there gives null. */
export function daysBetween(from: string | null | undefined, to: string | null | undefined): number | null {
  if (from === null || from === undefined || to === null || to === undefined || !isDay(from) || !isDay(to)) return null;
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** The first day of the month `YYYY-MM` of a day. */
export const monthOf = (day: string): string => day.slice(0, 7);

// ---- refusals ----------------------------------------------------------------------------------------------------------------------------------------------------------------

export type ProblemKind =
  | 'versionConflict'
  | 'scheduleConflict'
  | 'selfApproval'
  | 'completionBlocked'
  | 'gateClosed'
  | 'taskState'
  | 'workflowExists'
  | 'templateNotFound'
  | 'factsRequired'
  | 'adoptInvalid'
  | 'scheduleInvalid'
  | 'dependencyCycle'
  | 'calendarNotEffective'
  | 'reschedulePending'
  | 'exceptionInvalid'
  | 'assignmentInvalid'
  | 'legalDocUnknown'
  | 'templateInvalid'
  | 'bandThresholds'
  | 'bandUnit'
  | 'validation'
  | 'notFound'
  | 'denied'
  | 'general';

export interface Problem {
  kind: ProblemKind;
  /** The field the server named for a validation. */
  field: string | undefined;
  /** What the server listed with the refusal: the blockers of a completion, the missing tasks of a gate. */
  blockers: readonly Blocker[];
  missing: readonly GateAssessment['missing'][number][];
}

const KIND_BY_CODE: Readonly<Record<string, ProblemKind>> = {
  VERSION_CONFLICT: 'versionConflict',
  PWF_SCHEDULE_VERSION_CONFLICT: 'scheduleConflict',
  SELF_APPROVAL_DENIED: 'selfApproval',
  MAKER_IS_APPROVER: 'selfApproval',
  PWF_TASK_COMPLETION_BLOCKED: 'completionBlocked',
  PWF_GATE_CLOSED: 'gateClosed',
  PWF_TASK_STATE_INVALID: 'taskState',
  PWF_WORKFLOW_EXISTS: 'workflowExists',
  PWF_TEMPLATE_NOT_FOUND: 'templateNotFound',
  PWF_FACTS_REQUIRED: 'factsRequired',
  PWF_ADOPT_INVALID: 'adoptInvalid',
  PWF_SCHEDULE_INVALID: 'scheduleInvalid',
  PWF_DEPENDENCY_CYCLE: 'dependencyCycle',
  CALENDAR_NOT_EFFECTIVE: 'calendarNotEffective',
  PWF_RESCHEDULE_PENDING_EXISTS: 'reschedulePending',
  PWF_EXCEPTION_INVALID: 'exceptionInvalid',
  PWF_ASSIGNMENT_INVALID: 'assignmentInvalid',
  LEGAL_DOC_TYPE_UNKNOWN: 'legalDocUnknown',
  PROJECT_WORKFLOW_TEMPLATE_INVALID: 'templateInvalid',
  DEADLINE_BAND_THRESHOLDS_INVALID: 'bandThresholds',
  DEADLINE_BAND_UNIT_MISMATCH: 'bandUnit',
  VALIDATION_FAILED: 'validation',
  INVALID_REQUEST: 'validation',
  FIELD_NOT_ALLOWED: 'validation',
  RESOURCE_NOT_FOUND: 'notFound',
  SCOPE_DENIED: 'denied',
};

const list = <T>(value: unknown): readonly T[] => (Array.isArray(value) ? (value as T[]) : []);

/** What a refused command was refused for; anything the screens have no word for is `general`. */
export function describeProblem(error: unknown): Problem {
  if (!(error instanceof ApiError)) return { kind: 'general', field: undefined, blockers: [], missing: [] };
  return { kind: KIND_BY_CODE[error.code] ?? 'general', field: error.detail, blockers: list<Blocker>(error.extensions.blockers), missing: list<GateAssessment['missing'][number]>(error.extensions.missing) };
}

/** The refusals that say "somebody changed it first": the screen offers to read the newer version. */
export const isConflict = (problem: Problem): boolean => problem.kind === 'versionConflict' || problem.kind === 'scheduleConflict';

// ---- forms ----------------------------------------------------------------------------------------------------------------------------------------------------------------------

export type FormProblem = 'required' | 'tooShort' | 'tooLong' | 'invalidDay' | 'invalidNumber' | 'pickOne';

/** The text of a field: at least `min` and at most `max` characters once trimmed. */
export function textProblem(value: string, min: number, max: number): FormProblem | undefined {
  const size = value.trim().length;
  if (size === 0) return 'required';
  if (size < min) return 'tooShort';
  return size > max ? 'tooLong' : undefined;
}

/** The reason of a decision, a return, an exception: at least `MIN_REASON` characters. */
export const reasonProblem = (value: string): FormProblem | undefined => textProblem(value, MIN_REASON, MAX_REASON);

export const dayProblem = (value: string): FormProblem | undefined => (value.trim() === '' ? 'required' : isDay(value.trim()) ? undefined : 'invalidDay');

/** A whole number between `min` and `max`; the empty text is `required`. */
export function wholeProblem(value: string, min: number, max: number): FormProblem | undefined {
  const text = value.trim();
  if (text === '') return 'required';
  return /^-?\d{1,6}$/.test(text) && Number(text) >= min && Number(text) <= max ? undefined : 'invalidNumber';
}

export const optionalText = (value: string): string | undefined => (value.trim() === '' ? undefined : value.trim());

/** The facts of the branch of a project as the contract takes them: a fact left empty is not sent (an unknown fact is never taken as true, BR-PWF-16). */
export function factsOf(values: Readonly<Record<keyof ProjectFacts, string>>): ProjectFacts {
  const facts: ProjectFacts = {};
  if (values.project_group.trim() !== '') facts.project_group = values.project_group.trim();
  if (values.funding_source.trim() !== '') facts.funding_source = values.funding_source.trim();
  if (values.project_type.trim() !== '') facts.project_type = values.project_type.trim();
  return facts;
}
