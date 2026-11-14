import { randomUUID } from 'node:crypto';
import { DomainError, hasControlCharExceptWhitespace, processCore, pwfSchedule, pwfWorkflow, vietnamDateOf, versionConflict } from '@machvon/kernel';
import { PrjBaselineStore } from './prj-baseline-store.ts';
import { SCOPE_FROM } from './prj-project-store.ts';
import type { ScopeBuilder } from './scope-version.ts';
import { dateOf, lockProject } from './prj-stage-support.ts';
import type { StageScopes } from './prj-stage-support.ts';
import { logWorkflow, publishSchedule, resultHashOf } from './pwf-publish.ts';
import { baselineOfRows, dueOf, earliestYear, inputHashOf, loadLinks, loadTasks, pinPublishedCalendars, resultOfRows, scheduleTasksOf } from './pwf-schedule-support.ts';
import type { PinnedCalendar, TaskLink, TaskRow } from './pwf-schedule-support.ts';
import type { TenantTx } from './tenant-database.ts';

/**
 * Moving the schedule (PWF-2, docs PWF 3 F6, BR-PWF-08, 28, R32): a manager proposes a change (the planned start, progress, tasks of the project's own, links, durations, a newer working calendar); the preview is computed on
 * what is not done, the baseline untouched, and kept with the hashes of its input and result. Another person decides it: approval publishes the new version of the schedule in one transaction under the lock of the project, and
 * only when the workflow is still at the version the preview was made on; two people who move the schedule at once cannot both win (409 `PWF_SCHEDULE_VERSION_CONFLICT`).
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODE = /^[A-Z][A-Z0-9_]{1,39}$/;
const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);
const conflict = (reason: string, extensions: Record<string, unknown> = {}): DomainError => new DomainError('PWF_SCHEDULE_VERSION_CONFLICT', 409, 'version', { extensions: { reason, ...extensions } });
const OWN_ROLE = 'PROJECT_MANAGER';

export interface LinkInput {
  task: string;
  kind: 'FS' | 'SS' | 'FF' | 'SF';
  lagWorkingDays: number;
}

export interface RescheduleInput {
  plannedStartDate?: string | undefined;
  statusDate?: string | undefined;
  progress?: ReadonlyArray<{ taskCode: string; actualStart?: string | null | undefined; remainingWorkingDays?: number | null | undefined; percentComplete?: number | null | undefined }> | undefined;
  overrides?: {
    add?: ReadonlyArray<{ code: string; name: string; phase: string; kind: 'TASK' | 'MILESTONE'; durationWorkingDays: number; predecessors?: readonly LinkInput[] | undefined }> | undefined;
    change?: ReadonlyArray<{ taskCode: string; durationWorkingDays?: number | undefined; predecessors?: readonly LinkInput[] | undefined }> | undefined;
    remove?: readonly string[] | undefined;
  } | undefined;
  reason: string;
}

export interface ProposalView {
  id: string;
  workflowId: string;
  projectId: string;
  status: 'PROPOSED' | 'APPROVED' | 'REJECTED' | 'SUPERSEDED';
  baseVersion: number;
  baseScheduleVersion: number;
  inputHash: string;
  resultHash: string;
  reason: string;
  proposedBy: string;
  version: number;
  preview: { schedule: pwfSchedule.ScheduleResult; changes: pwfSchedule.ScheduleChange[]; projectFinishShiftDays: number | null; excluded: string[]; names: Record<string, string>; phases: Record<string, string> };
}

interface WorkflowSql {
  id: string;
  project_id: string;
  status: string;
  version: number;
  schedule_version: number;
  planned_start_date: string;
  template: Record<string, unknown>;
  calendar_pins: unknown;
}

interface ProposalSql {
  id: string;
  workflow_id: string;
  status: ProposalView['status'];
  base_version: number;
  base_schedule_version: number;
  input: Record<string, unknown>;
  preview: ProposalView['preview'];
  input_hash: string;
  result_hash: string;
  reason: string;
  proposed_by: string;
  version: number;
}

const toView = (row: ProposalSql, projectId: string): ProposalView => ({
  id: row.id,
  workflowId: row.workflow_id,
  projectId,
  status: row.status,
  baseVersion: row.base_version,
  baseScheduleVersion: row.base_schedule_version,
  inputHash: row.input_hash,
  resultHash: row.result_hash,
  reason: row.reason,
  proposedBy: row.proposed_by,
  version: row.version,
  preview: row.preview,
});

const PROPOSAL_COLUMNS = 'pr.id, pr.workflow_id, pr.status, pr.base_version, pr.base_schedule_version, pr.input, pr.preview, pr.input_hash, pr.result_hash, pr.reason, pr.proposed_by, pr.version';

const sourceOf = (calendars: readonly PinnedCalendar[]): { forYear(year: number): PinnedCalendar['content'] | undefined } => ({ forYear: (year) => calendars.find((one) => one.year === year)?.content });

function reasonOf(value: string): string {
  const text = value.trim();
  if (text.length < 20 || text.length > 1000 || hasControlCharExceptWhitespace(text)) throw invalid('reason');
  return text;
}

const checkedLinks = (links: readonly LinkInput[] | undefined, field: string): pwfSchedule.ScheduleLink[] =>
  (links ?? []).map((link, index) => {
    if (!CODE.test(link.task) || !(pwfWorkflow.DEPENDENCY_KINDS as readonly string[]).includes(link.kind) || !Number.isInteger(link.lagWorkingDays) || Math.abs(link.lagWorkingDays) > 365) throw invalid(`${field}[${index}]`);
    return { task: link.task, kind: link.kind, lagWorkingDays: link.lagWorkingDays };
  });

/** The tasks as the preview takes them: the progress given (only what the person can say about an open task), then the overrides of the project. The same function judges a proposal when it is made and when it is approved. */
export function proposedTasks(rows: readonly TaskRow[], links: readonly TaskLink[], input: RescheduleInput, phases: readonly string[]): pwfSchedule.ScheduleTask[] {
  const progress = new Map((input.progress ?? []).map((one) => [one.taskCode, one] as const));
  const known = new Set(rows.map((row) => row.code));
  for (const code of progress.keys()) if (!known.has(code)) throw invalid('progress');
  const base = scheduleTasksOf(rows, links).map((one): pwfSchedule.ScheduleTask => {
    const given = progress.get(one.code);
    // Progress is what a person can say about a task that is being worked on: the same rule decides what the preview takes and what is kept when the proposal is approved.
    const stored = rows.find((row) => row.code === one.code)?.status;
    if (given === undefined || (stored !== 'IN_PROGRESS' && stored !== 'ON_HOLD')) return one;
    return {
      ...one,
      ...(given.actualStart !== undefined && given.actualStart !== null && one.status === 'IN_PROGRESS' && one.actualStart === null ? { actualStart: dateOf(given.actualStart, 'progress.actual_start') } : {}),
      ...(given.remainingWorkingDays !== undefined ? { remainingWorkingDays: given.remainingWorkingDays } : {}),
      ...(given.percentComplete !== undefined ? { percentComplete: given.percentComplete } : {}),
    };
  });
  const overrides = input.overrides;
  if (overrides === undefined) return base;
  for (const added of overrides.add ?? []) if (!CODE.test(added.code) || !phases.includes(added.phase)) throw invalid('overrides.add');
  const change: Record<string, Partial<pwfSchedule.ScheduleTask>> = {};
  for (const one of overrides.change ?? []) {
    change[one.taskCode] = { ...(one.durationWorkingDays === undefined ? {} : { durationWorkingDays: one.durationWorkingDays }), ...(one.predecessors === undefined ? {} : { predecessors: checkedLinks(one.predecessors, 'overrides.change') }) };
  }
  for (const code of overrides.remove ?? []) {
    const row = rows.find((one) => one.code === code);
    if (row !== undefined && row.status !== 'NOT_STARTED') throw invalid('overrides.remove');
  }
  return pwfSchedule.applyOverrides(base, {
    add: (overrides.add ?? []).map((one) => ({ code: one.code, kind: one.kind, durationWorkingDays: one.durationWorkingDays, predecessors: checkedLinks(one.predecessors, 'overrides.add') })),
    change,
    remove: [...(overrides.remove ?? [])],
  });
}

export class PwfRescheduleStore {
  private readonly baseline: PrjBaselineStore;

  constructor(baseline: PrjBaselineStore = new PrjBaselineStore()) {
    this.baseline = baseline;
  }

  /** Previews a change and keeps it as the one proposal of the workflow that waits for a decision. 409 `PWF_RESCHEDULE_PENDING_EXISTS` while another is waiting (one that the schedule has outrun is superseded first). */
  async propose(tx: TenantTx, request: { projectId: string; expectedVersion: number; input: RescheduleInput; actor: string; scopes: StageScopes; now: Date }): Promise<ProposalView> {
    if (!UUID.test(request.projectId)) throw invalid('project_id');
    const project = await lockProject(tx, request.projectId.toLowerCase(), request.scopes);
    const workflow = await this.lockWorkflow(tx, project.id);
    if (workflow.version !== request.expectedVersion) throw versionConflict(workflow.version);
    if (workflow.status !== 'ACTIVE') throw new DomainError('PWF_TASK_STATE_INVALID', 409, 'status', { extensions: { reason: 'WORKFLOW_NOT_ACTIVE', workflow_status: workflow.status } });
    const today = vietnamDateOf(request.now);
    const reason = reasonOf(request.input.reason);
    const pending = await tx.query<{ id: string; base_version: number }>(`select id, base_version from machvon.project_reschedule_proposal where workflow_id = $1::uuid and status = 'PROPOSED' for update`, [workflow.id]);
    if (pending[0] !== undefined) {
      if (pending[0].base_version === workflow.version) throw new DomainError('PWF_RESCHEDULE_PENDING_EXISTS', 409, 'workflow_id', { extensions: { proposal_id: pending[0].id } });
      await tx.query(`update machvon.project_reschedule_proposal set status = 'SUPERSEDED', decided_at = now(), version = version + 1 where id = $1::uuid`, [pending[0].id]);
    }
    const rows = await loadTasks(tx, workflow.id);
    const links = await loadLinks(tx, workflow.id);
    const template = pwfWorkflow.parseProjectWorkflowTemplate(workflow.template);
    const plannedStart = request.input.plannedStartDate === undefined ? workflow.planned_start_date : dateOf(request.input.plannedStartDate, 'planned_start_date');
    const statusDate = request.input.statusDate === undefined ? today : dateOf(request.input.statusDate, 'status_date');
    const calendars = await pinPublishedCalendars(tx, earliestYear([plannedStart, statusDate, ...rows.flatMap((row) => [row.baselineStart, row.actualStart, row.actualFinish])]));
    const tasks = proposedTasks(rows, links, request.input, template.phases.map((phase) => phase.code));
    const first = request.input.plannedStartDate === undefined ? undefined : plannedStart;
    const input = { tasks, plannedStart, calendars, statusDate };
    // R49: a proposal asks to move the days that were RELEASED (the official deadlines), so what moves is measured against them, never against the forecast a recomputation left behind.
    const rescheduled = pwfSchedule.rescheduleProject({ before: resultOfRows(rows, 'COMMITTED'), input, baseline: baselineOfRows(rows) });
    const before = rows.filter((row) => !row.excluded).map((row) => dueOf(row)).filter((day): day is string => day !== null).sort().pop() ?? null;
    const projectFinishShiftDays = before === null || rescheduled.schedule.projectFinish === null ? null : (processCore.workingDaysBetween(sourceOf(calendars), before, rescheduled.schedule.projectFinish) ?? null);
    const names = Object.fromEntries([...rows.map((row) => [row.code, row.name] as const), ...(request.input.overrides?.add ?? []).map((one) => [one.code, one.name] as const)]);
    const phases = Object.fromEntries([...rows.map((row) => [row.code, row.phaseCode] as const), ...(request.input.overrides?.add ?? []).map((one) => [one.code, one.phase] as const)]);
    const id = randomUUID();
    const stored = { planned_start_date: first ?? null, status_date: statusDate, input: request.input };
    const preview = { schedule: rescheduled.schedule, changes: rescheduled.diff, projectFinishShiftDays, excluded: tasks.filter((one) => one.excluded === true).map((one) => one.code), names, phases };
    await tx.query(
      `insert into machvon.project_reschedule_proposal (tenant_id, id, workflow_id, base_version, base_schedule_version, input, preview, input_hash, result_hash, reason, proposed_by)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3::int, $4::int, $5::jsonb, $6::jsonb, $7, $8, $9, $10::uuid)`,
      [id, workflow.id, workflow.version, workflow.schedule_version, JSON.stringify(stored), JSON.stringify(preview), inputHashOf({ ...input, tasks }), resultHashOf(rescheduled.schedule), reason, request.actor],
    );
    await logWorkflow(tx, { workflowId: workflow.id, kind: 'RESCHEDULE_PROPOSED', actor: request.actor, reason, subject: { proposal_id: id, base_version: workflow.version, result_hash: resultHashOf(rescheduled.schedule) } });
    const [row] = await tx.query<ProposalSql>(`select ${PROPOSAL_COLUMNS} from machvon.project_reschedule_proposal pr where pr.id = $1::uuid`, [id]);
    return toView(row as ProposalSql, project.id);
  }

  /**
   * Decides a proposal. The one who proposed does not decide (403 `SELF_APPROVAL_DENIED`); `expectedVersion` is the version of the workflow the preview was made on; a preview the schedule has outrun, or one whose input is not what is
   * now stored, is 409 `PWF_SCHEDULE_VERSION_CONFLICT`. Approval writes the overrides, publishes the version and counts the moves; rejection only closes the proposal.
   */
  async decide(tx: TenantTx, request: { proposalId: string; expectedVersion: number; decision: string; note?: string | undefined; actor: string; scopes: StageScopes; now: Date }): Promise<{ proposal: ProposalView; scheduleVersion: number; workflowVersion: number; resultHash: string | null }> {
    if (!UUID.test(request.proposalId)) throw invalid('id');
    const found = await tx.query<{ project_id: string }>(
      'select w.project_id from machvon.project_reschedule_proposal pr join machvon.project_workflow w on w.tenant_id = pr.tenant_id and w.id = pr.workflow_id where pr.id = $1::uuid',
      [request.proposalId.toLowerCase()],
    );
    if (found[0] === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const project = await lockProject(tx, found[0].project_id, request.scopes);
    const workflow = await this.lockWorkflow(tx, project.id);
    const [row] = await tx.query<ProposalSql>(`select ${PROPOSAL_COLUMNS} from machvon.project_reschedule_proposal pr where pr.id = $1::uuid for update`, [request.proposalId.toLowerCase()]);
    const held = row as ProposalSql;
    if (held.base_version !== request.expectedVersion) throw versionConflict(held.base_version);
    if (held.proposed_by === request.actor) throw new DomainError('SELF_APPROVAL_DENIED', 403);
    if (request.decision !== 'APPROVE' && request.decision !== 'REJECT') throw invalid('decision');
    if (held.status !== 'PROPOSED') throw conflict(held.status === 'SUPERSEDED' ? 'SUPERSEDED' : 'ALREADY_DECIDED', { proposal_status: held.status });
    const note = request.note === undefined ? null : request.note.trim();
    if (note !== null && (note.length < 5 || note.length > 500 || hasControlCharExceptWhitespace(note))) throw invalid('note');
    const today = vietnamDateOf(request.now);
    if (request.decision === 'REJECT') {
      await tx.query(`update machvon.project_reschedule_proposal set status = 'REJECTED', decided_by = $2::uuid, decided_at = now(), decision_note = $3, version = version + 1 where id = $1::uuid`, [held.id, request.actor, note]);
      await logWorkflow(tx, { workflowId: workflow.id, kind: 'RESCHEDULE_DECIDED', actor: request.actor, reason: note, subject: { proposal_id: held.id, decision: 'REJECT' } });
      return { proposal: { ...toView(held, project.id), status: 'REJECTED' }, scheduleVersion: workflow.schedule_version, workflowVersion: workflow.version, resultHash: null };
    }
    if (workflow.version !== held.base_version || workflow.schedule_version !== held.base_schedule_version) throw conflict('WORKFLOW_MOVED', { workflow_version: workflow.version });
    if (workflow.status !== 'ACTIVE') throw new DomainError('PWF_TASK_STATE_INVALID', 409, 'status', { extensions: { reason: 'WORKFLOW_NOT_ACTIVE', workflow_status: workflow.status } });
    const stored = held.input as { planned_start_date: string | null; status_date: string; input: RescheduleInput };
    const rowsBefore = await loadTasks(tx, workflow.id);
    const linksBefore = await loadLinks(tx, workflow.id);
    const template = pwfWorkflow.parseProjectWorkflowTemplate(workflow.template);
    const plannedStart = stored.planned_start_date ?? workflow.planned_start_date;
    const calendars = await pinPublishedCalendars(tx, earliestYear([plannedStart, stored.status_date, ...rowsBefore.flatMap((row) => [row.baselineStart, row.actualStart, row.actualFinish])]));
    const wanted = proposedTasks(rowsBefore, linksBefore, stored.input, template.phases.map((phase) => phase.code));
    const check = pwfSchedule.scheduleProject({ tasks: wanted, plannedStart, calendars, statusDate: stored.status_date, baseline: baselineOfRows(rowsBefore) });
    if (inputHashOf({ tasks: wanted, plannedStart, calendars, statusDate: stored.status_date }) !== held.input_hash || resultHashOf(check) !== held.result_hash) throw conflict('INPUT_CHANGED');
    await this.applyOverrides(tx, workflow.id, project.id, stored.input, request.actor);
    if (stored.planned_start_date !== null) {
      await tx.query('update machvon.project_workflow set planned_start_date = $2::date where id = $1::uuid', [workflow.id, stored.planned_start_date]);
      await tx.query('update machvon.project set planned_start_date = $2::date, updated_at = now(), updated_by = $3::uuid where id = $1::uuid', [project.id, stored.planned_start_date, request.actor]);
    }
    await this.applyProgress(tx, workflow.id, stored.input);
    // The tasks that finish later than they did count a move of their date (BR-PWF-08, the KPI of reschedules).
    const moved = held.preview.changes.filter((change) => (change.finishShiftDays ?? 0) > 0).map((change) => change.code);
    if (moved.length > 0) await tx.query('update machvon.project_task set reschedule_count = reschedule_count + 1 where workflow_id = $1::uuid and task_code = any($2::text[])', [workflow.id, moved]);
    const published = await publishSchedule(tx, {
      workflow: { id: workflow.id, projectId: project.id, version: workflow.version, scheduleVersion: workflow.schedule_version },
      kind: 'RESCHEDULE',
      result: check,
      calendars,
      inputHash: held.input_hash,
      changes: held.preview.changes,
      reason: held.reason,
      proposedBy: held.proposed_by,
      approvedBy: request.actor,
      today,
      proposalId: held.id,
      baseline: this.baseline,
    });
    await tx.query(`update machvon.project_reschedule_proposal set status = 'APPROVED', decided_by = $2::uuid, decided_at = now(), decision_note = $3, version = version + 1 where id = $1::uuid`, [held.id, request.actor, note]);
    await logWorkflow(tx, { workflowId: workflow.id, kind: 'RESCHEDULE_DECIDED', actor: request.actor, reason: note, subject: { proposal_id: held.id, decision: 'APPROVE', schedule_version: published.scheduleVersion } });
    await logWorkflow(tx, { workflowId: workflow.id, kind: 'RESCHEDULED', actor: request.actor, reason: held.reason, subject: { proposal_id: held.id, schedule_version: published.scheduleVersion, result_hash: published.resultHash } });
    return { proposal: { ...toView(held, project.id), status: 'APPROVED' }, scheduleVersion: published.scheduleVersion, workflowVersion: published.workflowVersion, resultHash: published.resultHash };
  }

  /** The proposal as it is stored, for the screen of the decision: the preview, the reason and the status; a proposal of a project out of the scope does not exist (404). */
  async read(tx: TenantTx, scope: ScopeBuilder, proposalId: string): Promise<ProposalView> {
    if (!UUID.test(proposalId)) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const predicate = scope(2);
    const rows = await tx.query<ProposalSql & { project_id: string }>(
      `select ${PROPOSAL_COLUMNS}, w.project_id from ${SCOPE_FROM} join machvon.project_workflow w on w.tenant_id = p.tenant_id and w.project_id = p.id
         join machvon.project_reschedule_proposal pr on pr.tenant_id = w.tenant_id and pr.workflow_id = w.id where pr.id = $1::uuid and ${predicate.sql}`,
      [proposalId.toLowerCase(), ...predicate.params],
    );
    if (rows[0] === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return toView(rows[0], rows[0].project_id);
  }

  // ---- internals ------------------------------------------------------------------------------------------------------------------------------------------------------------------------

  private async lockWorkflow(tx: TenantTx, projectId: string): Promise<WorkflowSql> {
    await tx.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [`pwf:${projectId}`]);
    const rows = await tx.query<WorkflowSql>(
      `select id, project_id, status, version, schedule_version, planned_start_date::text as planned_start_date, template, calendar_pins from machvon.project_workflow where project_id = $1::uuid for update`,
      [projectId],
    );
    if (rows[0] === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return rows[0];
  }

  /** The changes of the project's own tasks and links, written when the proposal is approved; links are changed only under the override flag the database asks for. */
  private async applyOverrides(tx: TenantTx, workflowId: string, projectId: string, input: RescheduleInput, actor: string): Promise<void> {
    const overrides = input.overrides;
    if (overrides === undefined) return;
    await tx.query("select set_config('pwf.override', 'on', true)");
    try {
      // Every added task is written before any link: an added task may follow another that is added later in the same list.
      for (const added of overrides.add ?? []) {
        await tx.query(
          `insert into machvon.project_task (tenant_id, id, workflow_id, project_id, task_code, name, phase_code, sort_order, kind, required, responsible_role, priority, duration_working_days, own_task, created_by, updated_by)
           select nullif(current_setting('app.tenant_id', true), '')::uuid, gen_random_uuid(), $1::uuid, $2::uuid, $3, $4, $5, coalesce(max(sort_order), 0) + 1, $6, false, $7, 'NORMAL', $8::int, true, $9::uuid, $9::uuid
             from machvon.project_task where workflow_id = $1::uuid`,
          [workflowId, projectId, added.code, added.name, added.phase, added.kind, OWN_ROLE, added.durationWorkingDays, actor],
        );
      }
      for (const added of overrides.add ?? []) await this.writeLinks(tx, workflowId, added.code, added.predecessors ?? []);
      for (const change of overrides.change ?? []) {
        if (change.durationWorkingDays !== undefined) await tx.query('update machvon.project_task set duration_working_days = $3::int, updated_at = now(), updated_by = $4::uuid, version = version + 1 where workflow_id = $1::uuid and task_code = $2', [workflowId, change.taskCode, change.durationWorkingDays, actor]);
        if (change.predecessors !== undefined) {
          await tx.query('delete from machvon.project_task_dependency d using machvon.project_task t where t.workflow_id = $1::uuid and t.task_code = $2 and d.task_id = t.id and d.tenant_id = t.tenant_id', [workflowId, change.taskCode]);
          await this.writeLinks(tx, workflowId, change.taskCode, change.predecessors);
        }
      }
      for (const code of overrides.remove ?? []) await tx.query("update machvon.project_task set excluded = true, updated_at = now(), updated_by = $3::uuid, version = version + 1 where workflow_id = $1::uuid and task_code = $2 and status = 'NOT_STARTED'", [workflowId, code, actor]);
    } finally {
      await tx.query("select set_config('pwf.override', 'off', true)");
    }
    await logWorkflow(tx, { workflowId, kind: 'OVERRIDDEN', actor, subject: { added: (overrides.add ?? []).map((one) => one.code), changed: (overrides.change ?? []).map((one) => one.taskCode), removed: [...(overrides.remove ?? [])] } });
  }

  private async writeLinks(tx: TenantTx, workflowId: string, taskCode: string, links: readonly LinkInput[]): Promise<void> {
    if (links.length === 0) return;
    await tx.query(
      `insert into machvon.project_task_dependency (tenant_id, workflow_id, task_id, predecessor_id, kind, lag_working_days)
       select nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, t.id, p.id, x.kind, x.lag
         from jsonb_to_recordset($3::jsonb) as x(task text, kind text, lag int)
         join machvon.project_task t on t.workflow_id = $1::uuid and t.task_code = $2
         join machvon.project_task p on p.workflow_id = $1::uuid and p.task_code = x.task`,
      [workflowId, taskCode, JSON.stringify(links.map((link) => ({ task: link.task, kind: link.kind, lag: link.lagWorkingDays })))],
    );
  }

  /** The progress a person can say about an open task: the days that are left and the percent done (never a finish: a task is finished by completing it). */
  private async applyProgress(tx: TenantTx, workflowId: string, input: RescheduleInput): Promise<void> {
    for (const one of input.progress ?? []) {
      // A property that is left out stays as it is; one that is given as null clears it, as the preview took it (the same schedule is published and kept).
      await tx.query(
        `update machvon.project_task
            set remaining_working_days = case when $3::boolean then $4::int else remaining_working_days end, percent_complete = case when $5::boolean then $6::int else percent_complete end,
                actual_start = case when status = 'IN_PROGRESS' and actual_start is null then coalesce($7::date, actual_start) else actual_start end, updated_at = now(), version = version + 1
          where workflow_id = $1::uuid and task_code = $2 and status in ('IN_PROGRESS', 'ON_HOLD')`,
        [workflowId, one.taskCode, one.remainingWorkingDays !== undefined, one.remainingWorkingDays ?? null, one.percentComplete !== undefined, one.percentComplete ?? null, one.actualStart ?? null],
      );
    }
  }
}
