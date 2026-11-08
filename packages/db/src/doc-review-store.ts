import { DOCUMENT_REVIEW_RESOURCE, DomainError, assertWithdrawable, reviewBoardOf, reviewEndOf } from '@machvon/kernel';
import type { BoardStage, BoardStep, BoardTask, ReviewEnd, DocumentReviewStatus, ReviewEventKind, SubmissionPlan, WorkflowEnd } from '@machvon/kernel';
import { DocumentRepositoryStore, refuseWrite } from './doc-repository-store.ts';
import { timestampKey } from './keyset.ts';
import type { ScopeBuilder } from './scope-version.ts';
import type { TenantTx } from './tenant-database.ts';

/**
 * The review of a project document (DOC-2, PD.01): the rounds a version goes through and what happened in each. The stages, the parallel reviewers and their decisions belong to the ADM approval engine; this keeps the
 * round (which version, which round, who sent it, how it ended) and its history, and reads the board from the instance the round runs on. A round ends through `conclude`, called by the final command of the business
 * type `document.review` inside the transaction of the last decision, so that the review, the version and the lock move together or not at all.
 */

const ISO = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;
const repository = new DocumentRepositoryStore();

export interface ReviewRow {
  id: string;
  documentId: string;
  versionId: string;
  versionNo: number;
  round: number;
  previousReviewId: string | null;
  status: DocumentReviewStatus;
  workflowInstanceId: string | null;
  submittedBy: string;
  submittedByName: string | null;
  submittedAt: string;
  submitNote: string | null;
  concludedAt: string | null;
  conclusionNote: string | null;
  version: number;
}

interface ReviewSql {
  id: string;
  document_id: string;
  version_id: string;
  version_no: number;
  round_no: number;
  previous_review_id: string | null;
  status: DocumentReviewStatus;
  workflow_instance_id: string | null;
  submitted_by: string;
  submitted_by_name: string | null;
  submitted_at: string;
  submit_note: string | null;
  concluded_at: string | null;
  conclusion_note: string | null;
  version: string;
}

const REVIEW_COLUMNS = `r.id, r.document_id, r.version_id, v.version_no, r.round_no, r.previous_review_id, r.status, r.workflow_instance_id, r.submitted_by, sd.display_name as submitted_by_name,
       to_char(r.submitted_at at time zone 'UTC', ${ISO}) as submitted_at, r.submit_note, to_char(r.concluded_at at time zone 'UTC', ${ISO}) as concluded_at, r.conclusion_note, r.version::text as version`;
const REVIEW_FROM = `machvon.document_review r
  join machvon.project_document_version v on v.tenant_id = r.tenant_id and v.id = r.version_id
  left join machvon.tenant_user_directory sd on sd.tenant_id = r.tenant_id and sd.membership_id = r.submitted_by`;

const reviewOf = (row: ReviewSql): ReviewRow => ({
  id: row.id,
  documentId: row.document_id,
  versionId: row.version_id,
  versionNo: row.version_no,
  round: row.round_no,
  previousReviewId: row.previous_review_id,
  status: row.status,
  workflowInstanceId: row.workflow_instance_id,
  submittedBy: row.submitted_by,
  submittedByName: row.submitted_by_name,
  submittedAt: row.submitted_at,
  submitNote: row.submit_note,
  concludedAt: row.concluded_at,
  conclusionNote: row.conclusion_note,
  version: Number(row.version),
});

export interface ReviewEventRow {
  seq: number;
  kind: ReviewEventKind;
  actorId: string | null;
  actorName: string | null;
  detail: Record<string, unknown>;
  occurredAt: string;
}

export interface ReviewListFilter {
  projectId?: string | undefined;
  documentId?: string | undefined;
  status?: DocumentReviewStatus | undefined;
}

export interface ReviewListRow extends ReviewRow {
  documentTitle: string;
  docClass: string;
  project: { id: string; code: string; name: string };
  /** The name of the stage an open round waits at, from the definition the round runs by. */
  currentStage: string | null;
}

/** What the final command of the workflow did with a review. */
export type Conclusion = { kind: 'CONCLUDED'; review: ReviewRow; end: ReviewEnd; decidedBy: string | null; reason: string | null } | { kind: 'REFUSED'; reason: 'NOT_FOUND' | 'NOT_OPEN' };

export class DocumentReviewStore {
  async find(tx: TenantTx, id: string): Promise<ReviewRow | undefined> {
    const rows = await tx.query<ReviewSql>(`select ${REVIEW_COLUMNS} from ${REVIEW_FROM} where r.id = $1::uuid`, [id]);
    return rows[0] === undefined ? undefined : reviewOf(rows[0]);
  }

  async latestOf(tx: TenantTx, documentId: string): Promise<ReviewRow | undefined> {
    const rows = await tx.query<ReviewSql>(`select ${REVIEW_COLUMNS} from ${REVIEW_FROM} where r.document_id = $1::uuid order by r.round_no desc limit 1`, [documentId]);
    return rows[0] === undefined ? undefined : reviewOf(rows[0]);
  }

  async roundsOf(tx: TenantTx, documentId: string): Promise<ReviewRow[]> {
    const rows = await tx.query<ReviewSql>(`select ${REVIEW_COLUMNS} from ${REVIEW_FROM} where r.document_id = $1::uuid order by r.round_no desc`, [documentId]);
    return rows.map(reviewOf);
  }

  async findByInstance(tx: TenantTx, instanceId: string): Promise<ReviewRow | undefined> {
    const rows = await tx.query<ReviewSql>(`select ${REVIEW_COLUMNS} from ${REVIEW_FROM} where r.workflow_instance_id = $1::uuid for update of r`, [instanceId]);
    return rows[0] === undefined ? undefined : reviewOf(rows[0]);
  }

  /** The reviews the caller may see (those of the documents of the projects in their scope), newest first. */
  async list(tx: TenantTx, filter: ReviewListFilter, scope: ScopeBuilder, page: { limit: number; after: { key: string; id: string } | undefined }): Promise<{ items: ReviewListRow[]; more: boolean; last: { key: string; id: string } | undefined }> {
    const params: unknown[] = [];
    const next = (value: unknown): string => {
      params.push(value);
      return `$${params.length}`;
    };
    const predicate = scope(1);
    params.push(...predicate.params);
    const where = [predicate.sql];
    if (filter.projectId !== undefined) where.push(`d.project_id = ${next(filter.projectId)}::uuid`);
    if (filter.documentId !== undefined) where.push(`r.document_id = ${next(filter.documentId)}::uuid`);
    if (filter.status !== undefined) where.push(`r.status = ${next(filter.status)}`);
    if (page.after !== undefined) where.push(`(${timestampKey('r.submitted_at')}, r.id) < (${next(page.after.key)}::text, ${next(page.after.id)}::uuid)`);
    const rows = await tx.query<ReviewSql & { title: string; doc_class: string; project_id: string; project_code: string; project_name: string; submitted_key: string; current_stage: string | null }>(
      `select ${REVIEW_COLUMNS}, d.title, d.doc_class, d.project_id, p.code as project_code, p.name as project_name, ${timestampKey('r.submitted_at')} as submitted_key,
              case when r.status = 'IN_REVIEW' then wv.definition_json->'steps'->wi.current_step->>'name' end as current_stage
         from ${REVIEW_FROM}
         left join machvon.workflow_instance wi on wi.tenant_id = r.tenant_id and wi.id = r.workflow_instance_id
         left join machvon.workflow_version wv on wv.tenant_id = wi.tenant_id and wv.id = wi.workflow_version_id
         join machvon.project_document d on d.tenant_id = r.tenant_id and d.id = r.document_id
         join machvon.project p on p.tenant_id = d.tenant_id and p.id = d.project_id
         join machvon.organization_unit ou on ou.tenant_id = p.tenant_id and ou.id = p.owner_unit_id
         left join machvon.organization_unit iu on iu.tenant_id = p.tenant_id and iu.id = p.investor_unit_id
        where ${where.join(' and ')} order by r.submitted_at desc, r.id desc limit ${next(page.limit + 1)}`,
      params,
    );
    const shown = rows.slice(0, page.limit);
    const last = shown[shown.length - 1];
    return {
      items: shown.map((row) => ({ ...reviewOf(row), documentTitle: row.title, docClass: row.doc_class, project: { id: row.project_id, code: row.project_code, name: row.project_name }, currentStage: row.current_stage })),
      more: rows.length > page.limit,
      last: last === undefined ? undefined : { key: last.submitted_key, id: last.id },
    };
  }

  /** Opens a round: the review row, the version sent to review and the first event, in the transaction of the caller. */
  async open(tx: TenantTx, plan: SubmissionPlan, input: { documentId: string; versionId: string; note: string | null }, actor: string): Promise<ReviewRow> {
    let id: string;
    try {
      const rows = await tx.query<{ id: string }>(
        `insert into machvon.document_review (tenant_id, document_id, version_id, round_no, previous_review_id, submitted_by, submit_note)
         values (nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, $2::uuid, $3, $4::uuid, $5::uuid, $6) returning id`,
        [input.documentId, input.versionId, plan.round, plan.previousReviewId, actor, input.note],
      );
      id = (rows[0] as { id: string }).id;
    } catch (error) {
      return refuseWrite(error);
    }
    await repository.moveVersion(tx, input.versionId, 'DRAFT', 'IN_REVIEW', null);
    await this.record(tx, id, plan.kind, actor, { round: plan.round, version_id: input.versionId });
    const review = await this.find(tx, id);
    if (review === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return review;
  }

  async attachInstance(tx: TenantTx, reviewId: string, instanceId: string): Promise<void> {
    await tx.query('update machvon.document_review set workflow_instance_id = $2::uuid where id = $1::uuid and workflow_instance_id is null', [reviewId, instanceId]);
  }

  /** Withdraws an open round, by the person who sent it: the instance is cancelled by the caller; the version goes back to DRAFT. */
  async withdraw(tx: TenantTx, reviewId: string, expectedVersion: number, actor: string, reason: string): Promise<{ before: ReviewRow; after: ReviewRow }> {
    await tx.query('select id from machvon.document_review where id = $1::uuid for update', [reviewId]);
    const before = await this.find(tx, reviewId);
    if (before === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (before.version !== expectedVersion) throw new DomainError('VERSION_CONFLICT', 409, 'version', { extensions: { current_version: before.version } });
    assertWithdrawable(before, actor);
    await tx.query("update machvon.document_review set status = 'WITHDRAWN', concluded_at = now(), conclusion_note = $2, version = version + 1 where id = $1::uuid", [reviewId, reason]);
    await repository.moveVersion(tx, before.versionId, 'IN_REVIEW', 'DRAFT', null);
    await this.record(tx, reviewId, 'WITHDRAWN', actor, { reason_given: true });
    const after = await this.find(tx, reviewId);
    if (after === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return { before, after };
  }

  /**
   * The end of the workflow of a round (the final command of `document.review`): the review ends as the workflow ended, the version follows (an approved version is locked and becomes the approved version of its
   * document), and the history says so. A round that is not open any more (the instance ended twice, or the review was withdrawn) is refused, and the engine records the refusal. The person who made the last decision
   * and the reason they gave are read from the task of that decision.
   */
  async conclude(tx: TenantTx, instanceId: string, sequence: number, workflowEnd: WorkflowEnd): Promise<Conclusion> {
    const review = await this.findByInstance(tx, instanceId);
    if (review === undefined) return { kind: 'REFUSED', reason: 'NOT_FOUND' };
    if (review.status !== 'IN_REVIEW') return { kind: 'REFUSED', reason: 'NOT_OPEN' };
    const end = reviewEndOf(workflowEnd);
    const [decided] = await tx.query<{ decided_by: string | null; reason: string | null }>('select decided_by, reason from machvon.approval_task where workflow_instance_id = $1::uuid and decision_seq = $2::integer limit 1', [instanceId, sequence]);
    const decidedBy = decided?.decided_by ?? null;
    const reason = decided?.reason ?? null;
    await tx.query('update machvon.document_review set status = $2, concluded_at = now(), conclusion_note = $3, version = version + 1 where id = $1::uuid', [review.id, end.reviewStatus, reason]);
    await repository.moveVersion(tx, review.versionId, 'IN_REVIEW', end.versionStatus, decidedBy);
    await this.record(tx, review.id, end.eventKind, decidedBy, { round: review.round, version_id: review.versionId, reason_given: reason !== null });
    if (end.versionStatus === 'APPROVED') {
      await tx.query('update machvon.project_document set approved_version_id = $2::uuid, version = version + 1, updated_at = now() where id = $1::uuid', [review.documentId, review.versionId]);
      await this.record(tx, review.id, 'VERSION_LOCKED', decidedBy, { version_id: review.versionId, version_no: review.versionNo });
    }
    const concluded = await this.find(tx, review.id);
    return { kind: 'CONCLUDED', review: concluded ?? review, end, decidedBy, reason };
  }

  async record(tx: TenantTx, reviewId: string, kind: ReviewEventKind, actor: string | null, detail: Record<string, unknown>): Promise<void> {
    await tx.query(
      `insert into machvon.document_review_event (tenant_id, review_id, seq, kind, actor_id, detail)
       select nullif(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, coalesce(max(seq), 0) + 1, $2, $3::uuid, $4::jsonb from machvon.document_review_event where review_id = $1::uuid`,
      [reviewId, kind, actor, JSON.stringify(detail)],
    );
  }

  async events(tx: TenantTx, reviewId: string): Promise<ReviewEventRow[]> {
    const rows = await tx.query<{ seq: number; kind: ReviewEventKind; actor_id: string | null; actor_name: string | null; detail: Record<string, unknown>; occurred_at: string }>(
      `select e.seq, e.kind, e.actor_id, d.display_name as actor_name, e.detail, to_char(e.occurred_at at time zone 'UTC', ${ISO}) as occurred_at
         from machvon.document_review_event e left join machvon.tenant_user_directory d on d.tenant_id = e.tenant_id and d.membership_id = e.actor_id
        where e.review_id = $1::uuid order by e.seq`,
      [reviewId],
    );
    return rows.map((row) => ({ seq: row.seq, kind: row.kind, actorId: row.actor_id, actorName: row.actor_name, detail: row.detail, occurredAt: row.occurred_at }));
  }

  /**
   * The board of a round: the stages of the definition the instance runs by (the version of the workflow it started on, so a later edit of the workflow does not rewrite a round under way), with each stage's
   * reviewers and what they decided. A round that has no instance yet (it was refused before one started) shows its stages from the published workflow when there is one, else none.
   */
  async board(tx: TenantTx, review: ReviewRow): Promise<{ stages: BoardStage[]; workflowRevision: number | null; instanceStatus: string | null; outcome: string | null }> {
    if (review.workflowInstanceId === null) return { stages: [], workflowRevision: null, instanceStatus: null, outcome: null };
    const [instance] = await tx.query<{ status: 'Running' | 'Completed' | 'Cancelled' | 'Failed'; outcome: string | null; current_step: number; definition_json: { steps?: Array<{ id: string; name: string; min_approvals: number }> }; revision: number }>(
      `select i.status, i.outcome, i.current_step, v.definition_json, v.revision
         from machvon.workflow_instance i join machvon.workflow_version v on v.tenant_id = i.tenant_id and v.id = i.workflow_version_id where i.id = $1::uuid and i.resource_type = $2`,
      [review.workflowInstanceId, DOCUMENT_REVIEW_RESOURCE],
    );
    if (instance === undefined) return { stages: [], workflowRevision: null, instanceStatus: null, outcome: null };
    const steps: BoardStep[] = (instance.definition_json.steps ?? []).map((step) => ({ id: step.id, name: step.name, minApprovals: step.min_approvals }));
    const tasks = await tx.query<{
      id: string;
      step_index: number;
      assignee_id: string;
      assignee_name: string | null;
      status: BoardTask['status'];
      decision: BoardTask['decision'];
      reason: string | null;
      decided_at: string | null;
      due_at: string;
      version: string;
    }>(
      `select t.id, t.step_index, t.assignee_id, a.display_name as assignee_name, t.status, t.decision, t.reason, to_char(t.decided_at at time zone 'UTC', ${ISO}) as decided_at, to_char(t.due_at at time zone 'UTC', ${ISO}) as due_at, t.version::text as version
         from machvon.approval_task t left join machvon.tenant_user_directory a on a.tenant_id = t.tenant_id and a.membership_id = t.assignee_id
        where t.workflow_instance_id = $1::uuid order by t.step_index, t.created_at, t.id`,
      [review.workflowInstanceId],
    );
    const stages = reviewBoardOf(
      steps,
      { status: instance.status, outcome: instance.outcome, currentStep: instance.current_step },
      tasks.map((task) => ({ id: task.id, stepIndex: task.step_index, assigneeId: task.assignee_id, assigneeName: task.assignee_name, taskVersion: Number(task.version), status: task.status, decision: task.decision, reason: task.reason, decidedAt: task.decided_at, dueAt: task.due_at })),
    );
    return {
      stages,
      workflowRevision: instance.revision,
      instanceStatus: instance.status,
      outcome: instance.outcome,
    };
  }
}
