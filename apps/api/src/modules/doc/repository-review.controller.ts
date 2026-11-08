import { randomUUID } from 'node:crypto';
import { Body, Controller, Get, HttpCode, Inject, Injectable, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { AuditWriter, DocumentCommentStore, DocumentRepositoryStore, DocumentReviewStore, TenantDatabase, enqueueOutbox, projectScope } from '@machvon/db';
import { DOCUMENT_REVIEW_BUSINESS_TYPE, DOCUMENT_REVIEW_RESOURCE, DOCUMENT_REVIEW_STATUSES, DomainError, asUuid, planSubmission, reviewNoteOf } from '@machvon/kernel';
import type { DocumentReviewStatus, EffectiveAccess, TenantContext } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { encodeCursor, parsePageRequest } from '../../pagination';
import { CurrentTenant } from '../../tenant-context.decorator';
import { APPROVAL_FINAL_COMMANDS, ApprovalService } from '../adm/approval.service';
import type { FinalCommandRegistry } from '../adm/approval.service';
import { eventDto, reviewRoundDto } from './repository-view';

const classificationOf = (securityClass: string): 'PUBLIC' | 'INTERNAL' | 'CONFIDENTIAL' => (securityClass === 'PUBLIC' ? 'PUBLIC' : securityClass === 'INTERNAL' ? 'INTERNAL' : 'CONFIDENTIAL');

/**
 * The review of a project document (DOC-25, DOC-26, PD.01): a draft version is sent into the approval workflow `document.review` of ADM, whose published definition says the stages and, for each, who reviews and how
 * many approvals close it; the reviewers of a stage decide in parallel from their approval tasks (`decideApprovalTask`), the maker is never the checker, and the engine ends the round by calling the final command of
 * the business type, which this module registers (`DocumentReviewBinding`): an approval locks the version, a return is the request for a supplement, a rejection closes the round. The supplement is a newer version, sent
 * as the next round. Sending fails whole (422 `WORKFLOW_NOT_CONFIGURED`, no DoA rule, no reviewer) and leaves the version a draft.
 */
@Controller()
export class DocumentReviewsController {
  private readonly documents = new DocumentRepositoryStore();
  private readonly reviews = new DocumentReviewStore();

  constructor(@Inject(ApprovalService) private readonly approvals: ApprovalService) {}

  @Post('project-documents/:id/reviews')
  @HttpCode(200)
  @OperationId('submitDocumentForReview')
  @Command({ operation: 'submitDocumentForReview' })
  async submit(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['DocumentReviewSubmit']): Promise<CommandResult> {
    const now = new Date();
    const documentId = id.toLowerCase();
    const versionId = asUuid(body.version_id);
    if (versionId === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'version_id');
    const note = reviewNoteOf(body.note);
    const documentScope = projectScope(access, PERMISSIONS.submitDocumentForReview, now);
    const document = await this.documents.lockDocument(scope.tx, documentId, documentScope, now);
    const found = await this.documents.findVersion(scope.tx, versionId, documentScope, now);
    if (found === undefined || found.document.id !== documentId) throw new DomainError('RESOURCE_NOT_FOUND', 404, 'version_id');
    const latest = await this.reviews.latestOf(scope.tx, documentId);
    const plan = planSubmission({
      documentActive: document.status === 'ACTIVE',
      version: { id: found.version.id, versionNo: found.version.versionNo, status: found.version.status, extractionStatus: found.version.extractionStatus },
      latest: latest === undefined ? null : { id: latest.id, round: latest.round, status: latest.status, versionNo: latest.versionNo },
      approvedVersionNo: document.approvedVersion?.versionNo ?? null,
    });
    const opened = await this.reviews.open(scope.tx, plan, { documentId, versionId: found.version.id, note }, scope.tenant.membershipId);
    const instance = await this.approvals.start(scope, {
      resourceType: DOCUMENT_REVIEW_RESOURCE,
      resourceId: opened.id,
      resourceVersion: opened.version,
      businessType: DOCUMENT_REVIEW_BUSINESS_TYPE,
      amountVnd: null,
      unitId: await this.documents.ownerUnitOf(scope.tx, documentId),
      now,
    });
    await this.reviews.attachInstance(scope.tx, opened.id, instance.id);
    await scope.audit({
      action: 'doc.repo.review_submitted',
      resourceType: DOCUMENT_REVIEW_RESOURCE,
      resourceId: opened.id,
      classification: classificationOf(document.securityClass),
      diff: { document_id: documentId, project_id: document.project.id, version_id: found.version.id, version_no: found.version.versionNo, round: plan.round, kind: plan.kind, workflow_instance_id: instance.id, has_note: note !== null },
    });
    await scope.emit({
      aggregateType: DOCUMENT_REVIEW_RESOURCE,
      aggregateId: opened.id,
      aggregateVersion: opened.version,
      type: 'doc.repo.review_submitted.v1',
      schemaVersion: 1,
      payload: { tenant_id: scope.tenant.tenantId, review_id: opened.id, document_id: documentId, project_id: document.project.id, version_id: found.version.id, version_no: found.version.versionNo, round: plan.round, workflow_instance_id: instance.id, actor_id: scope.tenant.membershipId, occurred_at: now.toISOString() },
      eventKey: `${DOCUMENT_REVIEW_RESOURCE}:${opened.id}:submitted`,
    });
    return commandResult(scope, 'IN_REVIEW', opened.version, opened.id);
  }

  @Post('document-reviews/:id/withdraw')
  @HttpCode(200)
  @OperationId('withdrawDocumentReview')
  @Command({ operation: 'withdrawDocumentReview', versioned: true })
  async withdraw(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['DocumentReviewWithdraw']): Promise<CommandResult> {
    const now = new Date();
    if (typeof body.reason !== 'string' || body.reason.trim().length < 10 || body.reason.length > 2000) throw new DomainError('VALIDATION_FAILED', 422, 'reason');
    const review = await this.reviews.find(scope.tx, id.toLowerCase());
    const document = review === undefined ? undefined : await this.documents.find(scope.tx, review.documentId, projectScope(access, PERMISSIONS.withdrawDocumentReview, now), now);
    if (review === undefined || document === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const done = await this.reviews.withdraw(scope.tx, review.id, scope.expectedVersion ?? 0, scope.tenant.membershipId, body.reason.trim());
    await this.approvals.cancel(scope, { resourceType: DOCUMENT_REVIEW_RESOURCE, resourceId: review.id, reason: 'The sender withdrew the review of the document.', now });
    await scope.audit({
      action: 'doc.repo.review_withdrawn',
      resourceType: DOCUMENT_REVIEW_RESOURCE,
      resourceId: review.id,
      classification: classificationOf(document.securityClass),
      reason: body.reason.trim(),
      diff: { document_id: review.documentId, project_id: document.project.id, version_id: review.versionId, round: review.round },
    });
    await scope.emit({
      aggregateType: DOCUMENT_REVIEW_RESOURCE,
      aggregateId: review.id,
      aggregateVersion: done.after.version,
      type: 'doc.repo.review_withdrawn.v1',
      schemaVersion: 1,
      payload: { tenant_id: scope.tenant.tenantId, review_id: review.id, document_id: review.documentId, project_id: document.project.id, version_id: review.versionId, round: review.round, actor_id: scope.tenant.membershipId, occurred_at: now.toISOString() },
      eventKey: `${DOCUMENT_REVIEW_RESOURCE}:${review.id}:withdrawn`,
    });
    return commandResult(scope, 'WITHDRAWN', done.after.version, review.id);
  }
}

/** A query value that must be one non-empty string or absent. */
function queryText(value: unknown, field: string, max = 40): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim() === '' || value.length > max) throw new DomainError('VALIDATION_FAILED', 422, field);
  return value.trim();
}

function queryUuid(value: unknown, field: string): string | undefined {
  const given = queryText(value, field, 36);
  if (given === undefined) return undefined;
  const id = asUuid(given);
  if (id === undefined) throw new DomainError('VALIDATION_FAILED', 422, field);
  return id;
}

/** The board of a review and the list of reviews (DOC-26): read in the scope of the caller over the project of the document. */
@Controller()
export class DocumentReviewReadsController {
  private readonly documents = new DocumentRepositoryStore();
  private readonly reviews = new DocumentReviewStore();
  private readonly comments = new DocumentCommentStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get('document-reviews')
  @OperationId('listDocumentReviews')
  async list(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Query() query: Record<string, unknown>): Promise<Record<string, unknown>> {
    const now = new Date();
    const request = parsePageRequest(query.limit, query.cursor);
    const statusText = queryText(query.status, 'status');
    const status = statusText === undefined ? undefined : DOCUMENT_REVIEW_STATUSES.find((candidate) => candidate === statusText);
    if (statusText !== undefined && status === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'status');
    const filter = { projectId: queryUuid(query.project_id, 'project_id'), documentId: queryUuid(query.document_id, 'document_id'), status: status as DocumentReviewStatus | undefined };
    const page = await this.database.withTenant(tenant, (tx) =>
      this.reviews.list(tx, filter, projectScope(access, PERMISSIONS.listDocumentReviews, now), { limit: request.limit, after: request.after === undefined ? undefined : { key: request.after.code, id: request.after.id } }),
    );
    return {
      items: page.items.map((row) => ({
        id: row.id,
        document_id: row.documentId,
        document_title: row.documentTitle,
        doc_class: row.docClass,
        project: row.project,
        version_id: row.versionId,
        version_no: row.versionNo,
        round: row.round,
        status: row.status,
        submitted_by_name: row.submittedByName,
        submitted_at: row.submittedAt,
        concluded_at: row.concludedAt,
        current_stage: row.currentStage,
      })),
      next_cursor: page.more && page.last !== undefined ? encodeCursor({ code: page.last.key, id: page.last.id }) : null,
      as_of: now.toISOString(),
    };
  }

  @Get('document-reviews/:id')
  @OperationId('getDocumentReview')
  async detail(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    const now = new Date();
    return this.database.withTenant(tenant, async (tx) => {
      const review = await this.reviews.find(tx, id.toLowerCase());
      const document = review === undefined ? undefined : await this.documents.find(tx, review.documentId, projectScope(access, PERMISSIONS.getDocumentReview, now), now);
      if (review === undefined || document === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
      const board = await this.reviews.board(tx, review);
      const events = await this.reviews.events(tx, review.id);
      const open = await this.comments.list(tx, review.versionId, { status: 'OPEN' });
      const submit = (await this.documents.find(tx, document.id, projectScope(access, PERMISSIONS.submitDocumentForReview, now), now)) !== undefined;
      const latest = await this.reviews.latestOf(tx, document.id);
      return {
        review: reviewRoundDto(review),
        document: { id: document.id, title: document.title, reference: document.reference, doc_class: document.docClass, project: document.project },
        stages: board.stages.map((stage) => ({
          index: stage.index,
          id: stage.id,
          name: stage.name,
          min_approvals: stage.minApprovals,
          approvals: stage.approvals,
          state: stage.state,
          reviewers: stage.reviewers.map((reviewer) => ({
            task_id: reviewer.taskId,
            assignee_id: reviewer.assigneeId,
            assignee_name: reviewer.assigneeName,
            state: reviewer.state,
            decision: reviewer.decision,
            reason: reviewer.reason,
            decided_at: reviewer.decidedAt,
            due_at: reviewer.dueAt,
            can_decide: reviewer.state === 'PENDING' && reviewer.assigneeId === tenant.membershipId,
            task_version: reviewer.state === 'PENDING' && reviewer.assigneeId === tenant.membershipId ? reviewer.taskVersion : null,
          })),
        })),
        workflow_revision: board.workflowRevision,
        instance_status: board.instanceStatus,
        outcome: board.outcome,
        events: events.map(eventDto),
        open_comments: open.length,
        actions: {
          withdraw: submit && review.status === 'IN_REVIEW' && review.submittedBy === tenant.membershipId,
          resubmit: submit && latest?.id === review.id && (review.status === 'SUPPLEMENT_REQUESTED' || review.status === 'REJECTED') && document.status === 'ACTIVE',
        },
        as_of: now.toISOString(),
      };
    });
  }
}

/**
 * The end of the workflow of a review, bound to the business type `document.review` of the approval engine (ADM 3.7 item 6). The engine calls it in the transaction of the last decision, with a key that makes a retry
 * harmless: the review, the version and the lock move together, the trail and the events are written in the same transaction, and a round that is not open any more is refused (`GUARD_REJECTED`), which the engine records.
 */
@Injectable()
export class DocumentReviewBinding {
  constructor(@Inject(APPROVAL_FINAL_COMMANDS) registry: FinalCommandRegistry, @Inject(TenantDatabase) database: TenantDatabase) {
    const reviews = new DocumentReviewStore();
    const audit = new AuditWriter(database);
    registry.register(DOCUMENT_REVIEW_BUSINESS_TYPE, async (call) => {
      const done = await reviews.conclude(call.tx, call.instance.id, call.instance.decisionSeq, call.outcome);
      if (done.kind === 'REFUSED') return 'GUARD_REJECTED';
      const { review, end } = done;
      const actor = done.decidedBy ?? call.instance.initiatorId;
      const correlationId = randomUUID();
      const [header] = await call.tx.query<{ security_class: string; project_id: string }>('select d.security_class, d.project_id from machvon.project_document d where d.id = $1::uuid', [review.documentId]);
      await audit.recordInTx(call.tx, actor, {
        action: `doc.repo.review_${end.eventKind.toLowerCase()}`,
        resourceType: DOCUMENT_REVIEW_RESOURCE,
        resourceId: review.id,
        classification: classificationOf(header?.security_class ?? 'CONFIDENTIAL'),
        diff: { document_id: review.documentId, version_id: review.versionId, version_no: review.versionNo, round: review.round, outcome: end.reviewStatus, locked: end.versionStatus === 'APPROVED', has_reason: done.reason !== null, idempotency_key: call.idempotencyKey },
        correlationId,
        requestId: randomUUID(),
      });
      const payload = { review_id: review.id, document_id: review.documentId, project_id: header?.project_id ?? null, version_id: review.versionId, version_no: review.versionNo, round: review.round, actor_id: actor, occurred_at: new Date().toISOString() };
      await enqueueOutbox(call.tx, {
        aggregateType: DOCUMENT_REVIEW_RESOURCE,
        aggregateId: review.id,
        aggregateVersion: review.version,
        type: 'doc.repo.review_concluded.v1',
        schemaVersion: 1,
        payload: { ...payload, outcome: end.reviewStatus },
        eventKey: `${DOCUMENT_REVIEW_RESOURCE}:${review.id}:concluded`,
        correlationId,
      });
      if (end.versionStatus === 'APPROVED') {
        await enqueueOutbox(call.tx, {
          aggregateType: 'project_document_version',
          aggregateId: review.versionId,
          aggregateVersion: 1,
          type: 'doc.repo.version_locked.v1',
          schemaVersion: 1,
          payload,
          eventKey: `project_document_version:${review.versionId}:locked`,
          correlationId,
        });
      }
      return 'APPLIED';
    });
  }
}

