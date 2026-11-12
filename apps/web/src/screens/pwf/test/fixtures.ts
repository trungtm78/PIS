import { ApiError } from '@machvon/api-client';
import { t as translate } from '../../../i18n';
import type { WebRoute } from '../../../routes/types';
import { PLATFORM_TENANT, harness } from '../../sas/test-support';
import type { Assignment, DeadlineBoard, SchedulePreview, ScheduleTask, TaskBand, TaskDetail, TemplateParams, WorkflowDetail, WorkflowTask } from '../model';
import { PERMISSIONS } from '../model';

/** The Vietnamese text of a key (the parts waiting to be folded included), with `{name}` filled. */
export const text = (key: string, params: Record<string, string | number> = {}): string => translate(key, params);

export const routeOf = (id: string): WebRoute => ({ id, path: `/pwf/${id.toLowerCase()}`, title: id, kind: 'detail', area: 'investment', module: 'PWF', group: 'Workflow dự án', role: 'workspace', parent: null, req: `FR-${id}` });
export const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const ME = PLATFORM_TENANT.membershipId;
export const OTHER = uuid(70);
export const PROJECT_ID = uuid(900);
export const refusal = (code: string, status = 422, extensions: Record<string, unknown> = {}, detail?: string) => new ApiError({ status, code, correlationId: 'c', extensions, ...(detail === undefined ? {} : { detail }) });

export const ALL_PERMISSIONS: readonly string[] = [...Object.values(PERMISSIONS), 'adm.governance.read', 'adm.governance.manage', 'adm.governance.approve'];
export const READ_ONLY: readonly string[] = [PERMISSIONS.read];

export type Answer = unknown | ((input: Record<string, unknown>) => unknown);
/** A client whose reads and commands are answered by operation; an operation with no answer fails the test. */
export const serve = (answers: Record<string, Answer>, commands: Record<string, Answer> = {}) =>
  harness(
    (operation, input) => {
      const answer = answers[operation];
      if (answer === undefined) return new Error(`unexpected read ${operation}`);
      return typeof answer === 'function' ? (answer as (input: unknown) => unknown)(input) : answer;
    },
    (operation, input) => {
      const answer = commands[operation];
      if (answer === undefined) return new Error(`unexpected command ${operation}`);
      return typeof answer === 'function' ? (answer as (input: unknown) => unknown)(input) : answer;
    },
  );

export const AS_OF = '2026-11-12T03:00:00.000Z';

export const band = (name: TaskBand['band'] = 'GREEN', over: Partial<TaskBand> = {}): TaskBand => ({ band: name, remaining_days: name === 'RED' ? -2 : name === 'YELLOW' ? 2 : name === 'GREEN' ? 5 : null, unit: 'WORKING', overdue: name === 'RED', ...over });

export const workflowTask = (n: number, over: Partial<WorkflowTask> = {}): WorkflowTask => ({
  id: uuid(1000 + n),
  task_code: `T${n}`,
  name: `Công việc ${n}`,
  phase_code: 'PREPARATION',
  kind: 'TASK',
  required: true,
  priority: 'NORMAL',
  status: 'NOT_STARTED',
  excluded: false,
  tracked: true,
  state: 'SCHEDULED',
  planned_start: '2026-12-01',
  planned_finish: '2026-12-10',
  baseline_finish: '2026-12-08',
  missing_year: null,
  total_float: 0,
  critical: false,
  band: band('GREEN'),
  assignee: { membership_id: ME, display_name: 'Nguyễn Văn An' },
  return_count: 0,
  version: 1,
  ...over,
});

export const workflowDetail = (over: Partial<WorkflowDetail> = {}): WorkflowDetail => ({
  id: uuid(800),
  project_id: PROJECT_ID,
  template_code: 'PUBLIC_INVESTMENT',
  template_rule_version: 3,
  template_hash: 'a'.repeat(64),
  unverified: false,
  status: 'ACTIVE',
  planned_start_date: '2026-12-01',
  schedule_version: 2,
  adopted_on: null,
  open_phase: 'PREPARATION',
  phases: [
    { code: 'PREPARATION', name: 'Chuẩn bị đầu tư', order: 1, gates: ['submitProjectForAppraisal'], required_total: 2, required_done: 1, open: true },
    { code: 'EXECUTION', name: 'Thực hiện đầu tư', order: 2, gates: ['startProjectImplementation'], required_total: 1, required_done: 0, open: false },
  ],
  tasks: [
    workflowTask(1, { status: 'DONE', band: band('NONE', { reason: 'NO_DUE' }) }),
    workflowTask(2, { status: 'IN_PROGRESS', band: band('RED'), critical: true }),
    workflowTask(3, { phase_code: 'EXECUTION', planned_start: '2027-01-04', planned_finish: '2027-02-12', band: band('YELLOW') }),
  ],
  gates: [
    { target: 'submitProjectForAppraisal', open: false, missing_count: 1 },
    { target: 'startProjectImplementation', open: false, missing_count: 1 },
  ],
  counts_by_band: { NONE: 1, GREEN: 0, YELLOW: 1, RED: 1, UNKNOWN: 0 },
  can_manage: true,
  can_propose_reschedule: true,
  version: 4,
  as_of: AS_OF,
  ...over,
});

export const scheduleTask = (code: string, over: Partial<ScheduleTask> = {}): ScheduleTask => ({
  task_code: code,
  name: `Việc ${code}`,
  phase_code: 'PREPARATION',
  kind: 'TASK',
  state: 'SCHEDULED',
  start: '2026-12-01',
  finish: '2026-12-10',
  late_start: '2026-12-01',
  late_finish: '2026-12-10',
  total_float: 0,
  free_float: 0,
  critical: true,
  driving_predecessor: null,
  missing_year: null,
  start_variance_days: null,
  finish_variance_days: null,
  findings: [],
  ...over,
});

export const schedulePreview = (over: Partial<SchedulePreview> = {}): SchedulePreview => ({
  planned_start_date: '2026-12-01',
  project_start: '2026-12-01',
  project_finish: '2027-02-12',
  critical_path: ['T1', 'T2'],
  longest_path: ['T1', 'T2'],
  calendar_versions: [{ year: 2026, version: 1 }],
  tasks: [scheduleTask('T1'), scheduleTask('T2', { start: '2026-12-11', finish: '2027-02-12', driving_predecessor: 'T1' })],
  excluded_tasks: [],
  findings: [],
  result_hash: 'b'.repeat(64),
  as_of: AS_OF,
  ...over,
});

export const templateParams = (over: Partial<TemplateParams> = {}): TemplateParams => ({
  name: 'Đầu tư công: xây dựng',
  project_type: 'CONSTRUCTION',
  phases: [{ code: 'PREPARATION', name: 'Chuẩn bị đầu tư', gates: ['submitProjectForAppraisal'] }],
  tasks: [
    { code: 'T1', name: 'Lập báo cáo nghiên cứu khả thi', phase: 'PREPARATION', kind: 'TASK', duration_working_days: 20, required: true, responsible_role: 'PROJECT_MANAGER', approver_role: 'APPROVER', priority: 'NORMAL', predecessors: [] },
    { code: 'T2', name: 'Thẩm định', phase: 'PREPARATION', kind: 'MILESTONE', duration_working_days: 0, required: true, responsible_role: 'APPROVER', approver_role: null, priority: 'HIGH', predecessors: [{ task: 'T1', kind: 'FS', lag_working_days: 0 }] },
  ],
  ...over,
});

export const assignment = (n: number, over: Partial<Assignment> = {}): Assignment => ({
  id: uuid(2000 + n),
  task_id: uuid(1002),
  membership_id: ME,
  display_name: 'Nguyễn Văn An',
  role: 'RESPONSIBLE',
  valid_from: '2026-12-01',
  valid_to: null,
  share_pct: 100,
  reason: 'Giao theo vai của dự án',
  assigned_by: OTHER,
  approved_by: null,
  ...over,
});

export const taskDetail = (over: Partial<TaskDetail> = {}): TaskDetail => ({
  ...workflowTask(2, { status: 'IN_PROGRESS', band: band('YELLOW') }),
  responsible_role: 'PROJECT_MANAGER',
  approver_role: 'APPROVER',
  duration_working_days: 20,
  baseline_start: '2026-11-30',
  finish_variance_days: 2,
  late_start: '2026-12-01',
  late_finish: '2026-12-10',
  free_float: 0,
  actual_start: '2026-12-01',
  actual_finish: null,
  remaining_working_days: 5,
  percent_complete: 60,
  reschedule_count: 0,
  estimate_vnd: null,
  actual_vnd: null,
  milestone_id: null,
  predecessors: [],
  checklist: [{ item_code: 'C1', name: 'Có biên bản họp', required: true, evidence_kinds: ['DOCUMENT'], done: false, done_by: null, done_at: null }],
  legal_doc_types: [{ code: 'INVESTMENT_DECISION', satisfied: false }],
  form_templates: [{ code: 'FORM_REPORT', satisfied: false, document_id: null }],
  evidence: [],
  completion: { ok: false, blockers: [{ code: 'CHECKLIST_ITEM_OPEN', subject: 'C1' }], coverable: [] },
  exceptions: [],
  assignments: [assignment(1)],
  history: [{ id: uuid(3001), kind: 'START', at: '2026-12-01T01:00:00.000Z', actor: ME, reason: null }],
  can_start: false,
  can_complete: true,
  can_approve: false,
  can_return: false,
  can_request_exception: true,
  can_resume: false,
  can_assign: true,
  as_of: AS_OF,
  ...over,
});

export const deadlineBoard = (over: Partial<DeadlineBoard> = {}): DeadlineBoard => ({
  items: [
    {
      task_id: uuid(1002),
      task_code: 'T2',
      name: 'Công việc 2',
      project_id: PROJECT_ID,
      project_code: 'DA-001',
      project_name: 'Dự án thử',
      phase_code: 'PREPARATION',
      kind: 'TASK',
      status: 'IN_PROGRESS',
      due_date: '2026-12-10',
      band: band('RED'),
      critical: true,
      assignee: { membership_id: ME, display_name: 'Nguyễn Văn An' },
    },
  ],
  next_cursor: null,
  shown: 1,
  total: 1,
  truncated: false,
  counts_by_band: { NONE: 0, GREEN: 0, YELLOW: 0, RED: 1, UNKNOWN: 0 },
  official_only: true,
  as_of: AS_OF,
  ...over,
});
