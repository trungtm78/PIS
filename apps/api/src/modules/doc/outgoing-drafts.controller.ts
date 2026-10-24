import { Body, Controller, Get, HttpCode, Inject, Optional, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import {
  AuditWriter,
  DocumentStore,
  NIL_RESOURCE_ID,
  NumberRegisterStore,
  OUTGOING_SCOPE_COLUMNS,
  OutgoingDocumentStore,
  OutgoingDraftStore,
  SignatureStore,
  SignerAuthorityStore,
  TenantDatabase,
  scopePredicate,
} from '@machvon/db';
import type { DocumentClassification, DraftPatch, DraftRecipient, OutgoingDocumentRecord, OutgoingEventRecord, SigningMode, TemplateRecord, TenantTx } from '@machvon/db';
import { DomainError, NOOP_METRICS, vietnamDateOf, versionConflict } from '@machvon/kernel';
import type { EffectiveAccess, MetricsSink, PdfRenderer, TenantContext } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { CurrentTenant } from '../../tenant-context.decorator';
import { DOCUMENT_FILE_PORT } from './file-port';
import type { DocumentFilePort } from './file-port';
import { formatCheckFailed, checklistFailures, normaliseRecipients, normalisedPayload, payloadWithBlocks, readinessFailures, recipientNames, stateSecretDeclaration, storedChecklist } from './outgoing-rules';
import type { FormatFailure } from './outgoing-rules';
import type { StateText } from './pdf-renderer';
import { DocumentRenderService } from './render-service';
import { SignerAuthority } from './signer-authority';
import type { SignerAuthorization, SignerCheck } from './signer-authority';
import type { SigningProvider } from './signing-port';
import type { SigningPort } from './signing-port';
import { buildContent, missingPayloadFields } from './template-render';
import { DOC_CLOCK, DOC_METRICS, DOC_SIGNING_PORT, DOC_STATE_TEXT, PDF_RENDERER } from './tokens';
import { mayActOnUnit } from './unit-scope';

const OUTGOING_TYPE = 'outgoing_document';
const PDF_MIME = 'application/pdf';
const SUBJECT_MODULE = /^[A-Z]{2,10}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MIN_REASON_CHARS = 10;
const MIN_TITLE_CHARS = 3;

type ReasonCode = 'CANCELLED_BY_DRAFTER' | 'REJECTED_BY_LEADER' | 'SUPERSEDED_BEFORE_ISSUE' | 'SOURCE_WITHDRAWN';

const lower = (id: string): string => id.toLowerCase();

/** The title as it is kept: NFC and trimmed, and still the 3 characters the contract asks for (blanks pass the length of the schema and say nothing). */
function titleOf(raw: string): string {
  const title = raw.normalize('NFC').trim();
  if (title.length < MIN_TITLE_CHARS) throw new DomainError('VALIDATION_FAILED', 422, 'title');
  return title;
}

function eventPayload(scope: CommandScope, document: OutgoingDocumentRecord, version: number, now: Date, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tenant_id: scope.tenant.tenantId,
    document_id: document.documentId,
    outgoing_document_id: document.id,
    version,
    actor_id: scope.tenant.membershipId,
    occurred_at: now.toISOString(),
    ...extra,
  };
}

/**
 * Composing an outgoing document, its review and the lock of its final PDF (ST-DOC-007, DOC.md F1 and F3): a draft from a template,
 * edited under If-Match until it is sent for review; a reviewer other than the drafter confirms the format checklist and the signer's
 * authority, and the final PDF is rendered, stored with its SHA-256 and locked by the state SUBMITTED. Every step writes the audit row,
 * the outbox event and the status history in the command transaction.
 */
@Controller()
export class OutgoingDraftsController {
  private readonly outgoing = new OutgoingDocumentStore();
  private readonly drafts = new OutgoingDraftStore();
  private readonly documents = new DocumentStore();
  private readonly registers = new NumberRegisterStore();
  private readonly signatures = new SignatureStore();
  private readonly organisation = new SignerAuthorityStore();
  private readonly authority = new SignerAuthority();
  private readonly audit: AuditWriter;
  private readonly rendering: DocumentRenderService;
  private readonly text: StateText;
  private readonly metrics: MetricsSink;
  private readonly clock: () => Date;

  constructor(
    @Inject(TenantDatabase) private readonly database: TenantDatabase,
    @Inject(DOCUMENT_FILE_PORT) private readonly files: DocumentFilePort,
    @Inject(PDF_RENDERER) renderer: PdfRenderer,
    @Inject(DOC_STATE_TEXT) text: StateText,
    @Inject(DOC_SIGNING_PORT) private readonly signing: SigningPort,
    @Optional() @Inject(DOC_METRICS) metrics?: MetricsSink,
    @Optional() @Inject(DOC_CLOCK) clock?: () => Date,
  ) {
    this.metrics = metrics ?? NOOP_METRICS;
    this.clock = clock ?? ((): Date => new Date());
    this.audit = new AuditWriter(database);
    this.text = text;
    this.rendering = new DocumentRenderService({ files, renderer, text, metrics: this.metrics, documents: this.documents });
  }

  @Post('outgoing-documents')
  @HttpCode(200)
  @OperationId('createOutgoingDocument')
  @Command({ operation: 'createOutgoingDocument' })
  async create(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['DocOutgoingCreate']): Promise<CommandResult & Record<string, unknown>> {
    const now = this.clock();
    const today = vietnamDateOf(now);
    const actor = scope.tenant.membershipId;
    const unitId = lower(body.drafting_unit_id);
    const unit = await this.registers.unitRef(scope.tx, unitId);
    if (unit === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'drafting_unit_id');
    if (!mayActOnUnit(access, PERMISSIONS.createOutgoingDocument, unit, now)) throw new DomainError('SCOPE_DENIED', 403);
    await this.refuseStateSecret(scope, [body.payload, body.content_blocks]);
    const docType = await this.documents.docTypeFor(scope.tx, body.doc_type_code, today);
    if (docType === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'doc_type_code');
    const template = await this.templateFor(scope.tx, body.doc_type_code, body.template_code, today);
    const normalised = normalisedPayload(payloadWithBlocks(body.payload ?? {}, body.content_blocks));
    const recipients = await this.recipientsOf(scope.tx, body.recipients);
    const subject = this.subjectOf(body.subject_module, body.subject_id);
    const replyTo = body.reply_to_incoming_id === undefined ? null : lower(body.reply_to_incoming_id);
    if (replyTo !== null && !(await this.incomingExists(scope.tx, replyTo))) throw new DomainError('SUBJECT_REF_INVALID', 422, 'reply_to_incoming_id');
    const signing = await this.signingFacts(scope, { signer: body.signer_user_id, mode: body.signing_mode, delegation: body.delegation_id }, { unitId, now, payloadSigner: normalised.payload.signer_title });
    const urgency = body.urgency ?? 'NORMAL';
    const draft = await this.drafts.createDraft(scope.tx, {
      docTypeCode: body.doc_type_code,
      title: titleOf(body.title),
      draftingUnitId: unitId,
      templateId: template.id,
      layoutProfileId: template.layoutProfileId,
      urgency,
      circulation: body.circulation ?? 'INTERNAL_CIRCULATION',
      classification: 'INTERNAL',
      payload: normalised.payload,
      payloadSha256: normalised.sha256,
      recipients,
      signerUserId: signing.signer,
      signerTitle: signing.title,
      signingMode: signing.mode,
      delegationId: signing.delegation,
      subjectModule: subject?.module ?? null,
      subjectId: subject?.id ?? null,
      replyToIncomingId: replyTo,
      reviewDueOn: null,
      actor,
    });
    await this.drafts.appendEvent(scope.tx, { outgoingDocumentId: draft.id, kind: 'CREATED', fromStatus: null, toStatus: 'DRAFT', actor, documentVersion: draft.version, occurredAt: now, details: { template_id: template.id } });
    await scope.audit({
      action: 'outgoing_document.create',
      resourceType: OUTGOING_TYPE,
      resourceId: draft.id,
      diff: {
        doc_type_code: draft.docTypeCode,
        template_id: template.id,
        drafting_unit_id: unitId,
        payload_sha256: normalised.sha256,
        recipient_count: recipients.length,
        signer_user_id: signing.signer,
        signing_mode: signing.mode,
        urgency,
      },
    });
    await scope.emit({
      aggregateType: OUTGOING_TYPE,
      aggregateId: draft.id,
      aggregateVersion: draft.version,
      type: 'doc.draft_created.v1',
      schemaVersion: 1,
      payload: eventPayload(scope, draft, draft.version, now, { doc_type_code: draft.docTypeCode, template_id: template.id }),
      eventKey: `${OUTGOING_TYPE}:${draft.id}:${draft.version}`,
    });
    this.metrics.increment('doc_draft_total', { outcome: 'created' });
    return { ...commandResult(scope, 'DRAFT', draft.version, draft.id), document_id: draft.documentId };
  }

  @Post('outgoing-documents/:id/draft')
  @HttpCode(200)
  @OperationId('updateOutgoingDocumentDraft')
  @Command({ operation: 'updateOutgoingDocumentDraft', versioned: true })
  async updateDraft(
    @Scope() scope: CommandScope,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: Schemas['DocOutgoingDraftChange'],
  ): Promise<CommandResult> {
    const now = this.clock();
    const actor = scope.tenant.membershipId;
    const document = await this.lockDocument(scope, access, id, PERMISSIONS.updateOutgoingDocumentDraft, now);
    this.assertVersion(document, scope);
    if (document.status !== 'DRAFT') throw new DomainError('DOCUMENT_STATE_INVALID', 409, 'status');
    const changed = Object.keys(body).filter((key) => (body as Record<string, unknown>)[key] !== undefined);
    if (changed.length === 0) throw new DomainError('VALIDATION_FAILED', 422, 'body');
    await this.refuseStateSecret(scope, [body.payload, body.content_blocks], document.id);
    const patch: DraftPatch = {};
    const diff: Record<string, unknown> = { changed };
    let payloadNow: Record<string, unknown> | undefined;
    if (body.title !== undefined) patch.title = titleOf(body.title);
    if (body.payload !== undefined || body.content_blocks !== undefined) {
      // The stored payload already holds the blocks of the last edit under `content_blocks`; blocks sent now replace them instead of clashing with them.
      const stored = body.payload === undefined ? (await this.drafts.contentOf(scope.tx, document.id))?.payload : undefined;
      const current = body.payload ?? (stored !== undefined && body.content_blocks !== undefined ? Object.fromEntries(Object.entries(stored).filter(([name]) => name !== 'content_blocks')) : stored);
      const normalised = normalisedPayload(payloadWithBlocks(current ?? {}, body.content_blocks));
      patch.payload = normalised.payload;
      patch.payloadSha256 = normalised.sha256;
      payloadNow = normalised.payload;
      diff.payload_sha256 = normalised.sha256;
    }
    if (body.recipients !== undefined) {
      patch.recipients = await this.recipientsOf(scope.tx, body.recipients);
      diff.recipient_count = patch.recipients.length;
    }
    if (body.urgency !== undefined) patch.urgency = body.urgency;
    if (body.review_due_on !== undefined) patch.reviewDueOn = body.review_due_on;
    if (body.signer_user_id !== undefined || body.signing_mode !== undefined || body.delegation_id !== undefined) {
      const mode = body.signing_mode ?? (document.signingMode as SigningMode);
      // Changing the mode without naming a delegation drops the old one, so a DIRECT document never keeps a delegation behind.
      const delegation = body.delegation_id ?? (mode === 'DIRECT' || body.signing_mode !== undefined ? undefined : (document.delegationId ?? undefined));
      const facts = await this.signingFacts(
        scope,
        { signer: body.signer_user_id ?? document.signerUserId ?? undefined, mode, delegation },
        { unitId: document.draftingUnitId, now, payloadSigner: (payloadNow ?? (await this.drafts.contentOf(scope.tx, document.id))?.payload)?.signer_title },
      );
      if (facts.signer !== null) patch.signerUserId = facts.signer;
      patch.signingMode = facts.mode;
      patch.delegationId = facts.delegation;
      patch.signerTitle = facts.title;
      diff.signer_user_id = facts.signer;
      diff.signing_mode = facts.mode;
    } else if (payloadNow !== undefined) {
      patch.signerTitle = typeof payloadNow.signer_title === 'string' ? payloadNow.signer_title : (document.signerTitle ?? null);
    }
    const updated = await this.drafts.updateDraft(scope.tx, document.id, { expectedVersion: document.version, patch, actor });
    await scope.audit({ action: 'outgoing_document.draft.update', resourceType: OUTGOING_TYPE, resourceId: document.id, diff });
    await scope.emit({
      aggregateType: OUTGOING_TYPE,
      aggregateId: document.id,
      aggregateVersion: updated.version,
      type: 'doc.draft_updated.v1',
      schemaVersion: 1,
      payload: eventPayload(scope, document, updated.version, now, { changed }),
      eventKey: `${OUTGOING_TYPE}:${document.id}:${updated.version}`,
    });
    return commandResult(scope, 'DRAFT', updated.version, document.id);
  }

  @Post('outgoing-documents/:id/review-submission')
  @HttpCode(200)
  @OperationId('submitOutgoingDocumentForReview')
  @Command({ operation: 'submitOutgoingDocumentForReview', versioned: true })
  async submitForReview(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<CommandResult> {
    const now = this.clock();
    const actor = scope.tenant.membershipId;
    const document = await this.lockDocument(scope, access, id, PERMISSIONS.submitOutgoingDocumentForReview, now);
    this.assertVersion(document, scope);
    if (document.status !== 'DRAFT') throw new DomainError('DOCUMENT_STATE_INVALID', 409, 'status');
    const content = await this.drafts.contentOf(scope.tx, document.id);
    const failures = await this.draftFailures(scope.tx, document, content?.payload ?? {}, vietnamDateOf(now));
    if (failures.length > 0) throw formatCheckFailed(failures);
    const authorization = await this.authorise(scope, document, content?.payload ?? {}, now);
    const moved = await this.drafts.submit(scope.tx, document.id, { expectedVersion: document.version, actor });
    await this.drafts.appendEvent(scope.tx, {
      outgoingDocumentId: document.id,
      kind: 'REVIEW_REQUESTED',
      fromStatus: 'DRAFT',
      toStatus: 'IN_REVIEW',
      actor,
      documentVersion: moved.version,
      occurredAt: now,
      details: { payload_sha256: document.payloadSha256, signer_user_id: document.signerUserId, signing_mode: document.signingMode, matrix_version_id: authorization.matrixVersionId },
    });
    await scope.audit({
      action: 'outgoing_document.review.request',
      resourceType: OUTGOING_TYPE,
      resourceId: document.id,
      diff: { payload_sha256: document.payloadSha256, signer_user_id: document.signerUserId, signing_mode: document.signingMode, matrix_version_id: authorization.matrixVersionId, rule_id: authorization.ruleId },
    });
    await scope.emit({
      aggregateType: OUTGOING_TYPE,
      aggregateId: document.id,
      aggregateVersion: moved.version,
      type: 'doc.review_requested.v1',
      schemaVersion: 1,
      payload: eventPayload(scope, document, moved.version, now, { signer_user_id: document.signerUserId }),
      eventKey: `${OUTGOING_TYPE}:${document.id}:${moved.version}`,
    });
    this.metrics.increment('doc_review_total', { outcome: 'requested' });
    return commandResult(scope, 'IN_REVIEW', moved.version, document.id);
  }

  @Post('outgoing-documents/:id/review-decision')
  @HttpCode(200)
  @OperationId('decideOutgoingDocumentReview')
  @Command({ operation: 'decideOutgoingDocumentReview', versioned: true })
  async decideReview(
    @Scope() scope: CommandScope,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: Schemas['DocReviewDecision'],
  ): Promise<CommandResult & Record<string, unknown>> {
    const now = this.clock();
    const actor = scope.tenant.membershipId;
    const document = await this.lockDocument(scope, access, id, PERMISSIONS.decideOutgoingDocumentReview, now);
    this.assertVersion(document, scope);
    if (document.status !== 'IN_REVIEW') throw new DomainError('DOCUMENT_STATE_INVALID', 409, 'status');
    const comment = body.comment === undefined ? null : body.comment.normalize('NFC').trim();
    if (body.decision === 'RETURN') {
      if (comment === null || comment.length < MIN_REASON_CHARS) throw new DomainError('VALIDATION_FAILED', 422, 'comment');
      return this.sendBack(scope, document, comment, now, 'review');
    }
    // The drafter never approves what they drafted (BR-DOC-24).
    if (document.drafterUserId === actor) throw new DomainError('SELF_APPROVAL_DENIED', 403, 'decision');
    const checklist = body.format_checklist;
    const failures = checklistFailures(checklist);
    if (failures.length > 0) throw formatCheckFailed(failures);
    const content = await this.drafts.contentOf(scope.tx, document.id);
    const authorization = await this.authorise(scope, document, content?.payload ?? {}, now);
    const final = await this.lockFinalPdf(scope, document, content?.payload ?? {}, now);
    const approved = await this.drafts.approve(scope.tx, document.id, { expectedVersion: document.version, actor });
    const details = {
      checklist: storedChecklist(checklist),
      file_sha256: final.checksum,
      version_id: final.versionId,
      matrix_version_id: authorization.matrixVersionId,
      rule_id: authorization.ruleId,
      watermarked: final.watermarked,
    };
    await this.drafts.appendEvent(scope.tx, { outgoingDocumentId: document.id, kind: 'REVIEW_APPROVED', fromStatus: 'IN_REVIEW', toStatus: 'SUBMITTED', actor, comment, documentVersion: approved.version, occurredAt: now, details });
    await scope.audit({ action: 'outgoing_document.review.approve', resourceType: OUTGOING_TYPE, resourceId: document.id, diff: details });
    await scope.emit({
      aggregateType: OUTGOING_TYPE,
      aggregateId: document.id,
      aggregateVersion: approved.version,
      type: 'doc.submitted.v1',
      schemaVersion: 1,
      payload: eventPayload(scope, document, approved.version, now, { file_sha256: final.checksum, version_id: final.versionId, signer_user_id: document.signerUserId }),
      eventKey: `${OUTGOING_TYPE}:${document.id}:${approved.version}`,
    });
    this.metrics.increment('doc_review_total', { outcome: 'approved' });
    return { ...commandResult(scope, 'SUBMITTED', approved.version, document.id), file_sha256: final.checksum, version_id: final.versionId };
  }

  @Post('outgoing-documents/:id/return')
  @HttpCode(200)
  @OperationId('returnOutgoingDocument')
  @Command({ operation: 'returnOutgoingDocument', versioned: true })
  async returnDocument(
    @Scope() scope: CommandScope,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: Schemas['DocReason'],
  ): Promise<CommandResult & Record<string, unknown>> {
    const now = this.clock();
    const document = await this.lockDocument(scope, access, id, PERMISSIONS.returnOutgoingDocument, now);
    this.assertVersion(document, scope);
    if (document.status !== 'IN_REVIEW' && document.status !== 'SUBMITTED') throw new DomainError('DOCUMENT_STATE_INVALID', 409, 'status');
    const reason = body.reason.normalize('NFC').trim();
    if (reason.length < MIN_REASON_CHARS) throw new DomainError('VALIDATION_FAILED', 422, 'reason');
    return this.sendBack(scope, document, reason, now, 'return');
  }

  @Post('outgoing-documents/:id/cancellation')
  @HttpCode(200)
  @OperationId('cancelOutgoingDocument')
  @Command({ operation: 'cancelOutgoingDocument', versioned: true })
  async cancelDocument(
    @Scope() scope: CommandScope,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: Schemas['DocCancel'],
  ): Promise<CommandResult> {
    const now = this.clock();
    const actor = scope.tenant.membershipId;
    const document = await this.lockDocument(scope, access, id, PERMISSIONS.cancelOutgoingDocument, now);
    this.assertVersion(document, scope);
    const reason = body.reason.normalize('NFC').trim();
    if (reason.length < MIN_REASON_CHARS) throw new DomainError('VALIDATION_FAILED', 422, 'reason');
    const result = await this.drafts.cancel(scope.tx, document.id, { expectedVersion: document.version, reason, actor });
    const rejectCode = body.reject_code as ReasonCode;
    const sourced = document.sourceModule !== null && document.sourceRef !== null;
    if (document.issueRequestId !== null) await this.drafts.cancelIssueRequest(scope.tx, document.issueRequestId, actor);
    await this.drafts.appendEvent(scope.tx, {
      outgoingDocumentId: document.id,
      kind: 'CANCELLED',
      fromStatus: result.from,
      toStatus: 'CANCELLED',
      actor,
      comment: reason,
      documentVersion: result.document.version,
      occurredAt: now,
      details: { reject_code: rejectCode },
    });
    await scope.audit({ action: 'outgoing_document.cancel', resourceType: OUTGOING_TYPE, resourceId: document.id, reason, diff: { from_status: result.from, reject_code: rejectCode, source_module: document.sourceModule } });
    await scope.emit({
      aggregateType: OUTGOING_TYPE,
      aggregateId: document.id,
      aggregateVersion: result.document.version,
      type: 'doc.cancelled.v1',
      schemaVersion: 1,
      payload: eventPayload(scope, document, result.document.version, now, { reject_code: rejectCode, from_status: result.from }),
      eventKey: `${OUTGOING_TYPE}:${document.id}:${result.document.version}:cancelled`,
    });
    if (sourced) {
      // The module that asked for the document is told it will not come (BR-DOC-17); it does not mark its record issued.
      await scope.emit({
        aggregateType: OUTGOING_TYPE,
        aggregateId: document.id,
        aggregateVersion: result.document.version,
        type: 'doc.rejected.v1',
        schemaVersion: 1,
        payload: { source_module: document.sourceModule, source_ref: document.sourceRef, payload_sha256: document.payloadSha256, reject_code: rejectCode },
        eventKey: `${OUTGOING_TYPE}:${document.id}:${result.document.version}:rejected`,
      });
    }
    this.afterCancel(scope, result.cancelled);
    this.metrics.increment('doc_draft_total', { outcome: 'cancelled' });
    return commandResult(scope, 'CANCELLED', result.document.version, document.id);
  }

  @Get('documents/:id/timeline')
  @OperationId('getDocumentTimeline')
  async timeline(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    const now = this.clock();
    const loaded = await this.database.withTenant(tenant, async (tx) => {
      const row = await this.outgoing.findByDocument(tx, id, (first) => scopePredicate(access, PERMISSIONS.getDocumentTimeline, now, OUTGOING_SCOPE_COLUMNS, first));
      if (row === undefined) return undefined;
      const [events, versions] = await Promise.all([this.drafts.eventsOf(tx, row.id), this.outgoing.versionsOf(tx, row.documentId)]);
      const signatures = [];
      for (const version of versions) for (const signature of await this.signatures.latest(tx, version.id)) signatures.push({ version_id: version.id, signature });
      return { row, events, versions, signatures };
    });
    // A document the caller cannot see is indistinguishable from one that does not exist.
    if (loaded === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return {
      document_id: loaded.row.documentId,
      outgoing_document_id: loaded.row.id,
      status: loaded.row.status,
      events: loaded.events.map(eventView),
      versions: loaded.versions.map((version) => ({ id: version.id, version: version.version, stage: version.stage, checksum: version.checksum, page_count: version.pageCount, created_at: version.createdAt.toISOString() })),
      signatures: loaded.signatures.map(({ version_id, signature }) => ({
        version_id,
        role: signature.role,
        status: signature.status,
        signed_at: signature.signedAt === null ? null : signature.signedAt.toISOString(),
        verified_at: signature.verifiedAt.toISOString(),
      })),
    };
  }

  /** IN_REVIEW or SUBMITTED back to DRAFT with the reason: the open signing sessions end and the final PDF stops being current. */
  private async sendBack(scope: CommandScope, document: OutgoingDocumentRecord, reason: string, now: Date, via: 'review' | 'return'): Promise<CommandResult & Record<string, unknown>> {
    const actor = scope.tenant.membershipId;
    const result = await this.drafts.returnToDraft(scope.tx, document.id, { expectedVersion: document.version, actor });
    await this.drafts.appendEvent(scope.tx, {
      outgoingDocumentId: document.id,
      kind: 'RETURNED',
      fromStatus: result.from,
      toStatus: 'DRAFT',
      actor,
      comment: reason,
      documentVersion: result.document.version,
      occurredAt: now,
      details: { via },
    });
    await scope.audit({ action: 'outgoing_document.return', resourceType: OUTGOING_TYPE, resourceId: document.id, reason, diff: { from_status: result.from, via } });
    await scope.emit({
      aggregateType: OUTGOING_TYPE,
      aggregateId: document.id,
      aggregateVersion: result.document.version,
      type: 'doc.returned.v1',
      schemaVersion: 1,
      payload: eventPayload(scope, document, result.document.version, now, { from_status: result.from }),
      eventKey: `${OUTGOING_TYPE}:${document.id}:${result.document.version}`,
    });
    this.afterCancel(scope, result.cancelled);
    this.metrics.increment('doc_review_total', { outcome: 'returned' });
    return { ...commandResult(scope, 'DRAFT', result.document.version, document.id) };
  }

  /** Tells the provider to stop the sessions that were open; a provider that cannot be reached is counted, the sessions are cancelled here already. */
  private afterCancel(scope: CommandScope, sessions: ReadonlyArray<{ id: string; adapterCode: string; providerTxnRef: string | null; expiresAt: Date }>): void {
    for (const session of sessions) {
      if (session.providerTxnRef === null) continue;
      const ref = { provider: session.adapterCode as SigningProvider, sessionId: session.providerTxnRef, expiresAt: session.expiresAt };
      scope.afterCommit(async () => {
        await this.signing.cancel(ref).catch(() => this.metrics.increment('doc_signing_cancel_failed_total', { role: 'draft' }));
      });
    }
  }

  /** Renders the final PDF (revision 0, with the fields to fill and sign), stores it under the document and returns what identifies it. */
  private async lockFinalPdf(
    scope: CommandScope,
    document: OutgoingDocumentRecord,
    payload: Record<string, unknown>,
    now: Date,
  ): Promise<{ versionId: string; checksum: string; watermarked: boolean }> {
    if (document.templateId === null) throw new DomainError('TEMPLATE_NOT_EFFECTIVE', 422, 'template_id');
    const asOfDate = vietnamDateOf(now);
    const composed = await this.rendering.compose(scope.tx, { templateId: document.templateId, asOfDate, payload: this.faceOf(document, payload), signatureFields: true });
    const key = `tenants/${scope.tenant.tenantId}/documents/${document.documentId}-${composed.rendered.sha256}.pdf`;
    await this.files.put(key, composed.rendered.bytes, PDF_MIME);
    // The render is deterministic: the same text on the same day gives the file that an earlier approval stored, which is current again.
    const earlier = await this.documents.versionByKey(scope.tx, document.documentId, key);
    if (earlier !== undefined) {
      await this.documents.pointAt(scope.tx, document.documentId, earlier.id, scope.tenant.membershipId);
      return { versionId: earlier.id, checksum: earlier.checksum, watermarked: composed.watermarked };
    }
    const appended = await this.documents.appendVersion(scope.tx, {
      documentId: document.documentId,
      objectKey: key,
      checksum: composed.rendered.sha256,
      mime: PDF_MIME,
      pageCount: composed.rendered.pageCount,
      classification: document.classification as DocumentClassification,
      stage: 'RENDERED_FINAL',
      byteLength: composed.rendered.bytes.length,
      rendererVersion: composed.rendered.rendererVersion,
      templateId: document.templateId,
      createdBy: scope.tenant.membershipId,
    });
    // The bytes come from the platform renderer, not from an upload: there is nothing for the malware scan to find.
    const stored = await this.documents.setScanResult(scope.tx, appended.id, 'CLEAN');
    return { versionId: stored.id, checksum: stored.checksum, watermarked: composed.watermarked };
  }

  /** What the face of the document prints: the payload, with the recipients, the title and the signer's position the document itself holds. */
  private faceOf(document: OutgoingDocumentRecord, payload: Record<string, unknown>): Record<string, unknown> {
    const recipients = recipientNames((document.recipients as DraftRecipient[]) ?? []);
    return {
      ...payload,
      summary: payload.summary ?? document.title,
      ...(recipients.length > 0 ? { recipients } : {}),
      ...(document.signerTitle !== null && payload.signer_title === undefined ? { signer_title: document.signerTitle } : {}),
    };
  }

  /** The reasons a draft cannot go to review: the template, the people, then the payload read against the template. */
  private async draftFailures(tx: TenantTx, document: OutgoingDocumentRecord, payload: Record<string, unknown>, today: string): Promise<FormatFailure[]> {
    const failures = readinessFailures({
      recipientCount: ((document.recipients as unknown[]) ?? []).length,
      signerUserId: document.signerUserId,
      signingMode: document.signingMode,
      delegationId: document.delegationId,
    });
    const template = document.templateId === null ? undefined : await this.documents.templateInForce(tx, document.templateId, today);
    if (template === undefined) return [{ field: 'template_id', code: 'TEMPLATE_NOT_EFFECTIVE' }, ...failures];
    const face = this.faceOf(document, payload);
    const missing = missingPayloadFields(face, template.placeholderSchema);
    if (missing.length > 0) return [...failures, ...missing.map((field) => ({ field: `payload.${field}`, code: 'PAYLOAD_FIELD_REQUIRED' }))];
    try {
      buildContent(
        { template: { title: template.title, docTypeCode: template.docTypeCode, bodyBlocks: template.bodyBlocks, placeholderSchema: template.placeholderSchema }, payload: face, asOfDate: today },
        this.text,
      );
    } catch (error) {
      if (!(error instanceof DomainError) || error.code !== 'PAYLOAD_SCHEMA_INVALID') throw error;
      const fields = (error.extensions?.fields as string[] | undefined) ?? [error.detail ?? 'payload'];
      return [...failures, ...fields.map((field) => ({ field: `payload.${field}`, code: 'PAYLOAD_FIELD_REQUIRED' }))];
    }
    return failures;
  }

  /** The signer of the document against the DoA matrix and the delegation; a refusal is recorded as DENIED and answered 422 with the threshold. */
  private async authorise(scope: CommandScope, document: OutgoingDocumentRecord, payload: Record<string, unknown>, now: Date): Promise<SignerAuthorization> {
    const check: SignerCheck = {
      documentType: document.docTypeCode,
      amountVnd: typeof payload.amount_vnd === 'string' ? payload.amount_vnd : null,
      draftingUnitId: document.draftingUnitId,
      signerId: document.signerUserId ?? NIL_RESOURCE_ID,
      signingMode: document.signingMode,
      delegationId: document.delegationId,
      at: now,
      businessDate: vietnamDateOf(now),
    };
    try {
      return await this.authority.authorise(scope.tx, check);
    } catch (error) {
      if (error instanceof DomainError && error.code === 'SIGNER_NOT_AUTHORIZED') await this.recordDenied(scope, 'outgoing_document.signer.authorise', document.id, { reason: error.extensions?.reason, signer_user_id: document.signerUserId });
      throw error;
    }
  }

  /** The people and the mode of signing as a draft stores them; a delegation is needed exactly when the signer signs for someone else. */
  private async signingFacts(
    scope: CommandScope,
    input: { signer: string | undefined; mode: string | undefined; delegation: string | undefined },
    context: { unitId: string; now: Date; payloadSigner: unknown },
  ): Promise<{ signer: string | null; mode: SigningMode; delegation: string | null; title: string | null }> {
    const mode = (input.mode ?? 'DIRECT') as SigningMode;
    const signer = input.signer === undefined ? null : lower(input.signer);
    const delegation = input.delegation === undefined ? null : lower(input.delegation);
    const title = typeof context.payloadSigner === 'string' ? context.payloadSigner : null;
    if (signer !== null && !(await this.organisation.isActiveMember(scope.tx, signer, context.now))) throw new DomainError('VALIDATION_FAILED', 422, 'signer_user_id');
    if (mode === 'DIRECT') {
      if (delegation !== null) throw new DomainError('VALIDATION_FAILED', 422, 'delegation_id');
      return { signer, mode, delegation: null, title };
    }
    // A document signed for someone else (KT., TM., TL., TUQ.) names the delegation that gives the signer the right (BR-DOC-08).
    if (signer !== null || delegation !== null) {
      const check: SignerCheck = {
        documentType: '',
        amountVnd: null,
        draftingUnitId: context.unitId,
        signerId: signer ?? NIL_RESOURCE_ID,
        signingMode: mode,
        delegationId: delegation,
        at: context.now,
        businessDate: vietnamDateOf(context.now),
      };
      try {
        await this.authority.assertDelegation(scope.tx, check);
      } catch (error) {
        if (error instanceof DomainError && error.code === 'SIGNER_NOT_AUTHORIZED') await this.recordDenied(scope, 'outgoing_document.signer.authorise', NIL_RESOURCE_ID, { reason: error.extensions?.reason, signing_mode: mode });
        throw error;
      }
    } else {
      await this.recordDenied(scope, 'outgoing_document.signer.authorise', NIL_RESOURCE_ID, { reason: 'DELEGATION_MISSING', signing_mode: mode });
      throw new DomainError('SIGNER_NOT_AUTHORIZED', 422, 'delegation_id', { extensions: { reason: 'DELEGATION_MISSING' } });
    }
    return { signer, mode, delegation, title };
  }

  private async refuseStateSecret(scope: CommandScope, parts: readonly unknown[], resourceId: string = NIL_RESOURCE_ID): Promise<void> {
    for (const part of parts) {
      const found = part === undefined ? undefined : stateSecretDeclaration(part);
      if (found === undefined) continue;
      // Nothing of the content goes into the audit row: the member that declared the level is enough to see why.
      await this.recordDenied(scope, 'outgoing_document.create', resourceId, { reason: 'STATE_SECRET_NOT_SUPPORTED', field: found });
      throw new DomainError('STATE_SECRET_NOT_SUPPORTED', 422, found);
    }
  }

  /** A denial in its own transaction: the command rolls back and the row stays. */
  private async recordDenied(scope: CommandScope, action: string, resourceId: string, diff: Record<string, unknown>): Promise<void> {
    await this.audit.recordDenied(scope.tenant, { action, resourceType: OUTGOING_TYPE, resourceId, diff, correlationId: scope.correlationId, requestId: scope.requestId });
  }

  private async templateFor(tx: TenantTx, docTypeCode: string, templateCode: string | undefined, today: string): Promise<TemplateRecord> {
    const template = templateCode === undefined ? await this.documents.templateForDocType(tx, docTypeCode, today) : await this.documents.templateFor(tx, { templateCode }, today);
    if (template === undefined) throw new DomainError('TEMPLATE_NOT_EFFECTIVE', 422, 'template_code');
    if (template.docTypeCode !== docTypeCode) throw new DomainError('VALIDATION_FAILED', 422, 'template_code');
    return template;
  }

  private async recipientsOf(tx: TenantTx, raw: readonly object[] | undefined): Promise<DraftRecipient[]> {
    const recipients = normaliseRecipients(raw);
    for (const [index, recipient] of recipients.entries()) {
      if (recipient.unit_id !== undefined && (await this.registers.unitRef(tx, recipient.unit_id)) === undefined) throw new DomainError('VALIDATION_FAILED', 422, `recipients[${index}].unit_id`);
    }
    return recipients;
  }

  private subjectOf(module: string | undefined, id: string | undefined): { module: string; id: string } | undefined {
    if (module === undefined && id === undefined) return undefined;
    if (module === undefined || id === undefined || !SUBJECT_MODULE.test(module) || !UUID.test(lower(id))) throw new DomainError('SUBJECT_REF_INVALID', 422, 'subject_id');
    return { module, id: lower(id) };
  }

  private async incomingExists(tx: TenantTx, id: string): Promise<boolean> {
    const [row] = await tx.query<{ found: boolean }>('select exists (select 1 from machvon.incoming_document where id = $1::uuid) as found', [id]);
    return row?.found === true;
  }

  private async lockDocument(scope: CommandScope, access: EffectiveAccess, id: string, permission: string, now: Date): Promise<OutgoingDocumentRecord> {
    // A document the caller cannot see is indistinguishable from one that does not exist.
    const document = await this.outgoing.lock(scope.tx, id, (first) => scopePredicate(access, permission, now, OUTGOING_SCOPE_COLUMNS, first));
    if (document === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return document;
  }

  private assertVersion(document: OutgoingDocumentRecord, scope: CommandScope): void {
    if (document.version !== scope.expectedVersion) throw versionConflict(document.version);
  }
}

function eventView(event: OutgoingEventRecord): Record<string, unknown> {
  return {
    id: event.id,
    kind: event.kind,
    from_status: event.fromStatus,
    to_status: event.toStatus,
    actor_id: event.actorId,
    comment: event.comment,
    details: event.details,
    document_version: event.documentVersion,
    occurred_at: event.occurredAt.toISOString(),
  };
}
