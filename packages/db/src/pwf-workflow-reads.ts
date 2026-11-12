import { DomainError, pwfDeadlineBand, pwfWorkflow, vietnamDateOf } from '@machvon/kernel';
import type { WorkCalendarSource } from '@machvon/kernel';
import { GovernancePolicyPort } from './governance-policy-port.ts';
import { HomeWorkCalendars, WORK_CALENDAR_CODE } from './home-work-clock-store.ts';
import { SCOPE_FROM } from './prj-project-store.ts';
import { SqlProjectWorkflowGate } from './pwf-gate.ts';
import { TASK_COLUMNS, loadLinks, toTaskRow } from './pwf-schedule-support.ts';
import type { TaskRow, TaskSql } from './pwf-schedule-support.ts';
import type { ScopeBuilder } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';

/**
 * The reads of the project workflow (PWF-1, PWF-2): the workflow of a project with its phases, tasks, official colours and gates; the tasks of a project and one task in full; the schedule as last published; the ledger of
 * assignments. Every read is inside the scope of `pwf.read` (a project out of scope does not exist: 404), shows only the OFFICIAL colour of a deadline (R40) and says what the caller may do (`can_*`, given by the controller from the
 * permissions it checked). The shapes are the ones of the contract (snake_case), so the controller hands them on.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SOURCE = 'PROJECT_TASK';
const ISO = (column: string): string => `to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);

export interface BandView {
  band: pwfDeadlineBand.Band;
  remaining_days: number | null;
  unit: pwfDeadlineBand.DeadlineUnit;
  overdue: boolean;
  reason?: string | null;
}

export interface TaskListItem {
  id: string;
  task_code: string;
  name: string;
  phase_code: string;
  kind: string;
  required: boolean;
  priority: string;
  status: string;
  excluded: boolean;
  tracked: boolean;
  state: string;
  planned_start: string | null;
  planned_finish: string | null;
  baseline_finish: string | null;
  missing_year: number | null;
  total_float: number | null;
  critical: boolean;
  band: BandView;
  assignee: { membership_id: string; display_name: string } | null;
  return_count: number;
  version: number;
}

export interface Can {
  manage: boolean;
  proposeReschedule: boolean;
  work: boolean;
  approve: boolean;
  assign: boolean;
}

/** The tier "official" of the colour of a task: the rule in force for the source of the project tasks (default 5, 2, 0 working days), with the overrides by kind, priority and phase. */
export interface BandResolver {
  of(task: Pick<TaskRow, 'status' | 'excluded' | 'tracked' | 'plannedFinish' | 'kind' | 'priority' | 'phaseCode'>): BandView;
  policy: pwfDeadlineBand.BandPolicy;
}

export async function bandResolver(tx: TenantTx, policyPort: GovernancePolicyPort, calendars: HomeWorkCalendars, now: Date): Promise<BandResolver> {
  const today = vietnamDateOf(now);
  const resolved = await policyPort.get(tx, pwfDeadlineBand.DEADLINE_BAND_RULE_TYPE, SOURCE, today);
  if (resolved === undefined) throw new DomainError('GOVERNANCE_RULE_NOT_FOUND', 404, 'code');
  const policy = pwfDeadlineBand.bandPolicyOf(resolved, SOURCE);
  const source: WorkCalendarSource | undefined = await calendars.load(tx, WORK_CALENDAR_CODE, now);
  return {
    policy,
    of: (task): BandView => {
      // A task that is over, cancelled, left out of the project or not tracked has no colour.
      if (task.status === 'DONE' || task.status === 'CANCELLED' || task.excluded || !task.tracked) return { band: 'NONE', remaining_days: null, unit: policy.unit, overdue: false, reason: 'NO_DUE' };
      const thresholds = pwfDeadlineBand.thresholdsFor(policy, { taskKind: task.kind, priority: task.priority, phase: task.phaseCode });
      const result = pwfDeadlineBand.deadlineBand({ dueOn: task.plannedFinish, today, unit: policy.unit, calendars: source, thresholds });
      return { band: result.band, remaining_days: result.remainingDays, unit: result.unit, overdue: result.overdue, reason: result.reason ?? null };
    },
  };
}

interface AssigneeSql {
  task_id: string;
  membership_id: string;
  display_name: string | null;
}

/** The person who holds each task today (the responsible one of the ledger). */
async function assigneesOf(tx: TenantTx, taskIds: readonly string[], today: string): Promise<Map<string, { membership_id: string; display_name: string }>> {
  if (taskIds.length === 0) return new Map();
  const rows = await tx.query<AssigneeSql>(
    `select distinct on (a.task_id) a.task_id, a.membership_id, u.display_name
       from machvon.project_task_assignment a left join machvon.tenant_user_directory u on u.tenant_id = a.tenant_id and u.membership_id = a.membership_id
      where a.task_id = any($1::uuid[]) and a.role = 'RESPONSIBLE' and a.valid_from <= $2::date and (a.valid_to is null or a.valid_to >= $2::date)
      order by a.task_id, a.valid_from desc, a.id`,
    [[...taskIds], today],
  );
  return new Map(rows.map((row) => [row.task_id, { membership_id: row.membership_id, display_name: row.display_name ?? row.membership_id }]));
}

export const taskItemOf = (row: TaskRow, band: BandView, assignee: { membership_id: string; display_name: string } | undefined): TaskListItem => ({
  id: row.id,
  task_code: row.code,
  name: row.name,
  phase_code: row.phaseCode,
  kind: row.kind,
  required: row.required,
  priority: row.priority,
  status: row.status,
  excluded: row.excluded,
  tracked: row.tracked,
  state: row.state,
  planned_start: row.plannedStart,
  planned_finish: row.plannedFinish,
  baseline_finish: row.baselineFinish,
  missing_year: row.missingYear,
  total_float: row.totalFloat,
  critical: row.critical,
  band,
  assignee: assignee ?? null,
  return_count: row.returnCount,
  version: row.version,
});

export interface TaskFilter {
  phase?: string | undefined;
  band?: string | undefined;
  assigneeId?: string | undefined;
  status?: string | undefined;
}

export class PwfWorkflowReads {
  private readonly policy: GovernancePolicyPort;
  private readonly calendars: HomeWorkCalendars;
  private readonly gate = new SqlProjectWorkflowGate();

  constructor(policy: GovernancePolicyPort = new GovernancePolicyPort(), calendars: HomeWorkCalendars = new HomeWorkCalendars()) {
    this.policy = policy;
    this.calendars = calendars;
  }

  private async workflowOf(tx: TenantTx, scope: ScopeBuilder, projectId: string): Promise<{ row: Record<string, unknown>; projectCode: string }> {
    if (!UUID.test(projectId)) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const predicate = scope(2);
    const rows = await tx.query<Record<string, unknown>>(
      `select w.id, w.project_id, w.template_code, w.template_rule_version, w.template_hash, w.template, w.facts, w.status, w.planned_start_date::text as planned_start_date, w.schedule_version, w.adopted_on::text as adopted_on, w.version,
              ${ISO('w.updated_at')} as updated_at, p.code as project_code, w.calendar_pins
         from ${SCOPE_FROM} join machvon.project_workflow w on w.tenant_id = p.tenant_id and w.project_id = p.id where p.id = $1::uuid and ${predicate.sql}`,
      [projectId.toLowerCase(), ...predicate.params],
    );
    if (rows[0] === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return { row: rows[0], projectCode: rows[0].project_code as string };
  }

  private async tasksOf(tx: TenantTx, workflowId: string): Promise<TaskRow[]> {
    const rows = await tx.query<TaskSql>(`select ${TASK_COLUMNS} from machvon.project_task t where t.workflow_id = $1::uuid order by t.sort_order, t.id`, [workflowId]);
    return rows.map(toTaskRow);
  }

  /** The workflow of a project: phases with how many required tasks are done, the open phase, every task with its official colour, the gates and the count of tasks by colour. */
  async detail(tx: TenantTx, scope: ScopeBuilder, projectId: string, now: Date, can: Can): Promise<Record<string, unknown>> {
    const { row } = await this.workflowOf(tx, scope, projectId);
    const template = pwfWorkflow.parseProjectWorkflowTemplate(row.template);
    const today = vietnamDateOf(now);
    const tasks = await this.tasksOf(tx, row.id as string);
    const resolver = await bandResolver(tx, this.policy, this.calendars, now);
    const assignees = await assigneesOf(tx, tasks.map((one) => one.id), today);
    const items = tasks.map((one) => taskItemOf(one, resolver.of(one), assignees.get(one.id)));
    const gated = new Set(template.phases.flatMap((phase) => phase.gates));
    const gates = [];
    for (const target of pwfWorkflow.WORKFLOW_GATE_TARGETS) {
      if (!gated.has(target)) continue;
      const outcome = await this.gate.assess(tx, row.project_id as string, target);
      gates.push({ target, open: outcome?.open ?? true, missing_count: outcome?.missing.length ?? 0 });
    }
    const counts: Record<string, number> = { NONE: 0, GREEN: 0, YELLOW: 0, RED: 0, UNKNOWN: 0 };
    for (const item of items) if (!item.excluded && item.tracked && item.status !== 'DONE' && item.status !== 'CANCELLED') counts[item.band.band] = (counts[item.band.band] ?? 0) + 1;
    let openPhase: string | null = null;
    const phases = template.phases.map((phase) => {
      const required = tasks.filter((one) => one.phaseCode === phase.code && one.required && !one.excluded && one.tracked);
      const done = required.filter((one) => one.status === 'DONE' || one.status === 'CANCELLED').length;
      const open = done < required.length;
      if (open && openPhase === null) openPhase = phase.code;
      return { code: phase.code, name: phase.name, order: phase.order, gates: [...phase.gates], required_total: required.length, required_done: done, open };
    });
    return {
      id: row.id,
      project_id: row.project_id,
      template_code: row.template_code,
      template_rule_version: row.template_rule_version,
      template_hash: row.template_hash,
      unverified: Number(row.template_rule_version) === 0,
      status: row.status,
      planned_start_date: row.planned_start_date,
      schedule_version: row.schedule_version,
      adopted_on: row.adopted_on ?? null,
      open_phase: openPhase,
      phases,
      tasks: items,
      gates,
      counts_by_band: counts,
      can_manage: can.manage,
      can_propose_reschedule: can.proposeReschedule,
      version: row.version,
      as_of: row.updated_at,
    };
  }

  /** The tasks of a workflow, filtered and paged (the order of the template; the cursor is the position and the id), with the exact total of what matches. */
  async listTasks(tx: TenantTx, scope: ScopeBuilder, projectId: string, filter: TaskFilter, page: { limit: number; after?: { code: string; id: string } | undefined }, now: Date): Promise<{ items: TaskListItem[]; next: { code: string; id: string } | null; total: number; asOf: string }> {
    const { row } = await this.workflowOf(tx, scope, projectId);
    const today = vietnamDateOf(now);
    const resolver = await bandResolver(tx, this.policy, this.calendars, now);
    const tasks = await this.tasksOf(tx, row.id as string);
    const assignees = await assigneesOf(tx, tasks.map((one) => one.id), today);
    const all = tasks.map((one) => taskItemOf(one, resolver.of(one), assignees.get(one.id)));
    const matching = all.filter(
      (item) =>
        (filter.phase === undefined || item.phase_code === filter.phase) &&
        (filter.band === undefined || item.band.band === filter.band) &&
        (filter.status === undefined || item.status === filter.status) &&
        (filter.assigneeId === undefined || item.assignee?.membership_id === filter.assigneeId),
    );
    const position = new Map(tasks.map((one) => [one.id, one.sortOrder] as const));
    const after = page.after;
    const rest = after === undefined ? matching : matching.filter((item) => (position.get(item.id) as number) > Number(after.code) || ((position.get(item.id) as number) === Number(after.code) && item.id > after.id));
    const shown = rest.slice(0, page.limit);
    const last = shown[shown.length - 1];
    return { items: shown, next: rest.length > shown.length && last !== undefined ? { code: String(position.get(last.id)), id: last.id } : null, total: matching.length, asOf: row.updated_at as string };
  }

  /** The schedule as last published: days, floats, critical path, the calendar version of each year and the findings; the first baseline gives the variance. */
  async schedule(tx: TenantTx, scope: ScopeBuilder, projectId: string): Promise<Record<string, unknown>> {
    const { row } = await this.workflowOf(tx, scope, projectId);
    const tasks = await this.tasksOf(tx, row.id as string);
    const versions = await tx.query<{ version: number; critical_path: string[]; calendar_versions: unknown; result_hash: string; project_start: string | null; project_finish: string | null; published_at: string }>(
      `select version, critical_path, calendar_versions, result_hash, project_start::text as project_start, project_finish::text as project_finish, ${ISO('published_at')} as published_at
         from machvon.project_schedule_version where workflow_id = $1::uuid order by version desc limit 1`,
      [row.id],
    );
    const published = versions[0];
    const finding = (task: TaskRow): Array<{ code: string; task: string | null; year?: number }> => (task.state === 'CALENDAR_UNAVAILABLE' ? [{ code: 'CALENDAR_UNAVAILABLE', task: task.code, ...(task.missingYear === null ? {} : { year: task.missingYear }) }] : []);
    const variance = (task: TaskRow, from: string | null, to: string | null): number | null => (from === null || to === null ? null : Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000));
    return {
      workflow_id: row.id,
      schedule_version: row.schedule_version,
      planned_start_date: row.planned_start_date,
      published_at: published?.published_at ?? null,
      project_start: published?.project_start ?? null,
      project_finish: published?.project_finish ?? null,
      critical_path: published?.critical_path ?? [],
      longest_path: [],
      calendar_versions: published?.calendar_versions ?? [],
      tasks: tasks.map((task) => ({
        task_id: task.id,
        task_code: task.code,
        name: task.name,
        phase_code: task.phaseCode,
        kind: task.kind,
        state: task.state,
        start: task.plannedStart,
        finish: task.plannedFinish,
        late_start: task.lateStart,
        late_finish: task.lateFinish,
        total_float: task.totalFloat,
        free_float: task.freeFloat,
        critical: task.critical,
        driving_predecessor: task.drivingPredecessor,
        missing_year: task.missingYear,
        start_variance_days: variance(task, task.baselineStart, task.plannedStart),
        finish_variance_days: variance(task, task.baselineFinish, task.plannedFinish),
        findings: finding(task),
      })),
      excluded_tasks: tasks.filter((one) => one.excluded).map((one) => one.code),
      findings: tasks.flatMap(finding),
      result_hash: published?.result_hash ?? '',
      as_of: published?.published_at ?? (row.updated_at as string),
    };
  }

  /** Whether the legal command (or the event of the system) `target` may run for the project: what the screen shows before the command is sent. */
  async evaluateGate(tx: TenantTx, scope: ScopeBuilder, projectId: string, target: string, now: Date): Promise<Record<string, unknown>> {
    if (!(pwfWorkflow.WORKFLOW_GATE_TARGETS as readonly string[]).includes(target)) throw invalid('target');
    const { row } = await this.workflowOf(tx, scope, projectId);
    const outcome = await this.gate.assess(tx, row.project_id as string, target);
    return {
      target,
      gated: outcome?.gated ?? false,
      open: outcome?.open ?? true,
      missing: (outcome?.missing ?? []).map((one) => ({ task: one.task, task_id: one.taskId, phase: one.phase, reason: one.reason })),
      as_of: now.toISOString(),
    };
  }

  /** The links of the tasks of a workflow, for the screens that draw the dependencies. */
  async links(tx: TenantTx, scope: ScopeBuilder, projectId: string): Promise<Array<{ task: string; predecessor: string; kind: string; lag_working_days: number }>> {
    const { row } = await this.workflowOf(tx, scope, projectId);
    const tasks = await this.tasksOf(tx, row.id as string);
    const byId = new Map(tasks.map((one) => [one.id, one.code] as const));
    return (await loadLinks(tx, row.id as string)).map((link) => ({ task: byId.get(link.taskId) as string, predecessor: link.predecessor, kind: link.kind, lag_working_days: link.lagWorkingDays }));
  }
}
