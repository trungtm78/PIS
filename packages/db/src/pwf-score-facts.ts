import { DomainError, pwfKpi, pwfWorkflow, vietnamDateOf } from '@machvon/kernel';
import type { WorkCalendarSource } from '@machvon/kernel';
import type { GovernancePolicyPort } from './governance-policy-port.ts';
import type { TenantTx } from './tenant-database.ts';

/**
 * The facts of the tasks the KPIs and the scores are read from (PWF-3, R34): one batch of queries for any number of tasks (a period of 5,000 people is a handful of queries, never one per task), turned into the
 * `TaskFacts` of the kernel as of a day. A task is read as of the day it was closed when it is done or cancelled by that day, and as of the cutoff (the end of the period) when it was still open then, so that the same
 * data always gives the same figures however late the period is computed.
 */

/** A day the calendar of the tenant (Vietnam) is read in. */
const VIETNAM_DAY = (column: string): string => `(${column} at time zone 'Asia/Ho_Chi_Minh')::date::text`;
const MAX_SAFE = Number.MAX_SAFE_INTEGER;

export interface TaskFactsRow {
  id: string;
  workflowId: string;
  projectId: string;
  code: string;
  name: string;
  phase: string;
  kind: 'TASK' | 'MILESTONE';
  priority: pwfKpi.TaskPriority;
  plannedWorkingDays: number;
  status: string;
  ownTask: boolean;
  createdOn: string;
  baselineFirst: string | null;
  baselineCurrent: string | null;
  baselineStart: string | null;
  plannedStart: string | null;
  plannedFinish: string | null;
  actualStart: string | null;
  actualFinish: string | null;
  completionRequestedOn: string | null;
  cancelledOn: string | null;
  cancelledBy: string | null;
  returnCount: number;
  rescheduleCount: number;
  estimateVnd: string | null;
  actualVnd: string | null;
  version: number;
  /** The version of the task when its KPI results were last evaluated (null: never). */
  kpiRecordedVersion: number | null;
  kpiRecordedCalendars: string | null;
}

interface TaskSql {
  id: string;
  workflow_id: string;
  project_id: string;
  task_code: string;
  name: string;
  phase_code: string;
  kind: 'TASK' | 'MILESTONE';
  priority: pwfKpi.TaskPriority;
  duration_working_days: number;
  status: string;
  own_task: boolean;
  created_on: string;
  baseline_first: string | null;
  baseline_current: string | null;
  baseline_start: string | null;
  planned_start: string | null;
  planned_finish: string | null;
  actual_start: string | null;
  actual_finish: string | null;
  requested_on: string | null;
  cancelled_on: string | null;
  cancelled_by: string | null;
  return_count: number;
  reschedule_count: number;
  estimate_vnd: string | null;
  actual_vnd: string | null;
  version: number;
  kpi_recorded_version: number | null;
  kpi_recorded_calendars: string | null;
}

const TASK_SELECT = `t.id, t.workflow_id, t.project_id, t.task_code, t.name, t.phase_code, t.kind, t.priority, t.duration_working_days, t.status, t.own_task, ${VIETNAM_DAY('t.created_at')} as created_on,
       t.baseline_finish::text as baseline_first,
       coalesce((select b.finish_day::text from machvon.project_task_baseline b join machvon.project_workflow_baseline wb on wb.tenant_id = b.tenant_id and wb.id = b.baseline_id
                  where b.tenant_id = t.tenant_id and b.task_id = t.id and b.finish_day is not null order by wb.version desc limit 1), t.baseline_finish::text) as baseline_current,
       t.baseline_start::text as baseline_start, t.planned_start::text as planned_start, t.planned_finish::text as planned_finish, t.actual_start::text as actual_start, t.actual_finish::text as actual_finish,
       ${VIETNAM_DAY('t.completion_requested_at')} as requested_on, ${VIETNAM_DAY('t.cancelled_at')} as cancelled_on, t.cancelled_by, t.return_count, t.reschedule_count,
       t.estimate_vnd::text as estimate_vnd, t.actual_vnd::text as actual_vnd, t.version, t.kpi_recorded_version, t.kpi_recorded_calendars`;

const toRow = (row: TaskSql): TaskFactsRow => ({
  id: row.id,
  workflowId: row.workflow_id,
  projectId: row.project_id,
  code: row.task_code,
  name: row.name,
  phase: row.phase_code,
  kind: row.kind,
  priority: row.priority,
  plannedWorkingDays: row.duration_working_days,
  status: row.status,
  ownTask: row.own_task,
  createdOn: row.created_on,
  baselineFirst: row.baseline_first,
  baselineCurrent: row.baseline_current,
  baselineStart: row.baseline_start,
  plannedStart: row.planned_start,
  plannedFinish: row.planned_finish,
  actualStart: row.actual_start,
  actualFinish: row.actual_finish,
  completionRequestedOn: row.requested_on,
  cancelledOn: row.cancelled_on,
  cancelledBy: row.cancelled_by,
  returnCount: row.return_count,
  rescheduleCount: row.reschedule_count,
  estimateVnd: row.estimate_vnd,
  actualVnd: row.actual_vnd,
  version: row.version,
  kpiRecordedVersion: row.kpi_recorded_version,
  kpiRecordedCalendars: row.kpi_recorded_calendars,
});

/** One line of the ledger of assignments, with the id of the row. */
export interface BundleAssignment extends pwfKpi.LedgerAssignment {
  id: string;
}

export interface WorkflowFacts {
  id: string;
  templateCode: string;
  template: pwfWorkflow.ProjectWorkflowTemplate;
}

export interface TaskBundle {
  row: TaskFactsRow;
  workflow: WorkflowFacts;
  definition: pwfWorkflow.TemplateTask | undefined;
  /** Required evidence (checklist items, legal documents, forms) and how many of them the task has. */
  requiredEvidence: number;
  providedEvidence: number;
  excusals: ReadonlyArray<{ kind: pwfKpi.ExcusalKind; from: string; to: string | null }>;
  assignments: readonly BundleAssignment[];
}

/** What a task is when read at a cutoff: the status the kernel knows, the day it was closed (when it was), and whether that is final (done or cancelled by the cutoff) or the reading of an open task. */
export interface TaskReading {
  status: pwfKpi.TaskStatus;
  closedOn: string | null;
  final: boolean;
  actualFinish: string | null;
}

/** The reading of a task at the end of a period (`cutoff`): done or cancelled by then is final, awaiting an approval that was asked for by then counts as done on the day it was asked, anything else is open. */
export function readingOf(row: TaskFactsRow, cutoff: string): TaskReading {
  if (row.status === 'DONE' && row.actualFinish !== null && row.actualFinish <= cutoff) return { status: 'DONE', closedOn: row.actualFinish, final: true, actualFinish: row.actualFinish };
  if (row.status === 'CANCELLED' && row.cancelledOn !== null && row.cancelledOn <= cutoff) return { status: 'CANCELLED', closedOn: row.cancelledOn, final: true, actualFinish: null };
  if (row.status === 'AWAITING_APPROVAL' && row.completionRequestedOn !== null && row.completionRequestedOn <= cutoff) {
    return { status: 'DONE', closedOn: null, final: false, actualFinish: row.completionRequestedOn };
  }
  const started = row.actualStart !== null && row.actualStart <= cutoff;
  return { status: started ? 'IN_PROGRESS' : 'NOT_STARTED', closedOn: null, final: false, actualFinish: null };
}

const moneyOf = (value: string | null): number | null => {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed <= MAX_SAFE ? parsed : null;
};

/** The facts of the kernel for a task read at `cutoff`: `asOf` is the day it was closed for a final reading and the cutoff for an open one, so that a final figure never moves with the day it is computed on. */
export function factsOf(bundle: TaskBundle, reading: TaskReading, cutoff: string): pwfKpi.TaskFacts {
  const { row } = bundle;
  const asOf = reading.closedOn ?? cutoff;
  const excusals = bundle.excusals
    .map((one) => ({ kind: one.kind, from: one.from, to: one.to === null || one.to > asOf ? asOf : one.to }))
    .filter((one) => one.from <= one.to);
  const responsible = bundle.assignments.filter((one) => one.role === 'RESPONSIBLE').map((one) => one.membershipId);
  return {
    taskCode: row.code,
    baselineDueFirst: row.baselineFirst,
    baselineDueCurrent: row.baselineCurrent,
    actualFinish: reading.actualFinish,
    actualStart: row.actualStart,
    status: reading.status,
    cancelApproved: reading.status === 'CANCELLED' && row.cancelledBy !== null && !responsible.includes(row.cancelledBy),
    asOf,
    estimateVnd: moneyOf(row.estimateVnd),
    actualVnd: moneyOf(row.actualVnd),
    returnCount: row.returnCount,
    requiredEvidence: bundle.requiredEvidence,
    providedEvidence: bundle.providedEvidence,
    rescheduleCount: row.rescheduleCount,
    excusals,
    priority: row.priority,
    plannedWorkingDays: row.plannedWorkingDays,
  };
}

/** The calendars the figures of a task were counted on: the published ones of the years asked for, and the version of each year (the hash of the facts names them). */
export interface CalendarSet {
  source: WorkCalendarSource | undefined;
  versions: Array<{ year: number; version: number }>;
}

interface CalendarSql {
  year: number;
  revision: number;
  working_days: number[];
  holidays: Array<{ date: string; name?: string }>;
  compensated_workdays: string[] | null;
  legal_basis_ref: string;
}

/** The published calendars of the years `fromYear` to `toYear`; the years nobody published stay missing, so a count over them says so instead of guessing a day. */
export async function loadCalendars(tx: TenantTx, fromYear: number, toYear: number): Promise<CalendarSet> {
  const rows = await tx.query<CalendarSql>(
    `select year, revision, working_days, holidays, compensated_workdays, legal_basis_ref from machvon.work_calendar_version where calendar_code = 'WORKDAY_VN' and status = 'Published' and year between $1::int and $2::int order by year`,
    [fromYear, toYear],
  );
  if (rows.length === 0) return { source: undefined, versions: [] };
  // One content object for each year: the counts of days remember what they judged on it.
  const byYear = new Map(
    rows.map((row) => [row.year, { calendar_code: 'WORKDAY_VN', year: row.year, working_days: row.working_days, holidays: row.holidays as never, compensated_workdays: row.compensated_workdays ?? [], legal_basis_ref: row.legal_basis_ref }] as const),
  );
  return {
    source: { forYear: (year) => byYear.get(year) },
    versions: rows.map((row) => ({ year: row.year, version: row.revision })),
  };
}

/** A fingerprint of the published working calendars (year and revision of each): when it changes, the results counted on the old ones are read again. */
export async function calendarFingerprint(tx: TenantTx): Promise<string> {
  const rows = await tx.query<{ f: string }>("select md5(coalesce(string_agg(year::text || ':' || revision::text, ',' order by year, revision), '')) as f from machvon.work_calendar_version where calendar_code = 'WORKDAY_VN' and status = 'Published'");
  return (rows[0] as { f: string }).f;
}

/** The years of the days a set of tasks is counted over: from the earliest baseline to the latest day (inclusive). */
export function yearSpanOf(days: ReadonlyArray<string | null>, fallback: string): { from: number; to: number } {
  const years = days.filter((day): day is string => day !== null).concat(fallback).map((day) => Number(day.slice(0, 4)));
  return { from: Math.min(...years), to: Math.max(...years) };
}

/** A KPI set with the rule that decided it. */
export interface ResolvedKpiSet {
  code: string;
  ruleId: string | null;
  version: number;
  set: pwfKpi.KpiSet;
}

/**
 * The set of KPIs of a workflow: the set that was approved or built in for the code of its template (R37), else the default set. Sets are read once for the day and kept by template code, the newest rule version of
 * a code deciding; two sets for one template are decided by the code, so that the answer never depends on the order of the rows.
 */
export function loadKpiSets(tx: TenantTx, policy: GovernancePolicyPort): { forTemplate(templateCode: string, day: string): Promise<ResolvedKpiSet> } {
  // The rules of one day are read once and kept: a task is judged by the rules of the day it was closed (a new set never rescores a task closed before it), and a pass has few distinct days.
  const byDay = new Map<string, Promise<ResolvedKpiSet[]>>();
  const setsOf = (day: string): Promise<ResolvedKpiSet[]> => {
    let found = byDay.get(day);
    if (found === undefined) {
      found = policy.getAll(tx, pwfKpi.WORKFLOW_KPI_SET_RULE_TYPE, day).then((rules) => rules.map((rule): ResolvedKpiSet => ({ code: rule.code, ruleId: rule.ruleId, version: rule.version, set: pwfKpi.parseKpiSet(rule.params) })));
      byDay.set(day, found);
    }
    return found;
  };
  return {
    async forTemplate(templateCode, day) {
      const sets = await setsOf(day);
      const own = sets.filter((one) => one.set.templateCode === templateCode).sort((left, right) => (left.code < right.code ? -1 : 1));
      const found = own[0] ?? sets.find((one) => one.code === pwfKpi.DEFAULT_KPI_SET_CODE);
      if (found === undefined) throw new DomainError('GOVERNANCE_RULE_NOT_FOUND', 404, 'kpi_set');
      return found;
    },
  };
}

interface WorkflowSql {
  id: string;
  template_code: string;
  template: unknown;
}

interface ExceptionSql {
  task_id: string;
  kind: 'PAUSE' | 'EXTERNAL_DELAY';
  valid_from: string;
  valid_to: string | null;
}

interface AssignmentSql {
  id: string;
  task_id: string;
  membership_id: string;
  role: pwfKpi.AssignmentRole;
  valid_from: string;
  valid_to: string | null;
  share_pct: number;
}

interface ChecklistSql {
  task_id: string;
  item_code: string;
  done: boolean;
  kinds: string[] | null;
}

interface EvidenceSql {
  task_id: string;
  legal_doc_type: string | null;
  form_template_code: string | null;
}

/** How many of the requirements a task has (required checklist items with their evidence, legal documents, forms) it has met. A requirement is one item, one type of document or one form. */
function evidenceCounts(definition: pwfWorkflow.TemplateTask | undefined, checklist: readonly ChecklistSql[], evidence: readonly EvidenceSql[]): { required: number; provided: number } {
  if (definition === undefined) return { required: 0, provided: 0 };
  const required = definition.checklist.filter((item) => item.required).length + definition.legalDocTypes.length + definition.formTemplates.length;
  const assessment = pwfWorkflow.assessTaskCompletion(
    { ...definition, approverRole: null },
    {
      performer: '',
      approver: null,
      makers: [],
      checklist: checklist.map((item) => ({ code: item.item_code, done: item.done, evidenceKinds: item.kinds ?? [] })),
      legalDocTypes: evidence.map((row) => row.legal_doc_type).filter((value): value is string => value !== null),
      formTemplates: evidence.map((row) => row.form_template_code).filter((value): value is string => value !== null),
      exceptionApproved: false,
    },
  );
  const missing = new Set(assessment.blockers.map((blocker) => `${blocker.code === 'EVIDENCE_MISSING' ? 'CHECKLIST_ITEM_OPEN' : blocker.code}:${blocker.subject}`));
  return { required, provided: Math.max(0, required - missing.size) };
}

/** The task rows (facts, not yet read at a day) for a set of ids, in a few queries whatever their number. */
export async function loadTaskBundles(tx: TenantTx, taskIds: readonly string[]): Promise<Map<string, TaskBundle>> {
  const bundles = new Map<string, TaskBundle>();
  if (taskIds.length === 0) return bundles;
  const ids = [...taskIds];
  const tasks = await tx.query<TaskSql>(`select ${TASK_SELECT} from machvon.project_task t where t.id = any($1::uuid[])`, [ids]);
  const workflowIds = [...new Set(tasks.map((task) => task.workflow_id))];
  const workflows = await tx.query<WorkflowSql>('select id, template_code, template from machvon.project_workflow where id = any($1::uuid[])', [workflowIds]);
  const parsed = new Map<string, WorkflowFacts>(workflows.map((one) => [one.id, { id: one.id, templateCode: one.template_code, template: pwfWorkflow.parseProjectWorkflowTemplate(one.template) }] as const));
  const [exceptions, assignments, checklist, evidence] = await Promise.all([
    tx.query<ExceptionSql>(
      `select task_id, kind, valid_from::text as valid_from, valid_to::text as valid_to from machvon.project_task_exception where task_id = any($1::uuid[]) and kind in ('PAUSE', 'EXTERNAL_DELAY') and status in ('APPROVED', 'USED')`,
      [ids],
    ),
    tx.query<AssignmentSql>(
      `select id, task_id, membership_id, role, valid_from::text as valid_from, valid_to::text as valid_to, share_pct from machvon.project_task_assignment where task_id = any($1::uuid[]) order by valid_from, id`,
      [ids],
    ),
    tx.query<ChecklistSql>(
      `select i.task_id, i.item_code, i.done, (select array_agg(distinct e.evidence_kind) from machvon.project_task_evidence e where e.task_id = i.task_id and e.item_code = i.item_code) as kinds from machvon.project_task_checklist_item i where i.task_id = any($1::uuid[])`,
      [ids],
    ),
    tx.query<EvidenceSql>('select task_id, legal_doc_type, form_template_code from machvon.project_task_evidence where task_id = any($1::uuid[])', [ids]),
  ]);
  const group = <T extends { task_id: string }>(rows: readonly T[]): Map<string, T[]> => {
    const map = new Map<string, T[]>();
    for (const row of rows) map.set(row.task_id, [...(map.get(row.task_id) ?? []), row]);
    return map;
  };
  const byException = group(exceptions);
  const byAssignment = group(assignments);
  const byChecklist = group(checklist);
  const byEvidence = group(evidence);
  for (const task of tasks) {
    const workflow = parsed.get(task.workflow_id) as WorkflowFacts;
    const row = toRow(task);
    const definition = workflow.template.tasks.find((one) => one.code === row.code);
    const counts = evidenceCounts(definition, byChecklist.get(row.id) ?? [], byEvidence.get(row.id) ?? []);
    bundles.set(row.id, {
      row,
      workflow,
      definition,
      requiredEvidence: counts.required,
      providedEvidence: counts.provided,
      excusals: (byException.get(row.id) ?? []).map((one) => ({ kind: one.kind === 'PAUSE' ? ('APPROVED_PAUSE' as const) : ('APPROVED_EXTERNAL_DELAY' as const), from: one.valid_from, to: one.valid_to })),
      assignments: (byAssignment.get(row.id) ?? []).map((one) => ({ id: one.id, membershipId: one.membership_id, role: one.role, from: one.valid_from, to: one.valid_to, sharePct: one.share_pct })),
    });
  }
  return bundles;
}

/** The items of a KPI set that measure a task: the items whose `applies_to` fits it, narrowed to the KPI codes the template names on the task when it names any. */
export function itemsFor(set: pwfKpi.KpiSet, bundle: TaskBundle): pwfKpi.KpiSetItem[] {
  const named = bundle.definition?.kpiCodes ?? [];
  return set.items.filter((item) => pwfKpi.itemApplies(item, { taskCode: bundle.row.code, taskKind: bundle.row.kind, phase: bundle.row.phase }) && (named.length === 0 || named.includes(item.kpiCode)));
}

/** The Vietnam day of an instant. */
export const dayOfInstant = (at: Date): string => vietnamDateOf(at);
