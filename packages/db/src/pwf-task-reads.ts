import { DomainError, pwfWorkflow, vietnamDateOf } from '@machvon/kernel';
import { HomeWorkCalendars } from './home-work-clock-store.ts';
import { SCOPE_FROM } from './prj-project-store.ts';
import { PwfAssignmentReads, legalBasisView } from './pwf-assignment.ts';
import { currentFormRevisions } from './pwf-form-revision.ts';
import { TASK_COLUMNS, toTaskRow } from './pwf-schedule-support.ts';
import type { TaskRow, TaskSql } from './pwf-schedule-support.ts';
import { bandResolver, bandSubjectOf, taskItemOf, unitPathOfProject } from './pwf-workflow-reads.ts';
import type { Can } from './pwf-workflow-reads.ts';
import type { ScopeBuilder } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';

/** One task in full (PWF-04) and the ledger of its assignments (PWF-16), inside the scope of `pwf.read`: out of scope is 404, the buttons the caller may press are told in `can_*`. */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO = (column: string): string => `to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const HISTORY_LIMIT = 200;
const LIVE = ['NOT_STARTED', 'IN_PROGRESS', 'AWAITING_APPROVAL', 'ON_HOLD'];

interface AssignmentSql {
  id: string;
  task_id: string;
  membership_id: string;
  display_name: string | null;
  role: string;
  valid_from: string;
  valid_to: string | null;
  share_pct: number;
  reason: string;
  assigned_by: string;
  assigned_by_name: string | null;
  approved_by: string | null;
  approved_by_name: string | null;
}

const assignmentOf = (row: AssignmentSql): Record<string, unknown> => ({
  id: row.id,
  task_id: row.task_id,
  membership_id: row.membership_id,
  display_name: row.display_name ?? row.membership_id,
  role: row.role,
  valid_from: row.valid_from,
  valid_to: row.valid_to,
  share_pct: row.share_pct,
  reason: row.reason,
  assigned_by: row.assigned_by,
  assigned_by_name: row.assigned_by_name,
  approved_by: row.approved_by,
  approved_by_name: row.approved_by_name,
});

/** The name of a person from the directory of the tenant, for a row of the alias `alias` (B9, B10: a screen names people, units and documents, never their ids). */
const PERSON = (alias: string, member: string): string => `(select d.display_name from machvon.tenant_user_directory d where d.tenant_id = ${alias}.tenant_id and d.membership_id = ${member})`;

const ASSIGNMENT_SELECT = `select a.id, a.task_id, a.membership_id, u.display_name, a.role, a.valid_from::text as valid_from, a.valid_to::text as valid_to, a.share_pct, a.reason, a.assigned_by, ${PERSON('a', 'a.assigned_by')} as assigned_by_name, a.approved_by, ${PERSON('a', 'a.approved_by')} as approved_by_name
  from machvon.project_task_assignment a left join machvon.tenant_user_directory u on u.tenant_id = a.tenant_id and u.membership_id = a.membership_id`;

export class PwfTaskReads {
  private readonly calendars: HomeWorkCalendars;
  private readonly assignment = new PwfAssignmentReads();

  constructor(calendars: HomeWorkCalendars = new HomeWorkCalendars()) {
    this.calendars = calendars;
  }

  private async locate(tx: TenantTx, scope: ScopeBuilder, taskId: string): Promise<{ task: TaskRow; template: Record<string, unknown>; workflowStatus: string }> {
    if (!UUID.test(taskId)) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const predicate = scope(2);
    const rows = await tx.query<TaskSql & { template: Record<string, unknown>; workflow_status: string }>(
      `select ${TASK_COLUMNS}, w.template, w.status as workflow_status
         from ${SCOPE_FROM} join machvon.project_task t on t.tenant_id = p.tenant_id and t.project_id = p.id join machvon.project_workflow w on w.tenant_id = t.tenant_id and w.id = t.workflow_id
        where t.id = $1::uuid and ${predicate.sql}`,
      [taskId.toLowerCase(), ...predicate.params],
    );
    const row = rows[0];
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return { task: toTaskRow(row), template: row.template, workflowStatus: row.workflow_status };
  }

  async task(tx: TenantTx, scope: ScopeBuilder, taskId: string, now: Date, viewer: string, can: Can): Promise<Record<string, unknown>> {
    const { task, template: raw, workflowStatus } = await this.locate(tx, scope, taskId);
    const template = pwfWorkflow.parseProjectWorkflowTemplate(raw);
    const definition = template.tasks.find((one) => one.code === task.code);
    const today = vietnamDateOf(now);
    const resolver = await bandResolver(tx, this.calendars, now);
    const unit = await unitPathOfProject(tx, task.projectId);
    const assignmentRows = await tx.query<AssignmentSql>(`${ASSIGNMENT_SELECT} where a.task_id = $1::uuid order by a.valid_from, a.role, a.id`, [task.id]);
    const current = assignmentRows.find((row) => row.role === 'RESPONSIBLE' && row.valid_from <= today && (row.valid_to === null || row.valid_to >= today));
    const held = (roles: readonly string[]): boolean => assignmentRows.some((row) => row.membership_id === viewer && roles.includes(row.role) && row.valid_from <= today && (row.valid_to === null || row.valid_to >= today));
    const checklist = await tx.query<{ item_code: string; name: string; required: boolean; evidence_kinds: string[]; done: boolean; done_by: string | null; done_by_name: string | null; done_at: string | null }>(
      `select i.item_code, i.name, i.required, i.evidence_kinds, i.done, i.done_by, ${PERSON('i', 'i.done_by')} as done_by_name, ${ISO('i.done_at')} as done_at from machvon.project_task_checklist_item i where i.task_id = $1::uuid order by i.item_code`,
      [task.id],
    );
    const evidence = await tx.query<{ id: string; item_code: string | null; evidence_kind: string; document_id: string | null; legal_doc_type: string | null; form_template_code: string | null; form_template_revision: number | null; form_template_sha256: string | null; external_ref: string | null; note: string | null; attached_by: string; attached_by_name: string | null; attached_at: string; document_title: string | null; document_symbol: string | null }>(
      `select e.id, e.item_code, e.evidence_kind, e.document_id, e.legal_doc_type, e.form_template_code, e.form_template_revision, e.form_template_sha256::text as form_template_sha256, e.external_ref, e.note, e.attached_by,
              ${PERSON('e', 'e.attached_by')} as attached_by_name, ${ISO('e.attached_at')} as attached_at, d.title as document_title, d.symbol as document_symbol
         from machvon.project_task_evidence e left join machvon.document d on d.tenant_id = e.tenant_id and d.id = e.document_id
        where e.task_id = $1::uuid order by e.attached_at, e.id`,
      [task.id],
    );
    const exceptions = await tx.query<{ id: string; task_id: string; kind: string; items: string[]; valid_from: string; valid_to: string | null; reason: string; evidence_ref: string | null; status: string; requested_by: string; requested_by_name: string | null; decided_by: string | null; decided_by_name: string | null; decided_at: string | null; decision_note: string | null; version: number }>(
      `select x.id, x.task_id, x.kind, x.items, x.valid_from::text as valid_from, x.valid_to::text as valid_to, x.reason, x.evidence_ref, x.status, x.requested_by, ${PERSON('x', 'x.requested_by')} as requested_by_name,
              x.decided_by, ${PERSON('x', 'x.decided_by')} as decided_by_name, ${ISO('x.decided_at')} as decided_at, x.decision_note, x.version
         from machvon.project_task_exception x where x.task_id = $1::uuid order by x.requested_at, x.id`,
      [task.id],
    );
    // B10: every entry of the log was written by a person (the actor of the command); the read names them, so that no screen falls back to "the system".
    const history = await tx.query<{ id: string; kind: string; at: string; actor: string | null; actor_name: string | null; reason: string | null }>(
      `select l.id, l.kind, ${ISO('l.at')} as at, l.actor, ${PERSON('l', 'l.actor')} as actor_name, l.reason from machvon.project_task_log l where l.task_id = $1::uuid order by l.at desc, l.id desc limit ${HISTORY_LIMIT}`,
      [task.id],
    );
    const links = await tx.query<{ task: string; kind: string; lag_working_days: number }>(
      `select p.task_code as task, d.kind, d.lag_working_days from machvon.project_task_dependency d join machvon.project_task p on p.tenant_id = d.tenant_id and p.id = d.predecessor_id where d.task_id = $1::uuid order by p.task_code, d.kind`,
      [task.id],
    );
    const makers = new Set<string>([...evidence.map((one) => one.attached_by), ...checklist.map((one) => one.done_by).filter((one): one is string => one !== null), ...(task.completionRequestedBy === null ? [] : [task.completionRequestedBy])]);
    const assessment =
      definition === undefined
        ? { ok: true, blockers: [], coverable: [] }
        : pwfWorkflow.assessTaskCompletion(definition, {
            performer: viewer,
            approver: null,
            makers: [...makers],
            checklist: checklist.map((one) => ({ code: one.item_code, done: one.done, evidenceKinds: evidence.filter((entry) => entry.item_code === one.item_code).map((entry) => entry.evidence_kind) })),
            legalDocTypes: evidence.map((one) => one.legal_doc_type).filter((one): one is string => one !== null),
            formTemplates: evidence.map((one) => one.form_template_code).filter((one): one is string => one !== null),
            exceptionApproved: false,
          });
    const completion = { ok: assessment.blockers.filter((one) => one.code !== 'APPROVER_REQUIRED').length === 0, blockers: assessment.blockers.filter((one) => one.code !== 'APPROVER_REQUIRED' && one.code !== 'MAKER_IS_APPROVER'), coverable: assessment.coverable };
    const live = LIVE.includes(task.status) && workflowStatus === 'ACTIVE' && task.tracked && !task.excluded;
    const assignee = current === undefined ? undefined : { membership_id: current.membership_id, display_name: current.display_name ?? current.membership_id };
    const variance = task.baselineFinish === null || task.plannedFinish === null ? null : Math.round((Date.parse(`${task.plannedFinish}T00:00:00Z`) - Date.parse(`${task.baselineFinish}T00:00:00Z`)) / 86_400_000);
    const notMaker = !makers.has(viewer);
    // R44, R45: the step the task belongs to and the legal grounds of the step and of the task, each with what the catalogue says of the document today.
    const step = definition === undefined ? undefined : pwfWorkflow.stepsOf(template).find((one) => one.code === pwfWorkflow.stepCodeOf(template, definition) && one.phase === definition.phase);
    const cites = (definition?.legalBasis ?? []).length + (step?.legalBasis.length ?? 0) > 0;
    const catalogue = cites ? await this.assignment.legalDocuments(tx, today) : new Map();
    // R46: the revision of each form in force today, the one the evidence of the task was made from, and whether a newer one exists since.
    const formCodes = definition?.formTemplates ?? [];
    const currentForms = await currentFormRevisions(tx, formCodes, today);
    const forms = formCodes.map((code) => {
      const policy = pwfWorkflow.formPolicyOf(definition ?? {}, code);
      const used = [...evidence].reverse().find((one) => one.form_template_code === code);
      const now = currentForms.get(code);
      const usedRevision = used?.form_template_revision ?? null;
      return {
        code,
        satisfied: used !== undefined,
        // The document, the revision and the hash are those of ONE evidence: the newest one of the form.
        document_id: used?.document_id ?? null,
        policy: policy.policy,
        pinned_revision: policy.revision,
        current_revision: now?.revision ?? null,
        current_title: now?.title ?? null,
        current_effective_from: now?.effectiveFrom ?? null,
        used_revision: usedRevision,
        used_sha256: used?.form_template_sha256?.trim() ?? null,
        newer_available: policy.policy === 'LATEST_APPROVED' && usedRevision !== null && now !== undefined && now.revision > usedRevision,
      };
    });
    return {
      ...taskItemOf(task, resolver.of(bandSubjectOf(task), unit), assignee),
      responsible_role: task.responsibleRole,
      approver_role: task.approverRole,
      duration_working_days: task.durationWorkingDays,
      baseline_start: task.baselineStart,
      finish_variance_days: variance,
      late_start: task.lateStart,
      late_finish: task.lateFinish,
      free_float: task.freeFloat,
      actual_start: task.actualStart,
      actual_finish: task.actualFinish,
      remaining_working_days: task.remainingWorkingDays,
      percent_complete: task.percentComplete,
      reschedule_count: task.rescheduleCount,
      estimate_vnd: task.estimateVnd,
      actual_vnd: task.actualVnd,
      milestone_id: task.milestoneId,
      predecessors: links.map((one) => ({ task: one.task, kind: one.kind, lag_working_days: one.lag_working_days })),
      checklist: checklist.map((one) => ({ item_code: one.item_code, name: one.name, required: one.required, evidence_kinds: one.evidence_kinds, done: one.done, done_by: one.done_by, done_by_name: one.done_by_name, done_at: one.done_at })),
      legal_doc_types: (definition?.legalDocTypes ?? []).map((code) => ({ code, satisfied: evidence.some((one) => one.legal_doc_type === code) })),
      form_templates: forms,
      step: step === undefined ? null : { code: step.code, name: step.name, phase_code: step.phase, order: step.order, implicit: step.implicit, responsible_role: step.responsibleRole },
      legal_basis: (definition?.legalBasis ?? []).map((basis) => legalBasisView(basis, catalogue)),
      step_legal_basis: (step?.legalBasis ?? []).map((basis) => legalBasisView(basis, catalogue)),
      evidence: evidence.map((one) => ({ id: one.id, item_code: one.item_code, evidence_kind: one.evidence_kind, document_id: one.document_id, legal_doc_type: one.legal_doc_type, form_template_code: one.form_template_code, form_template_revision: one.form_template_revision, form_template_sha256: one.form_template_sha256?.trim() ?? null, external_ref: one.external_ref, note: one.note, attached_by: one.attached_by, attached_by_name: one.attached_by_name, attached_at: one.attached_at, document_title: one.document_title, document_symbol: one.document_symbol })),
      completion,
      exceptions,
      assignments: assignmentRows.map(assignmentOf),
      history: history.map((one) => ({ id: one.id, kind: one.kind, at: one.at, actor: one.actor, actor_name: one.actor_name, reason: one.reason })),
      can_start: can.work && live && task.status === 'NOT_STARTED' && held(['RESPONSIBLE', 'ACCOUNTABLE']),
      can_complete: can.work && live && task.status === 'IN_PROGRESS' && held(['RESPONSIBLE', 'ACCOUNTABLE']),
      can_approve: can.approve && live && task.status === 'AWAITING_APPROVAL' && notMaker,
      can_return: can.approve && live && task.status === 'AWAITING_APPROVAL' && notMaker,
      can_request_exception: can.work && live,
      can_resume: can.work && live && task.status === 'ON_HOLD' && held(['RESPONSIBLE', 'ACCOUNTABLE']),
      can_assign: can.assign && live,
      as_of: now.toISOString(),
    };
  }

  /** The ledger of a task, oldest period first, in pages (the cursor is the start day and the id). */
  async assignments(tx: TenantTx, scope: ScopeBuilder, taskId: string, page: { limit: number; after?: { code: string; id: string } | undefined }, now: Date): Promise<{ items: Record<string, unknown>[]; next: { code: string; id: string } | null; asOf: string }> {
    const { task } = await this.locate(tx, scope, taskId);
    const after = page.after;
    if (after !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(after.code)) throw new DomainError('VALIDATION_FAILED', 422, 'cursor');
    const rows = await tx.query<AssignmentSql>(
      `${ASSIGNMENT_SELECT} where a.task_id = $1::uuid and ($2::date is null or (a.valid_from, a.id) > ($2::date, $3::uuid)) order by a.valid_from, a.id limit $4`,
      [task.id, after?.code ?? null, after?.id ?? null, page.limit + 1],
    );
    const shown = rows.slice(0, page.limit);
    const last = shown[shown.length - 1];
    return { items: shown.map(assignmentOf), next: rows.length > shown.length && last !== undefined ? { code: last.valid_from, id: last.id } : null, asOf: now.toISOString() };
  }
}
