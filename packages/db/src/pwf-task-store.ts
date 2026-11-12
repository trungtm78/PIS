import { randomUUID } from 'node:crypto';
import { DomainError, hasControlCharExceptWhitespace, pwfSchedule, pwfWorkflow, versionConflict } from '@machvon/kernel';
import { SCOPE_FROM } from './prj-project-store.ts';
import { PrjBaselineStore } from './prj-baseline-store.ts';
import { dateOf } from './prj-stage-support.ts';
import type { StageScopes } from './prj-stage-support.ts';
import { logWorkflow, publishSchedule, resultHashOf, syncMilestones } from './pwf-publish.ts';
import { TASK_COLUMNS, baselineOfRows, earliestYear, ownTaskDefinition, inputHashOf, loadLinks, loadPinnedCalendars, loadTasks, pinPublishedCalendars, pinsFromJson, resultOfRows, scheduleTasksOf, toTaskRow } from './pwf-schedule-support.ts';
import type { TaskRow } from './pwf-schedule-support.ts';
import type { TenantTx } from './tenant-database.ts';

/**
 * The commands on one task of a project workflow (PWF-1, docs PWF 3 F4 and F5, section 4): start, evidence, checklist, completion, approval by a second person, return, exceptions (waive a requirement, cancel, pause, an external
 * delay) decided by a second person, resume, and the ledger of assignments. Every command locks the task under the scope of its own permission, judges the version the caller saw, moves the task along the state machine the
 * database enforces too, and leaves a row in the log. The person who does the work is never the one who approves it, and no exception covers that rule (BR-PWF-14).
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EXCLUSION_VIOLATION = '23P01';
const MIN_REASON = 20;
const MAX_REASON = 1000;
const ROLES = ['RESPONSIBLE', 'ACCOUNTABLE', 'CONSULTED', 'INFORMED'] as const;
const EXCEPTION_KINDS = ['WAIVE_REQUIREMENT', 'CANCEL_TASK', 'PAUSE', 'EXTERNAL_DELAY'] as const;
export type AssignmentRole = (typeof ROLES)[number];
export type ExceptionKind = (typeof EXCEPTION_KINDS)[number];

const invalid = (field: string): DomainError => new DomainError('VALIDATION_FAILED', 422, field);
const stateInvalid = (reason: string, extensions: Record<string, unknown> = {}): DomainError => new DomainError('PWF_TASK_STATE_INVALID', 409, 'status', { extensions: { reason, ...extensions } });
const idOf = (value: string, field: string): string => {
  if (!UUID.test(value)) throw invalid(field);
  return value.toLowerCase();
};

function textOf(value: string | undefined, field: string, min: number, max: number): string {
  const text = (value ?? '').trim();
  if (text.length < min || text.length > max || hasControlCharExceptWhitespace(text)) throw invalid(field);
  return text;
}

/** What a command on a task leaves: the audit row, the event and the answer are written from it (ids, codes, days; never words of people). */
export interface TaskResult {
  id: string;
  workflowId: string;
  projectId: string;
  taskCode: string;
  fromStatus: string;
  status: string;
  version: number;
  facts: Record<string, unknown>;
}

interface Locked {
  task: TaskRow;
  workflow: { id: string; status: string; template: pwfWorkflow.ProjectWorkflowTemplate; plannedStartDate: string; scheduleVersion: number; version: number; calendarPins: unknown; facts: pwfWorkflow.ProjectFacts };
  projectCode: string;
  definition: pwfWorkflow.TemplateTask | undefined;
}

interface LockSql {
  workflow_status: string;
  template: Record<string, unknown>;
  planned_start_date: string;
  schedule_version: number;
  workflow_version: number;
  calendar_pins: unknown;
  facts: pwfWorkflow.ProjectFacts;
  project_code: string;
}

export interface TaskCommand {
  taskId: string;
  expectedVersion: number;
  actor: string;
  scopes: StageScopes;
  today: string;
}

export interface EvidenceInput {
  evidenceKind: string;
  itemCode?: string | undefined;
  documentId?: string | undefined;
  legalDocType?: string | undefined;
  formTemplateCode?: string | undefined;
  externalRef?: string | undefined;
  note?: string | undefined;
}

export interface AssignInput {
  membershipId: string;
  role: string;
  validFrom: string;
  validTo?: string | null | undefined;
  sharePct: number;
  reason: string;
}

export class PwfTaskStore {
  private readonly baseline: PrjBaselineStore;

  constructor(baseline: PrjBaselineStore = new PrjBaselineStore()) {
    this.baseline = baseline;
  }

  // ---- commands --------------------------------------------------------------------------------------------------------------------------------------------------------------------------

  async start(tx: TenantTx, request: TaskCommand & { earlyStartReason?: string | undefined; actualStart?: string | undefined; note?: string | undefined; mayStartEarly?: boolean | undefined }): Promise<TaskResult> {
    const locked = await this.lock(tx, request.taskId, request.scopes, 'task_id');
    const { task } = locked;
    this.assertVersion(task, request.expectedVersion);
    this.assertOpenFor(locked, ['NOT_STARTED']);
    await this.assertAssignee(tx, task, request.actor, request.today, ['RESPONSIBLE', 'ACCOUNTABLE']);
    const start = request.actualStart === undefined ? request.today : dateOf(request.actualStart, 'actual_start');
    if (start > request.today) throw invalid('actual_start');
    const blocking = await this.blockingPredecessors(tx, task);
    const early = blocking.length > 0;
    let reason: string | null = null;
    if (early) {
      if (request.earlyStartReason === undefined) throw stateInvalid('PREDECESSORS_NOT_READY', { blocking });
      // Starting before the predecessors are ready is a decision of a manager of the project, not of whoever holds the task.
      if (request.mayStartEarly !== true) throw new DomainError('SCOPE_DENIED', 403, 'early_start_reason');
      reason = textOf(request.earlyStartReason, 'early_start_reason', MIN_REASON, 500);
    }
    await this.update(tx, task, { status: 'IN_PROGRESS', actual_start: start, early_start_reason: reason }, request.actor);
    await logWorkflow(tx, { workflowId: task.workflowId, taskId: task.id, kind: 'START', actor: request.actor, reason, subject: { task_code: task.code, actual_start: start, early: early } });
    return this.result(locked, 'NOT_STARTED', 'IN_PROGRESS', task.version + 1, { actual_start: start, early });
  }

  /** Attaches evidence to a task that is being worked on: a document, a legal document of a type the edition knows, a form made from a template, or a reference outside the system. Only added to, never changed. */
  async attachEvidence(tx: TenantTx, request: { taskId: string; actor: string; scopes: StageScopes; today: string; input: EvidenceInput }): Promise<TaskResult & { evidenceId: string }> {
    const locked = await this.lock(tx, request.taskId, request.scopes, 'task_id');
    const { task, definition } = locked;
    this.assertOpenFor(locked, ['IN_PROGRESS']);
    await this.assertAssignee(tx, task, request.actor, request.today, ['RESPONSIBLE', 'ACCOUNTABLE']);
    const { input } = request;
    const kind = textOf(input.evidenceKind, 'evidence_kind', 1, 60);
    if (input.legalDocType !== undefined && pwfWorkflow.resolveLegalDocType(input.legalDocType) === undefined) throw new DomainError('LEGAL_DOC_TYPE_UNKNOWN', 422, 'legal_doc_type');
    if (input.documentId === undefined && input.formTemplateCode === undefined && input.externalRef === undefined) throw invalid('document_id');
    if (input.itemCode !== undefined && !definition?.checklist.some((item) => item.code === input.itemCode)) throw invalid('item_code');
    let documentId: string | null = null;
    if (input.documentId !== undefined) {
      documentId = idOf(input.documentId, 'document_id');
      const found = await tx.query<{ id: string }>('select id from machvon.document where id = $1::uuid', [documentId]);
      if (found[0] === undefined) throw invalid('document_id');
    }
    const id = randomUUID();
    await tx.query(
      `insert into machvon.project_task_evidence (tenant_id, id, task_id, item_code, evidence_kind, document_id, legal_doc_type, form_template_code, external_ref, note, attached_by)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3, $4, $5::uuid, $6, $7, $8, $9, $10::uuid)`,
      [id, task.id, input.itemCode ?? null, kind, documentId, input.legalDocType ?? null, input.formTemplateCode ?? null, input.externalRef ?? null, input.note ?? null, request.actor],
    );
    await logWorkflow(tx, { workflowId: task.workflowId, taskId: task.id, kind: 'EVIDENCE_ATTACHED', actor: request.actor, subject: { task_code: task.code, evidence_kind: kind, item_code: input.itemCode ?? null, legal_doc_type: input.legalDocType ?? null } });
    return { ...this.result(locked, task.status, task.status, task.version, { evidence_kind: kind }), evidenceId: id };
  }

  async completeChecklistItem(tx: TenantTx, request: TaskCommand & { itemCode: string; evidenceId?: string | undefined; note?: string | undefined }): Promise<TaskResult> {
    const locked = await this.lock(tx, request.taskId, request.scopes, 'task_id');
    const { task } = locked;
    this.assertVersion(task, request.expectedVersion);
    this.assertOpenFor(locked, ['IN_PROGRESS']);
    await this.assertAssignee(tx, task, request.actor, request.today, ['RESPONSIBLE', 'ACCOUNTABLE']);
    const items = await tx.query<{ id: string; done: boolean; evidence_kinds: string[] }>('select id, done, evidence_kinds from machvon.project_task_checklist_item where task_id = $1::uuid and item_code = $2 for update', [task.id, request.itemCode]);
    const item = items[0];
    if (item === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (item.done) throw stateInvalid('ITEM_DONE', { item_code: request.itemCode });
    if (item.evidence_kinds.length > 0) {
      const evidenceId = request.evidenceId === undefined ? null : idOf(request.evidenceId, 'evidence_id');
      const held = await tx.query<{ id: string }>(
        `select id from machvon.project_task_evidence where task_id = $1::uuid and item_code = $2 and evidence_kind = any($3::text[]) and ($4::uuid is null or id = $4::uuid) limit 1`,
        [task.id, request.itemCode, item.evidence_kinds, evidenceId],
      );
      if (held[0] === undefined) throw new DomainError('PWF_TASK_COMPLETION_BLOCKED', 422, 'evidence_id', { extensions: { blockers: [{ code: 'EVIDENCE_MISSING', subject: request.itemCode }] } });
    }
    await tx.query('update machvon.project_task_checklist_item set done = true, done_by = $2::uuid, done_at = now(), version = version + 1 where id = $1::uuid', [item.id, request.actor]);
    await this.update(tx, task, {}, request.actor);
    await logWorkflow(tx, { workflowId: task.workflowId, taskId: task.id, kind: 'CHECKLIST_DONE', actor: request.actor, subject: { task_code: task.code, item_code: request.itemCode } });
    return this.result(locked, task.status, task.status, task.version + 1, { item_code: request.itemCode });
  }

  /**
   * Asks for the completion: `assessTaskCompletion` over the checklist, the evidence, the legal documents and the forms; what is missing is 422 `PWF_TASK_COMPLETION_BLOCKED` with the blockers, unless an approved exception of the
   * kind WAIVE_REQUIREMENT, named by the caller, covers it. A task with an approver role waits for the approval of a second person; one without is done.
   */
  async complete(tx: TenantTx, request: TaskCommand & { actualFinish?: string | undefined; actualVnd?: string | undefined; exceptionId?: string | undefined; note?: string | undefined }): Promise<TaskResult> {
    const locked = await this.lock(tx, request.taskId, request.scopes, 'task_id');
    const { task, definition } = locked;
    this.assertVersion(task, request.expectedVersion);
    this.assertOpenFor(locked, ['IN_PROGRESS']);
    if (definition === undefined) throw stateInvalid('TASK_WITHOUT_DEFINITION');
    await this.assertAssignee(tx, task, request.actor, request.today, ['RESPONSIBLE', 'ACCOUNTABLE']);
    const waiver = request.exceptionId === undefined ? null : await this.waiverOf(tx, task, idOf(request.exceptionId, 'exception_id'));
    const makers = await this.makersOf(tx, task, request.actor);
    const assessment = pwfWorkflow.assessTaskCompletion(definition, { ...(await this.completionState(tx, task, request.actor, makers)), exceptionApproved: false });
    // The approver is not known until someone approves: who may approve is judged then (approveCompletion), never here. A waiver covers only what it names: the item, the type of document or the form (BR-PWF-14).
    const waived = new Set(waiver?.items ?? []);
    const blockers = assessment.blockers.filter((one) => one.code !== 'APPROVER_REQUIRED' && one.code !== 'MAKER_IS_APPROVER' && !(waived.has(one.subject) && assessment.coverable.some((covered) => covered.code === one.code && covered.subject === one.subject)));
    if (blockers.length > 0) throw new DomainError('PWF_TASK_COMPLETION_BLOCKED', 422, 'status', { extensions: { blockers, coverable: assessment.coverable } });
    const finish = request.actualFinish === undefined ? request.today : dateOf(request.actualFinish, 'actual_finish');
    if (finish > request.today || (task.actualStart !== null && finish < task.actualStart)) throw invalid('actual_finish');
    const actualVnd = request.actualVnd === undefined ? null : request.actualVnd;
    if (actualVnd !== null && !/^\d{1,24}$/.test(actualVnd)) throw invalid('actual_vnd');
    const awaiting = definition.approverRole !== null;
    const status = awaiting ? 'AWAITING_APPROVAL' : 'DONE';
    await this.update(tx, task, { status, actual_finish: finish, ...(actualVnd === null ? {} : { actual_vnd: actualVnd }), completion_requested_by: request.actor, completion_requested_at: new Date().toISOString() }, request.actor);
    let version = task.version + 1;
    if (waiver !== null) await tx.query(`update machvon.project_task_exception set status = 'USED', version = version + 1 where id = $1::uuid`, [waiver.id]);
    await logWorkflow(tx, { workflowId: task.workflowId, taskId: task.id, kind: awaiting ? 'COMPLETE_REQUESTED' : 'COMPLETED', actor: request.actor, subject: { task_code: task.code, actual_finish: finish, waived: waiver !== null } });
    if (!awaiting) version = await this.afterDone(tx, locked, request.actor, request.today);
    return this.result(locked, 'IN_PROGRESS', status, version, { actual_finish: finish, waived: waiver !== null });
  }

  async approveCompletion(tx: TenantTx, request: TaskCommand & { note?: string | undefined }): Promise<TaskResult> {
    const locked = await this.lock(tx, request.taskId, request.scopes, 'task_id');
    const { task } = locked;
    this.assertVersion(task, request.expectedVersion);
    this.assertOpenFor(locked, ['AWAITING_APPROVAL']);
    await this.assertNotMaker(tx, task, request.actor);
    await this.update(tx, task, { status: 'DONE', approved_by: request.actor, approved_at: new Date().toISOString() }, request.actor);
    await logWorkflow(tx, { workflowId: task.workflowId, taskId: task.id, kind: 'APPROVED', actor: request.actor, reason: request.note ?? null, subject: { task_code: task.code } });
    const version = await this.afterDone(tx, locked, request.actor, request.today);
    return this.result(locked, 'AWAITING_APPROVAL', 'DONE', version, {});
  }

  async returnTask(tx: TenantTx, request: TaskCommand & { reason: string }): Promise<TaskResult> {
    const locked = await this.lock(tx, request.taskId, request.scopes, 'task_id');
    const { task } = locked;
    this.assertVersion(task, request.expectedVersion);
    this.assertOpenFor(locked, ['AWAITING_APPROVAL']);
    const reason = textOf(request.reason, 'reason', MIN_REASON, 500);
    await this.assertNotMaker(tx, task, request.actor);
    await this.update(tx, task, { status: 'IN_PROGRESS', return_count: task.returnCount + 1, actual_finish: null, completion_requested_by: null, completion_requested_at: null }, request.actor);
    await logWorkflow(tx, { workflowId: task.workflowId, taskId: task.id, kind: 'RETURNED', actor: request.actor, reason, subject: { task_code: task.code, return_count: task.returnCount + 1 } });
    return this.result(locked, 'AWAITING_APPROVAL', 'IN_PROGRESS', task.version + 1, { return_count: task.returnCount + 1 });
  }

  async requestException(
    tx: TenantTx,
    request: { taskId: string; actor: string; scopes: StageScopes; today: string; kind: string; items?: readonly string[] | undefined; validFrom?: string | undefined; validTo?: string | null | undefined; reason: string; evidenceRef?: string | undefined },
  ): Promise<TaskResult & { exceptionId: string }> {
    const locked = await this.lock(tx, request.taskId, request.scopes, 'task_id');
    const { task } = locked;
    if (!(EXCEPTION_KINDS as readonly string[]).includes(request.kind)) throw invalid('kind');
    const kind = request.kind as ExceptionKind;
    this.assertOpenFor(locked, kind === 'PAUSE' ? ['IN_PROGRESS'] : ['NOT_STARTED', 'IN_PROGRESS', 'AWAITING_APPROVAL', 'ON_HOLD']);
    const reason = textOf(request.reason, 'reason', MIN_REASON, MAX_REASON);
    const items = [...new Set(request.items ?? [])];
    if (kind === 'WAIVE_REQUIREMENT' ? items.length === 0 || items.some((one) => one.length === 0 || one.length > 80) : items.length > 0) throw new DomainError('PWF_EXCEPTION_INVALID', 422, 'items');
    const from = request.validFrom === undefined ? request.today : dateOf(request.validFrom, 'valid_from');
    const to = request.validTo === undefined || request.validTo === null ? null : dateOf(request.validTo, 'valid_to');
    if (to !== null && to < from) throw new DomainError('PWF_EXCEPTION_INVALID', 422, 'valid_to');
    const id = randomUUID();
    await tx.query(
      `insert into machvon.project_task_exception (tenant_id, id, task_id, kind, items, valid_from, valid_to, reason, evidence_ref, requested_by)
       values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3, $4::jsonb, $5::date, $6::date, $7, $8, $9::uuid)`,
      [id, task.id, kind, JSON.stringify(items), from, to, reason, request.evidenceRef ?? null, request.actor],
    );
    await logWorkflow(tx, { workflowId: task.workflowId, taskId: task.id, kind: 'EXCEPTION_REQUESTED', actor: request.actor, reason, subject: { task_code: task.code, exception_id: id, exception_kind: kind } });
    return { ...this.result(locked, task.status, task.status, task.version, { exception_id: id, exception_kind: kind }), exceptionId: id };
  }

  /** Decides an exception: the decider is not the requester (403 `SELF_APPROVAL_DENIED`); an approved pause puts the task on hold, an approved cancellation cancels it, a waiver and an external delay are kept for the completion and the KPI. */
  async decideException(tx: TenantTx, request: { exceptionId: string; expectedVersion: number; decision: string; note?: string | undefined; actor: string; scopes: StageScopes; today: string }): Promise<TaskResult & { exceptionId: string; exceptionKind: string; exceptionStatus: string }> {
    const id = idOf(request.exceptionId, 'id');
    const found = await tx.query<{ task_id: string }>('select task_id from machvon.project_task_exception where id = $1::uuid', [id]);
    if (found[0] === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const locked = await this.lock(tx, found[0].task_id, request.scopes, 'id');
    const { task } = locked;
    const rows = await tx.query<{ kind: ExceptionKind; status: string; requested_by: string; version: number }>('select kind, status, requested_by, version from machvon.project_task_exception where id = $1::uuid for update', [id]);
    const held = rows[0] as { kind: ExceptionKind; status: string; requested_by: string; version: number };
    if (held.version !== request.expectedVersion) throw versionConflict(held.version);
    if (held.requested_by === request.actor) throw new DomainError('SELF_APPROVAL_DENIED', 403);
    if (held.status !== 'REQUESTED') throw new DomainError('PWF_EXCEPTION_INVALID', 422, 'status', { extensions: { exception_status: held.status } });
    if (request.decision !== 'APPROVE' && request.decision !== 'REJECT') throw invalid('decision');
    const note = request.note === undefined ? null : textOf(request.note, 'note', 5, 500);
    const approve = request.decision === 'APPROVE';
    let status = task.status;
    if (approve && held.kind === 'PAUSE') {
      this.assertOpenFor(locked, ['IN_PROGRESS']);
      status = 'ON_HOLD';
      await this.update(tx, task, { status }, request.actor);
    } else if (approve && held.kind === 'CANCEL_TASK') {
      this.assertOpenFor(locked, ['NOT_STARTED', 'IN_PROGRESS', 'AWAITING_APPROVAL', 'ON_HOLD']);
      status = 'CANCELLED';
      await this.update(tx, task, { status, cancelled_by: request.actor, cancelled_at: new Date().toISOString() }, request.actor);
    }
    await tx.query(
      `update machvon.project_task_exception set status = $2, decided_by = $3::uuid, decided_at = now(), decision_note = $4, version = version + 1 where id = $1::uuid`,
      [id, approve ? 'APPROVED' : 'REJECTED', request.actor, note],
    );
    await logWorkflow(tx, { workflowId: task.workflowId, taskId: task.id, kind: 'EXCEPTION_DECIDED', actor: request.actor, reason: note, subject: { task_code: task.code, exception_id: id, exception_kind: held.kind, decision: request.decision } });
    if (approve && held.kind === 'PAUSE') await logWorkflow(tx, { workflowId: task.workflowId, taskId: task.id, kind: 'PAUSE_APPROVED', actor: request.actor, subject: { task_code: task.code, exception_id: id } });
    if (status === 'CANCELLED') {
      await logWorkflow(tx, { workflowId: task.workflowId, taskId: task.id, kind: 'CANCELLED', actor: request.actor, subject: { task_code: task.code, exception_id: id } });
      await refreshSchedule(tx, locked.workflow, task.projectId, request.actor, request.today, this.baseline);
    }
    const changed = status !== task.status;
    const version = status === 'CANCELLED' ? await this.currentVersion(tx, task.id) : changed ? task.version + 1 : task.version;
    return { ...this.result(locked, task.status, status, version, { exception_id: id, exception_kind: held.kind, decision: request.decision }), exceptionId: id, exceptionKind: held.kind, exceptionStatus: approve ? 'APPROVED' : 'REJECTED' };
  }

  async resume(tx: TenantTx, request: TaskCommand): Promise<TaskResult> {
    const locked = await this.lock(tx, request.taskId, request.scopes, 'task_id');
    const { task } = locked;
    this.assertVersion(task, request.expectedVersion);
    this.assertOpenFor(locked, ['ON_HOLD']);
    await this.assertAssignee(tx, task, request.actor, request.today, ['RESPONSIBLE', 'ACCOUNTABLE']);
    await this.update(tx, task, { status: 'IN_PROGRESS' }, request.actor);
    // The period the pause excused ends today: it is the only thing an approved exception may still gain.
    await tx.query(`update machvon.project_task_exception set valid_to = $2::date where task_id = $1::uuid and kind = 'PAUSE' and status = 'APPROVED' and valid_to is null`, [task.id, request.today]);
    await logWorkflow(tx, { workflowId: task.workflowId, taskId: task.id, kind: 'RESUMED', actor: request.actor, subject: { task_code: task.code } });
    return this.result(locked, 'ON_HOLD', 'IN_PROGRESS', task.version + 1, {});
  }

  /** Adds a line to the ledger of assignments (only added to): the periods of one person in one role never overlap, and the shares of those who hold one role on the same day add up to 100 at most (BR-PWF-34). */
  async assign(tx: TenantTx, request: { taskId: string; actor: string; scopes: StageScopes; today: string; input: AssignInput }): Promise<TaskResult & { assignmentId: string }> {
    const locked = await this.lock(tx, request.taskId, request.scopes, 'task_id');
    const { task } = locked;
    this.assertOpenFor(locked, ['NOT_STARTED', 'IN_PROGRESS', 'AWAITING_APPROVAL', 'ON_HOLD']);
    const { input } = request;
    if (!(ROLES as readonly string[]).includes(input.role)) throw invalid('role');
    const membershipId = idOf(input.membershipId, 'membership_id');
    const from = dateOf(input.validFrom, 'valid_from');
    const to = input.validTo === undefined || input.validTo === null ? null : dateOf(input.validTo, 'valid_to');
    if (to !== null && to < from) throw new DomainError('PWF_ASSIGNMENT_INVALID', 422, 'valid_to');
    if (!Number.isInteger(input.sharePct) || input.sharePct < 1 || input.sharePct > 100) throw new DomainError('PWF_ASSIGNMENT_INVALID', 422, 'share_pct');
    const reason = textOf(input.reason, 'reason', 5, 500);
    const member = await tx.query<{ id: string }>('select id from machvon.membership where id = $1::uuid', [membershipId]);
    if (member[0] === undefined) throw new DomainError('PWF_ASSIGNMENT_INVALID', 422, 'membership_id');
    const overlapping = (): Promise<Array<{ valid_from: string; valid_to: string | null; share_pct: number }>> =>
      tx.query<{ valid_from: string; valid_to: string | null; share_pct: number }>(
        `select valid_from::text as valid_from, valid_to::text as valid_to, share_pct from machvon.project_task_assignment
          where task_id = $1::uuid and role = $2 and daterange(valid_from, valid_to, '[]') && daterange($3::date, $4::date, '[]')`,
        [task.id, input.role, from, to],
      );
    let others = await overlapping();
    if (peakShare(others, { from, to, share: input.sharePct }) > 100 && input.role === 'RESPONSIBLE') {
      // A handover: the people who hold the task without an end day, from before this line starts, hand it over the day before (the ledger closes their period, it never edits one); the shares are judged again.
      await tx.query(`update machvon.project_task_assignment set valid_to = $2::date - 1 where task_id = $1::uuid and role = 'RESPONSIBLE' and valid_to is null and valid_from < $2::date and membership_id <> $3::uuid`, [task.id, from, membershipId]);
      others = await overlapping();
    }
    if (peakShare(others, { from, to, share: input.sharePct }) > 100) throw new DomainError('PWF_ASSIGNMENT_INVALID', 422, 'share_pct', { extensions: { reason: 'SHARE_OVER_100' } });
    const id = randomUUID();
    try {
      await tx.query('savepoint pwf_assignment');
      await tx.query(
        `insert into machvon.project_task_assignment (tenant_id, id, task_id, membership_id, role, valid_from, valid_to, share_pct, reason, assigned_by)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3::uuid, $4, $5::date, $6::date, $7::int, $8, $9::uuid)`,
        [id, task.id, membershipId, input.role, from, to, input.sharePct, reason, request.actor],
      );
      await tx.query('release savepoint pwf_assignment');
    } catch (error) {
      if ((error as { code?: string }).code !== EXCLUSION_VIOLATION) throw error;
      await tx.query('rollback to savepoint pwf_assignment');
      throw new DomainError('PWF_ASSIGNMENT_INVALID', 422, 'valid_from', { extensions: { reason: 'PERIOD_OVERLAP' } });
    }
    await logWorkflow(tx, { workflowId: task.workflowId, taskId: task.id, kind: 'ASSIGNED', actor: request.actor, reason, subject: { task_code: task.code, assignment_id: id, membership_id: membershipId, role: input.role, valid_from: from, share_pct: input.sharePct } });
    return { ...this.result(locked, task.status, task.status, task.version, { assignment_id: id, role: input.role }), assignmentId: id };
  }

  // ---- internals ------------------------------------------------------------------------------------------------------------------------------------------------------------------------

  /** The task locked inside the scope of the command: readable but not actionable is 403, out of sight 404. */
  private async lock(tx: TenantTx, taskId: string, scopes: StageScopes, field: string): Promise<Locked> {
    const id = idOf(taskId, field);
    // The commands that publish the schedule of a workflow (a completion, a decision on a proposal) are one at a time per project: the same lock, taken before any row of the workflow is read (BR-PWF-28).
    // The order is the one of every command on the project: the row of the project first, then the lock of the publication, then the rows of the workflow.
    const owning = await tx.query<{ project_id: string }>('select project_id from machvon.project_task where id = $1::uuid', [id]);
    if (owning[0] !== undefined) {
      await tx.query('select id from machvon.project where id = $1::uuid for update', [owning[0].project_id]);
      await tx.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [`pwf:${owning[0].project_id}`]);
    }
    const act = scopes.act(2);
    const rows = await tx.query<LockSql & Record<string, unknown>>(
      `select ${TASK_COLUMNS}, w.status as workflow_status, w.template, w.planned_start_date::text as planned_start_date, w.schedule_version, w.version as workflow_version, w.calendar_pins, w.facts, p.code as project_code
         from ${SCOPE_FROM} join machvon.project_task t on t.tenant_id = p.tenant_id and t.project_id = p.id join machvon.project_workflow w on w.tenant_id = t.tenant_id and w.id = t.workflow_id
        where t.id = $1::uuid and ${act.sql} for update of t`,
      [id, ...act.params],
    );
    const row = rows[0];
    if (row === undefined) {
      const read = scopes.read(2);
      const seen = await tx.query<{ id: string }>(`select t.id from ${SCOPE_FROM} join machvon.project_task t on t.tenant_id = p.tenant_id and t.project_id = p.id where t.id = $1::uuid and ${read.sql}`, [id, ...read.params]);
      throw seen[0] === undefined ? new DomainError('RESOURCE_NOT_FOUND', 404) : new DomainError('SCOPE_DENIED', 403);
    }
    const template = pwfWorkflow.parseProjectWorkflowTemplate(row.template);
    const task = toTaskRow(row as never);
    const definition = template.tasks.find((one) => one.code === task.code) ?? (task.ownTask ? ownTaskDefinition(task) : undefined);
    return { task, workflow: { id: task.workflowId, status: row.workflow_status, template, plannedStartDate: row.planned_start_date, scheduleVersion: row.schedule_version, version: row.workflow_version, calendarPins: row.calendar_pins, facts: row.facts }, projectCode: row.project_code, definition };
  }

  private assertVersion(task: TaskRow, expected: number): void {
    if (task.version !== expected) throw versionConflict(task.version);
  }

  private assertOpenFor(locked: Locked, from: readonly string[]): void {
    const { task, workflow } = locked;
    if (workflow.status !== 'ACTIVE') throw stateInvalid('WORKFLOW_NOT_ACTIVE', { workflow_status: workflow.status });
    if (task.excluded || !task.tracked) throw stateInvalid('TASK_NOT_TRACKED');
    if (!from.includes(task.status)) throw stateInvalid('STATUS', { task_status: task.status });
  }

  /** Whoever works on a task holds it in the ledger today (a person who is not in the ledger is 403 `SCOPE_DENIED`: the right to work is not the right to take a task of someone else). */
  private async assertAssignee(tx: TenantTx, task: TaskRow, actor: string, today: string, roles: readonly AssignmentRole[]): Promise<void> {
    const rows = await tx.query<{ id: string }>(
      `select id from machvon.project_task_assignment where task_id = $1::uuid and membership_id = $2::uuid and role = any($3::text[]) and valid_from <= $4::date and (valid_to is null or valid_to >= $4::date) limit 1`,
      [task.id, actor, [...roles], today],
    );
    if (rows[0] === undefined) throw new DomainError('SCOPE_DENIED', 403);
  }

  /** The people who did work on the task: who started it, attached evidence, completed an item, asked for the completion, and the person acting now when it asks. */
  private async makersOf(tx: TenantTx, task: TaskRow, actor: string | null): Promise<string[]> {
    const rows = await tx.query<{ who: string }>(
      `select attached_by as who from machvon.project_task_evidence where task_id = $1::uuid
       union select done_by from machvon.project_task_checklist_item where task_id = $1::uuid and done_by is not null
       union select actor from machvon.project_task_log where task_id = $1::uuid and kind in ('START', 'COMPLETE_REQUESTED', 'COMPLETED')`,
      [task.id],
    );
    const makers = new Set(rows.map((row) => row.who));
    if (task.completionRequestedBy !== null) makers.add(task.completionRequestedBy);
    if (actor !== null) makers.add(actor);
    return [...makers];
  }

  /** The approver is none of the makers, whatever the exceptions say: 403 `SELF_APPROVAL_DENIED` for the one who asked for the completion, 403 `MAKER_IS_APPROVER` for any other who did work on it. */
  private async assertNotMaker(tx: TenantTx, task: TaskRow, actor: string): Promise<void> {
    if (task.completionRequestedBy === actor) throw new DomainError('SELF_APPROVAL_DENIED', 403);
    if ((await this.makersOf(tx, task, null)).includes(actor)) throw new DomainError('MAKER_IS_APPROVER', 403);
  }

  private async completionState(tx: TenantTx, task: TaskRow, performer: string, makers: readonly string[]): Promise<Omit<pwfWorkflow.CompletionState, 'exceptionApproved'>> {
    const items = await tx.query<{ item_code: string; done: boolean; kinds: string[] | null }>(
      `select i.item_code, i.done, (select array_agg(distinct e.evidence_kind) from machvon.project_task_evidence e where e.task_id = i.task_id and e.item_code = i.item_code) as kinds
         from machvon.project_task_checklist_item i where i.task_id = $1::uuid`,
      [task.id],
    );
    const evidence = await tx.query<{ legal_doc_type: string | null; form_template_code: string | null }>('select legal_doc_type, form_template_code from machvon.project_task_evidence where task_id = $1::uuid', [task.id]);
    return {
      performer,
      approver: null,
      makers,
      checklist: items.map((item) => ({ code: item.item_code, done: item.done, evidenceKinds: item.kinds ?? [] })),
      legalDocTypes: evidence.map((row) => row.legal_doc_type).filter((value): value is string => value !== null),
      formTemplates: evidence.map((row) => row.form_template_code).filter((value): value is string => value !== null),
    };
  }

  /** The approved waiver the caller names, for this task: 422 `PWF_EXCEPTION_INVALID` when it is not one. */
  private async waiverOf(tx: TenantTx, task: TaskRow, exceptionId: string): Promise<{ id: string; items: string[] }> {
    const rows = await tx.query<{ id: string; items: string[] }>(`select id, items from machvon.project_task_exception where id = $1::uuid and task_id = $2::uuid and kind = 'WAIVE_REQUIREMENT' and status = 'APPROVED' for update`, [exceptionId, task.id]);
    if (rows[0] === undefined) throw new DomainError('PWF_EXCEPTION_INVALID', 422, 'exception_id');
    return rows[0];
  }

  /** The predecessors that stop this task from starting by the kind of their link: a finish-to-start link waits for the predecessor to be done (or cancelled, or left out), a start-to-start link for it to have started. */
  private async blockingPredecessors(tx: TenantTx, task: TaskRow): Promise<string[]> {
    const rows = await tx.query<{ task_code: string; kind: string; status: string; excluded: boolean; tracked: boolean }>(
      `select p.task_code, d.kind, p.status, p.excluded, p.tracked from machvon.project_task_dependency d join machvon.project_task p on p.tenant_id = d.tenant_id and p.id = d.predecessor_id where d.task_id = $1::uuid and d.kind in ('FS', 'SS')`,
      [task.id],
    );
    return rows
      .filter((row) => !row.excluded && row.tracked)
      .filter((row) => (row.kind === 'FS' ? row.status !== 'DONE' && row.status !== 'CANCELLED' : row.status === 'NOT_STARTED'))
      .map((row) => row.task_code)
      .sort();
  }

  /** Writes the changed columns of a task and bumps its version (the If-Match of the next command). */
  private async update(tx: TenantTx, task: TaskRow, changes: Record<string, string | number | null>, actor: string): Promise<void> {
    const columns = Object.keys(changes);
    const sets = columns.map((column, index) => `${column} = $${index + 3}`);
    await tx.query(`update machvon.project_task set ${[...sets, 'updated_at = now()', 'updated_by = $2::uuid', 'version = version + 1'].join(', ')} where id = $1::uuid`, [task.id, actor, ...columns.map((column) => changes[column] as string | number | null)]);
  }

  private result(locked: Locked, from: string, status: string, version: number, facts: Record<string, unknown>): TaskResult {
    const { task } = locked;
    return { id: task.id, workflowId: task.workflowId, projectId: task.projectId, taskCode: task.code, fromStatus: from, status, version, facts: { task_code: task.code, phase_code: task.phaseCode, ...facts } };
  }

  /** A task that is done closes its milestone and moves the schedule (BR-PWF-06): the days of what is left are computed again from the progress, and a new version is published when anything moved. */
  private async afterDone(tx: TenantTx, locked: Locked, actor: string, today: string): Promise<number> {
    await refreshSchedule(tx, locked.workflow, locked.task.projectId, actor, today, this.baseline);
    return this.currentVersion(tx, locked.task.id);
  }

  /** The version of the task as it is now, after a schedule that was published has written its days on it. */
  private async currentVersion(tx: TenantTx, taskId: string): Promise<number> {
    const rows = await tx.query<{ version: number }>('select version from machvon.project_task where id = $1::uuid', [taskId]);
    return Number((rows[0] as { version: number }).version);
  }
}

/** The largest sum of shares held on one day of the period of the new line, together with the lines that overlap it. */
export function peakShare(others: ReadonlyArray<{ valid_from: string; valid_to: string | null; share_pct: number }>, line: { from: string; to: string | null; share: number }): number {
  const days = new Set<string>([line.from, ...others.map((one) => one.valid_from).filter((day) => day > line.from && (line.to === null || day <= line.to))]);
  let peak = 0;
  for (const day of days) {
    const held = others.filter((one) => one.valid_from <= day && (one.valid_to === null || one.valid_to >= day)).reduce((sum, one) => sum + one.share_pct, 0);
    peak = Math.max(peak, held + line.share);
  }
  return peak;
}

/**
 * Computes the schedule of a workflow again from the progress as of today (BR-PWF-06) and publishes a new version only when a day, a state, a float or the critical path changed: finishing a task early or late is a PROGRESS
 * version of the schedule with its own hashes, and the baseline is not touched (BR-PWF-08). Runs under the lock of the task the caller holds.
 */
export async function refreshSchedule(
  tx: TenantTx,
  workflow: { id: string; plannedStartDate: string; scheduleVersion: number; version: number; calendarPins: unknown },
  projectId: string,
  actor: string,
  today: string,
  baseline: PrjBaselineStore = new PrjBaselineStore(),
): Promise<boolean> {
  const rows = await loadTasks(tx, workflow.id);
  const links = await loadLinks(tx, workflow.id);
  const pins = pinsFromJson(workflow.calendarPins);
  const fromYear = earliestYear([workflow.plannedStartDate, today, ...rows.flatMap((row) => [row.baselineStart, row.actualStart, row.actualFinish])]);
  // The calendars the schedule was published on stay pinned while they reach back to the first day it mentions; otherwise the years are pinned again from there.
  const calendars = pins.length > 0 && (pins[0] as { year: number }).year <= fromYear ? await loadPinnedCalendars(tx, pins) : await pinPublishedCalendars(tx, fromYear);
  const tasks = scheduleTasksOf(rows, links);
  const input = { tasks, plannedStart: workflow.plannedStartDate, calendars, statusDate: today };
  const result = pwfSchedule.scheduleProject({ ...input, baseline: baselineOfRows(rows) });
  const before = resultOfRows(rows);
  const changes = pwfSchedule.diffSchedules(before, result, calendars);
  const same = result.tasks.every((one) => {
    const old = rows.find((row) => row.code === one.code);
    return old !== undefined && old.state === one.state && old.plannedStart === one.start && old.plannedFinish === one.finish && old.totalFloat === one.totalFloat && old.critical === one.critical;
  });
  if (same) {
    await syncMilestones(tx, projectId, await loadTasks(tx, workflow.id), actor, today, baseline);
    return false;
  }
  await publishSchedule(tx, { workflow: { id: workflow.id, projectId, version: workflow.version, scheduleVersion: workflow.scheduleVersion }, kind: 'PROGRESS', result, calendars, inputHash: inputHashOf(input), changes, reason: null, proposedBy: actor, approvedBy: null, today, baseline });
  return true;
}

export { resultHashOf };
