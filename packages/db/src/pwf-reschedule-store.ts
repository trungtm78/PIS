import { randomUUID } from 'node:crypto';
import { DomainError, hasControlCharExceptWhitespace, processCore, pwfSchedule, pwfWorkflow, vietnamDateOf, versionConflict } from '@machvon/kernel';
import { PrjBaselineStore } from './prj-baseline-store.ts';
import { SCOPE_FROM } from './prj-project-store.ts';
import type { ScopeBuilder } from './scope-version.ts';
import { dateOf, lockProject } from './prj-stage-support.ts';
import type { StageScopes } from './prj-stage-support.ts';
import { MAX_LIMIT_VALUE, checkedExtensions, extensionRefusal, extensionRequired, extensionRulesOf, extensionSums, judgeExtensions, raisedLimit, refusalDetails } from './pwf-extension.ts';
import type { ExtensionLine, ExtensionRules } from './pwf-extension.ts';
import { logWorkflow, publishSchedule, resultHashOf } from './pwf-publish.ts';
import { baselineOfRows, dueOf, earliestYear, inputHashOf, loadLinks, loadTasks, pinPublishedCalendars, resultOfRows, scheduleTasksOf } from './pwf-schedule-support.ts';
import type { PinnedCalendar, TaskLink, TaskRow } from './pwf-schedule-support.ts';
import type { TenantTx } from './tenant-database.ts';

/**
 * Moving the schedule (PWF-2, docs PWF 3 F6, BR-PWF-08, 28, R32): a manager proposes a change (the planned start, progress, tasks of the project's own, links, durations, a newer working calendar); the preview is computed on
 * what is not done, the baseline untouched, and kept with the hashes of its input and result. Another person decides it: approval publishes the new version of the schedule in one transaction under the lock of the project, and
 * only when the workflow is still at the version the preview was made on; two people who move the schedule at once cannot both win (409 `PWF_SCHEDULE_VERSION_CONFLICT`).
 *
 * R72 (docs PWF 22.4): a proposal may EXTEND the limit of tasks (`extensions`), in the unit of each task. The caps of the frozen template are judged on the whole proposal when it is made and again when it is approved; only
 * the approval spends them, in the transaction of the publication. Raising the limit of a task that has an extension rule through `overrides.change` is refused (`PWF_EXTENSION_REQUIRED`): there is no way around the count.
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
    /** `durationValue` is the limit of a task that has a `duration`, in its own unit; `durationWorkingDays` is the limit of a task that has none (or whose unit is the working day). */
    change?: ReadonlyArray<{ taskCode: string; durationWorkingDays?: number | undefined; durationValue?: number | undefined; predecessors?: readonly LinkInput[] | undefined }> | undefined;
    remove?: readonly string[] | undefined;
  } | undefined;
  /** R72: the limit of each named task is raised by `addValue`, in the unit of its extension rule; several lines may name one task. */
  extensions?: readonly ExtensionLine[] | undefined;
  reason: string;
}

/** Why the days of a task move in a proposal (R72): its own limit is extended by the proposal, or it follows something else (a predecessor, the calendar, the start day). A task the proposal changes itself in another way has none. */
export type ChangeCause = 'EXTENDED' | 'CASCADED';
export type ProposalChange = pwfSchedule.ScheduleChange & { cause?: ChangeCause };
export interface ProposalExtension {
  taskCode: string;
  addValue: number;
  unit: pwfWorkflow.DurationUnit;
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
  preview: { schedule: pwfSchedule.ScheduleResult; changes: ProposalChange[]; projectFinishShiftDays: number | null; excluded: string[]; names: Record<string, string>; phases: Record<string, string>; extensions?: ProposalExtension[] };
  /** The extensions the proposal asks for, line by line (empty when it asks for none). */
  extensions: ProposalExtension[];
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
  extensions: row.preview.extensions ?? [],
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

/**
 * What a line of `overrides.change` does to the limit of its task. A task that has a `duration` follows it, so its limit is changed in its own unit (`durationValue`; `durationWorkingDays` is the same number only when the unit is
 * the working day, and is refused for a limit in calendar days or months, where it would change nothing of the schedule). A raise of a task whose frozen template declares an extension rule is an extension, refused here.
 */
function limitChange(row: TaskRow | undefined, one: { durationWorkingDays?: number | undefined; durationValue?: number | undefined }, index: number, rules: ExtensionRules): Partial<pwfSchedule.ScheduleTask> {
  const at = `overrides.change[${index}]`;
  if (one.durationValue === undefined && one.durationWorkingDays === undefined) return {};
  if (row === undefined) {
    // A task the same proposal adds: it has no limit in a unit of its own yet.
    if (one.durationValue !== undefined) throw invalid(`${at}.duration_value`);
    return { durationWorkingDays: one.durationWorkingDays as number };
  }
  let next: Partial<pwfSchedule.ScheduleTask>;
  let raised: boolean;
  if (one.durationValue !== undefined) {
    const value = one.durationValue;
    if (one.durationWorkingDays !== undefined) throw invalid(`${at}.duration_working_days`);
    if (row.duration === null || !Number.isInteger(value) || value < 1 || value > MAX_LIMIT_VALUE) throw invalid(`${at}.duration_value`);
    next = { durationWorkingDays: pwfWorkflow.nominalWorkingDays({ value, unit: row.duration.unit }), duration: { ...row.duration, value } };
    raised = value > row.duration.value;
  } else if (row.duration !== null) {
    const days = one.durationWorkingDays as number;
    if (row.duration.unit !== 'WORKING_DAY' || !Number.isInteger(days) || days < 1 || days > MAX_LIMIT_VALUE) throw invalid(`${at}.duration_working_days`);
    next = { durationWorkingDays: days, duration: { ...row.duration, value: days } };
    raised = days > row.duration.value;
  } else {
    next = { durationWorkingDays: one.durationWorkingDays as number };
    raised = (one.durationWorkingDays as number) > row.durationWorkingDays;
  }
  const rule = rules.get(row.code);
  if (raised && rule !== undefined && rule !== null) throw extensionRequired(row.code, rule);
  return next;
}

/**
 * The tasks as the preview takes them: the progress given (only what the person can say about an open task), then the overrides of the project, then the extensions (R72: each named task with its limit raised in its own unit).
 * The same function judges a proposal when it is made and when it is approved. `rules` is what the frozen template says of extensions; whether the extensions fit the caps is judged by the caller (`judgeExtensions`).
 */
export function proposedTasks(rows: readonly TaskRow[], links: readonly TaskLink[], input: RescheduleInput, phases: readonly string[], rules: ExtensionRules = new Map()): pwfSchedule.ScheduleTask[] {
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
  const lines = checkedExtensions(input.extensions);
  const overridden = overriddenTasks(base, rows, input, phases, rules);
  if (lines.length === 0) return overridden;
  // An extension is the one change of the limit of its task in a proposal: a line of `change` for the same limit, or the removal of the task, would make two answers to "what is the limit now".
  const touched = new Set([...(input.overrides?.change ?? []).filter((one) => one.durationWorkingDays !== undefined || one.durationValue !== undefined).map((one) => one.taskCode), ...(input.overrides?.remove ?? [])]);
  const sums = extensionSums(lines);
  return overridden.map((one) => {
    const sum = sums.get(one.code);
    if (sum === undefined) return one;
    const index = lines.findIndex((line) => line.taskCode === one.code);
    if (touched.has(one.code)) throw invalid(`extensions[${index}].task_code`);
    const raised = raisedLimit(one, sum.value);
    if (raised === null) throw invalid(`extensions[${index}].add_value`);
    return { ...one, ...raised };
  });
}

function overriddenTasks(base: pwfSchedule.ScheduleTask[], rows: readonly TaskRow[], input: RescheduleInput, phases: readonly string[], rules: ExtensionRules): pwfSchedule.ScheduleTask[] {
  const overrides = input.overrides;
  if (overrides === undefined) return base;
  for (const added of overrides.add ?? []) if (!CODE.test(added.code) || !phases.includes(added.phase)) throw invalid('overrides.add');
  const change: Record<string, Partial<pwfSchedule.ScheduleTask>> = {};
  for (const [index, one] of (overrides.change ?? []).entries()) {
    change[one.taskCode] = { ...limitChange(rows.find((row) => row.code === one.taskCode), one, index, rules), ...(one.predecessors === undefined ? {} : { predecessors: checkedLinks(one.predecessors, 'overrides.change') }) };
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

/**
 * The changes of a preview with the cause of each task whose days move (R72): `EXTENDED` when the proposal extends the limit of that very task, `CASCADED` when the task only follows (a predecessor, the calendar, the start
 * day). A task the proposal changes itself in another way (its progress, a line of `change`, its removal) has no cause, and neither has a row whose days stay (only its float or its place on the critical path changed).
 */
export function causedChanges(diff: readonly pwfSchedule.ScheduleChange[], before: pwfSchedule.ScheduleResult, after: pwfSchedule.ScheduleResult, input: RescheduleInput): ProposalChange[] {
  const extended = new Set((input.extensions ?? []).map((one) => one.taskCode));
  const direct = new Set([...(input.progress ?? []).map((one) => one.taskCode), ...(input.overrides?.change ?? []).map((one) => one.taskCode), ...(input.overrides?.remove ?? [])]);
  const was = new Map(before.tasks.map((one) => [one.code, one] as const));
  const now = new Map(after.tasks.map((one) => [one.code, one] as const));
  return diff.map((change): ProposalChange => {
    const [left, right] = [was.get(change.code), now.get(change.code)];
    const moved = left !== undefined && right !== undefined && (left.start !== right.start || left.finish !== right.finish);
    if (!moved) return change;
    if (extended.has(change.code)) return { ...change, cause: 'EXTENDED' };
    return direct.has(change.code) ? change : { ...change, cause: 'CASCADED' };
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
    // R72: the extensions are judged on the whole proposal against what approved extensions used so far; a proposal that does not fit is not kept at all.
    const rules = extensionRulesOf(template);
    const lines = checkedExtensions(request.input.extensions);
    const verdict = judgeExtensions(rows, rules, lines);
    if (!verdict.ok) throw extensionRefusal(verdict, lines);
    const tasks = proposedTasks(rows, links, request.input, template.phases.map((phase) => phase.code), rules);
    const first = request.input.plannedStartDate === undefined ? undefined : plannedStart;
    const input = { tasks, plannedStart, calendars, statusDate };
    // R49: a proposal asks to move the days that were RELEASED (the official deadlines), so what moves is measured against them, never against the forecast a recomputation left behind.
    const released = resultOfRows(rows, 'COMMITTED');
    const rescheduled = pwfSchedule.rescheduleProject({ before: released, input, baseline: baselineOfRows(rows) });
    const before = rows.filter((row) => !row.excluded).map((row) => dueOf(row)).filter((day): day is string => day !== null).sort().pop() ?? null;
    const projectFinishShiftDays = before === null || rescheduled.schedule.projectFinish === null ? null : (processCore.workingDaysBetween(sourceOf(calendars), before, rescheduled.schedule.projectFinish) ?? null);
    const names = Object.fromEntries([...rows.map((row) => [row.code, row.name] as const), ...(request.input.overrides?.add ?? []).map((one) => [one.code, one.name] as const)]);
    const phases = Object.fromEntries([...rows.map((row) => [row.code, row.phaseCode] as const), ...(request.input.overrides?.add ?? []).map((one) => [one.code, one.phase] as const)]);
    const id = randomUUID();
    const stored = { planned_start_date: first ?? null, status_date: statusDate, input: request.input };
    const preview: ProposalView['preview'] = {
      schedule: rescheduled.schedule,
      changes: causedChanges(rescheduled.diff, released, rescheduled.schedule, request.input),
      projectFinishShiftDays,
      excluded: tasks.filter((one) => one.excluded === true).map((one) => one.code),
      names,
      phases,
      // A proposal without extensions keeps the preview it always had.
      ...(lines.length === 0 ? {} : { extensions: lines.map((line) => ({ taskCode: line.taskCode, addValue: line.addValue, unit: (rules.get(line.taskCode) as pwfWorkflow.TemplateExtension).unit })) }),
    };
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
   *
   * R72: the extensions are judged again on the counters as they are NOW. A proposal that no longer fits (a cap spent since, a task closed since) is not applied, not even in part: 409 `PWF_SCHEDULE_VERSION_CONFLICT` with
   * the reason `EXTENSION_REFUSED`, the code of the kernel (`extension_code`) and its details. The proposal stays PROPOSED, as one whose preview went stale does: it can never be approved (a cap is never given back), and
   * closing it is the decision of a person (REJECT, with their name and note), not something the refusal of a command does on its own. Only an approval spends the caps, in this transaction, with the publication.
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
    const rules = extensionRulesOf(template);
    const lines = checkedExtensions(stored.input.extensions);
    const verdict = judgeExtensions(rowsBefore, rules, lines);
    if (!verdict.ok) {
      const first = verdict.refusals[0] as (typeof verdict.refusals)[number];
      throw conflict('EXTENSION_REFUSED', { extension_code: first.code, ...refusalDetails(first), refusals: verdict.refusals.map((one) => ({ code: one.code, ...refusalDetails(one) })) });
    }
    const wanted = proposedTasks(rowsBefore, linksBefore, stored.input, template.phases.map((phase) => phase.code), rules);
    const check = pwfSchedule.scheduleProject({ tasks: wanted, plannedStart, calendars, statusDate: stored.status_date, baseline: baselineOfRows(rowsBefore) });
    if (inputHashOf({ tasks: wanted, plannedStart, calendars, statusDate: stored.status_date }) !== held.input_hash || resultHashOf(check) !== held.result_hash) throw conflict('INPUT_CHANGED');
    await this.applyOverrides(tx, workflow.id, project.id, stored.input, request.actor, wanted);
    await this.applyExtensions(tx, workflow.id, rowsBefore, lines, wanted, { actor: request.actor, proposalId: held.id, reason: held.reason });
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
  private async applyOverrides(tx: TenantTx, workflowId: string, projectId: string, input: RescheduleInput, actor: string, wanted: readonly pwfSchedule.ScheduleTask[]): Promise<void> {
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
        // The limit as the preview took it: the working days, and for a task with a limit in its own unit that limit too (the scheduler follows it).
        const limit = change.durationWorkingDays === undefined && change.durationValue === undefined ? undefined : wanted.find((one) => one.code === change.taskCode);
        if (limit !== undefined) {
          await tx.query(
            'update machvon.project_task set duration_working_days = $3::int, duration_value = case when duration_value is null then null else $4::int end, updated_at = now(), updated_by = $5::uuid, version = version + 1 where workflow_id = $1::uuid and task_code = $2',
            [workflowId, change.taskCode, limit.durationWorkingDays, limit.duration?.value ?? null, actor],
          );
        }
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

  /**
   * R72: what an approved proposal does to the tasks it extends, in the transaction of the publication: the limit of the task in its own unit (and the nominal working days beside it), and the two counters of its caps: one
   * time per line, the values added up. Only the tasks the proposal names are touched: a task that merely follows keeps its counters. The log of each task keeps the extension (`TASK_EXTENDED`).
   */
  private async applyExtensions(tx: TenantTx, workflowId: string, rows: readonly TaskRow[], lines: readonly ExtensionLine[], wanted: readonly pwfSchedule.ScheduleTask[], by: { actor: string; proposalId: string; reason: string }): Promise<void> {
    if (lines.length === 0) return;
    await tx.query("select set_config('pwf.extension', 'on', true)");
    try {
      for (const [code, sum] of extensionSums(lines)) {
        const row = rows.find((one) => one.code === code) as TaskRow;
        const limit = wanted.find((one) => one.code === code) as pwfSchedule.ScheduleTask;
        await tx.query(
          `update machvon.project_task
              set duration_working_days = $3::int, duration_value = case when duration_value is null then null else $4::int end,
                  extension_times_used = extension_times_used + $5::int, extension_value_used = extension_value_used + $6::int, updated_at = now(), updated_by = $7::uuid, version = version + 1
            where workflow_id = $1::uuid and task_code = $2`,
          [workflowId, code, limit.durationWorkingDays, limit.duration?.value ?? null, sum.times, sum.value, by.actor],
        );
        await logWorkflow(tx, {
          workflowId,
          taskId: row.id,
          kind: 'TASK_EXTENDED',
          actor: by.actor,
          reason: by.reason,
          subject: {
            proposal_id: by.proposalId,
            task_code: code,
            lines: sum.times,
            add_value: sum.value,
            unit: row.duration?.unit ?? 'WORKING_DAY',
            limit_before: row.duration?.value ?? row.durationWorkingDays,
            limit_after: limit.duration?.value ?? limit.durationWorkingDays,
            times_used: row.extensionTimesUsed + sum.times,
            value_used: row.extensionValueUsed + sum.value,
          },
        });
      }
    } finally {
      await tx.query("select set_config('pwf.extension', 'off', true)");
    }
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
