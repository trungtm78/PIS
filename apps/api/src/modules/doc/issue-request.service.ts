import { DocIssueRequestStore, DocumentStore, NumberRegisterStore, OutgoingDraftStore, SignerAuthorityStore } from '@machvon/db';
import type { AuditEntry, DraftRecipient, IssueRequestRecord, OutboxEventInput, RejectCode, SigningMode, TemplateRecord, TenantTx } from '@machvon/db';
import { DomainError, NOOP_METRICS, payloadSha256 } from '@machvon/kernel';
import type { MetricsSink } from '@machvon/kernel';
import type { DocumentFilePort } from './file-port';
import { normaliseRecipients, normalisedPayload, stateSecretDeclaration } from './outgoing-rules';
import { missingPayloadFields } from './template-render';

const REQUEST_TYPE = 'doc_issue_request';
const OUTGOING_TYPE = 'outgoing_document';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SOURCE_MODULE = /^[A-Z]{2,10}$/;
const MODES: readonly string[] = ['DIRECT', 'KT', 'TM', 'TL', 'TUQ'];
const MIN_TITLE = 3;
const MAX_TITLE = 500;

/** What a source module asks for (the `DocIssueRequest` of openapi.json, with the identifiers in their stored form). */
export interface IssueRequestInput {
  sourceModule: string;
  sourceRef: string;
  templateCode: string;
  payloadRef: string;
  payloadSha256: string;
  eventId: string;
  /** `drafting_unit_id` (required: the unit that drafts for the module), and optionally `membership_id`, `signing_mode` and `delegation_id` of the signer. */
  signerHint: Record<string, unknown> | null;
  recipients: readonly object[] | undefined;
  asOfDate: string;
}

/** The audit trail and the outbox of the transaction the service works in. */
export interface IssueContext {
  tenantId: string;
  actor: string;
  audit(entry: Omit<AuditEntry, 'correlationId' | 'requestId'>): Promise<unknown>;
  emit(event: Omit<OutboxEventInput, 'correlationId'>): Promise<unknown>;
}

interface Accepted {
  template: TemplateRecord;
  payload: Record<string, unknown>;
  unitId: string;
  recipients: DraftRecipient[];
  signer: string | null;
  mode: SigningMode;
  delegation: string | null;
  title: string;
}

export interface Rejection {
  code: RejectCode;
  /** The members of the request or of the payload that made the refusal, for the answer to the REST caller. */
  fields: string[];
  templateId: string | null;
}

/** How a request stands before anything is written. */
export type IssueDecision =
  | { kind: 'REPLAY'; request: IssueRequestRecord }
  | { kind: 'OPEN'; request: IssueRequestRecord }
  | { kind: 'REJECT'; rejection: Rejection }
  | { kind: 'ACCEPT'; accepted: Accepted };

export type IssueOutcome =
  | { kind: 'ACCEPTED'; request: IssueRequestRecord; outgoingDocumentId: string; documentId: string; version: number }
  | { kind: 'REJECTED'; request: IssueRequestRecord; rejection: Rejection }
  | { kind: 'REPLAY'; request: IssueRequestRecord }
  | { kind: 'OPEN'; request: IssueRequestRecord };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const lower = (value: string): string => value.toLowerCase();

/** The request in its stored form: identifiers in lower case, text trimmed. Shape problems are the caller's 4xx, not a rejection. */
export function normaliseIssueRequest(body: {
  source_module: string;
  source_ref: string;
  template_code: string;
  payload_ref: string;
  payload_sha256: string;
  event_id: string;
  signer_hint?: object | undefined;
  recipients?: readonly object[] | undefined;
  as_of_date: string;
}): IssueRequestInput {
  if (!SOURCE_MODULE.test(body.source_module)) throw new DomainError('VALIDATION_FAILED', 422, 'source_module');
  return {
    sourceModule: body.source_module,
    sourceRef: body.source_ref.trim(),
    templateCode: body.template_code.trim(),
    payloadRef: body.payload_ref.trim(),
    payloadSha256: lower(body.payload_sha256),
    eventId: lower(body.event_id),
    signerHint: isRecord(body.signer_hint) ? body.signer_hint : null,
    recipients: body.recipients,
    asOfDate: body.as_of_date,
  };
}

/**
 * DocumentIssuePort (DOC.md F2, BR-DOC-17): a source module asks DOC to issue a state document with a payload it wrote to storage and the SHA-256 of
 * that payload. DOC reads the payload and computes the hash again, finds the template of the date, reads the payload against it, and either makes
 * a draft that carries the source reference (the request is ACCEPTED) or says why not (REJECTED, with the reason and an event the module can act on).
 * The same event is one request, and a second request for content that is still open is answered with the first. The module marks its own record issued
 * only after the `doc.issued.v1` that names its reference and hash.
 */
export class DocumentIssueService {
  private readonly requests = new DocIssueRequestStore();
  private readonly documents = new DocumentStore();
  private readonly drafts = new OutgoingDraftStore();
  private readonly registers = new NumberRegisterStore();
  private readonly organisation = new SignerAuthorityStore();

  constructor(
    private readonly files: DocumentFilePort,
    private readonly metrics: MetricsSink = NOOP_METRICS,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  /** The whole request in the transaction of the caller (the port and the event consumer): decide, then write the outcome. */
  async requestIssue(tx: TenantTx, ctx: IssueContext, input: IssueRequestInput): Promise<IssueOutcome> {
    const decision = await this.prepare(tx, ctx.tenantId, input);
    switch (decision.kind) {
      case 'REPLAY':
      case 'OPEN':
        return decision;
      case 'REJECT':
        return this.reject(tx, ctx, input, decision.rejection);
      case 'ACCEPT':
        return this.accept(tx, ctx, input, decision.accepted);
    }
  }

  /** Looks the request up and judges it, writing nothing: the same event, content that is open, a refusal, or a draft to make. */
  async prepare(tx: TenantTx, tenantId: string, input: IssueRequestInput): Promise<IssueDecision> {
    const sameEvent = await this.requests.findByEvent(tx, input.sourceModule, input.eventId);
    if (sameEvent !== undefined) {
      // One event is one request: the same event with other content is a mistake of the module, not a second request.
      if (sameEvent.sourceRef !== input.sourceRef || sameEvent.payloadSha256 !== input.payloadSha256) throw new DomainError('IDEMPOTENCY_CONFLICT', 409, 'event_id');
      return { kind: 'REPLAY', request: sameEvent };
    }
    const open = await this.requests.findOpen(tx, input.sourceModule, input.sourceRef, input.payloadSha256);
    if (open !== undefined) return { kind: 'OPEN', request: open };
    return this.assess(tx, tenantId, input);
  }

  /** Writes a refusal: the request REJECTED with its reason, and the event the module reads. */
  async reject(tx: TenantTx, ctx: IssueContext, input: IssueRequestInput, rejection: Rejection): Promise<IssueOutcome> {
    const inserted = await this.requests.insertReceived(tx, this.newRequest(ctx, input));
    if (inserted.outcome === 'DUPLICATE_EVENT') return { kind: 'REPLAY', request: inserted.request };
    if (inserted.outcome === 'ALREADY_OPEN') return { kind: 'OPEN', request: inserted.request };
    const request = await this.requests.markRejected(tx, inserted.request.id, { code: rejection.code, templateId: rejection.templateId, actor: ctx.actor });
    await ctx.audit({
      action: 'doc_issue_request.reject',
      resourceType: REQUEST_TYPE,
      resourceId: request.id,
      diff: { source_module: request.sourceModule, source_ref: request.sourceRef, payload_sha256: request.payloadSha256, reject_code: rejection.code, fields: rejection.fields },
    });
    await ctx.emit({
      aggregateType: REQUEST_TYPE,
      aggregateId: request.id,
      aggregateVersion: request.version,
      type: 'doc.rejected.v1',
      schemaVersion: 1,
      payload: { source_module: request.sourceModule, source_ref: request.sourceRef, payload_sha256: request.payloadSha256, reject_code: rejection.code },
      eventKey: `${REQUEST_TYPE}:${request.id}:rejected`,
    });
    this.metrics.increment('doc_issue_request_total', { outcome: 'rejected', reason: rejection.code });
    return { kind: 'REJECTED', request, rejection };
  }

  /** Writes the draft the module asked for and the request ACCEPTED, together. */
  async accept(tx: TenantTx, ctx: IssueContext, input: IssueRequestInput, accepted: Accepted): Promise<IssueOutcome> {
    const inserted = await this.requests.insertReceived(tx, this.newRequest(ctx, input));
    if (inserted.outcome === 'DUPLICATE_EVENT') return { kind: 'REPLAY', request: inserted.request };
    if (inserted.outcome === 'ALREADY_OPEN') return { kind: 'OPEN', request: inserted.request };
    const normalised = normalisedPayload(accepted.payload);
    const draft = await this.drafts.createDraft(tx, {
      docTypeCode: accepted.template.docTypeCode,
      title: accepted.title,
      draftingUnitId: accepted.unitId,
      templateId: accepted.template.id,
      layoutProfileId: accepted.template.layoutProfileId,
      urgency: 'NORMAL',
      circulation: 'INTERNAL_CIRCULATION',
      classification: 'INTERNAL',
      payload: normalised.payload,
      payloadSha256: normalised.sha256,
      recipients: accepted.recipients,
      signerUserId: accepted.signer,
      signerTitle: typeof normalised.payload.signer_title === 'string' ? normalised.payload.signer_title : null,
      signingMode: accepted.mode,
      delegationId: accepted.delegation,
      subjectModule: null,
      subjectId: null,
      replyToIncomingId: null,
      reviewDueOn: null,
      source: { module: input.sourceModule, ref: input.sourceRef, issueRequestId: inserted.request.id },
      actor: ctx.actor,
    });
    const request = await this.requests.markAccepted(tx, inserted.request.id, { templateId: accepted.template.id, outgoingDocumentId: draft.id, actor: ctx.actor });
    await this.drafts.appendEvent(tx, {
      outgoingDocumentId: draft.id,
      kind: 'CREATED',
      fromStatus: null,
      toStatus: 'DRAFT',
      actor: ctx.actor,
      documentVersion: draft.version,
      occurredAt: this.clock(),
      details: { template_id: accepted.template.id, source_module: input.sourceModule, source_ref: input.sourceRef },
    });
    await ctx.audit({
      action: 'doc_issue_request.accept',
      resourceType: REQUEST_TYPE,
      resourceId: request.id,
      diff: { source_module: request.sourceModule, source_ref: request.sourceRef, payload_sha256: request.payloadSha256, template_id: accepted.template.id, outgoing_document_id: draft.id },
    });
    await ctx.emit({
      aggregateType: REQUEST_TYPE,
      aggregateId: request.id,
      aggregateVersion: request.version,
      type: 'doc.issue_accepted.v1',
      schemaVersion: 1,
      payload: {
        source_module: request.sourceModule,
        source_ref: request.sourceRef,
        payload_sha256: request.payloadSha256,
        issue_request_id: request.id,
        outgoing_document_id: draft.id,
        document_id: draft.documentId,
      },
      eventKey: `${REQUEST_TYPE}:${request.id}:accepted`,
    });
    await ctx.emit({
      aggregateType: OUTGOING_TYPE,
      aggregateId: draft.id,
      aggregateVersion: draft.version,
      type: 'doc.draft_created.v1',
      schemaVersion: 1,
      payload: {
        tenant_id: ctx.tenantId,
        document_id: draft.documentId,
        outgoing_document_id: draft.id,
        version: draft.version,
        actor_id: ctx.actor,
        occurred_at: this.clock().toISOString(),
        doc_type_code: draft.docTypeCode,
        template_id: accepted.template.id,
        source_ref: input.sourceRef,
      },
      eventKey: `${OUTGOING_TYPE}:${draft.id}:${draft.version}`,
    });
    this.metrics.increment('doc_issue_request_total', { outcome: 'accepted', reason: 'none' });
    return { kind: 'ACCEPTED', request, outgoingDocumentId: draft.id, documentId: draft.documentId, version: request.version };
  }

  private newRequest(ctx: IssueContext, input: IssueRequestInput) {
    return {
      sourceModule: input.sourceModule,
      sourceRef: input.sourceRef,
      templateCode: input.templateCode,
      payloadSha256: input.payloadSha256,
      payloadRef: input.payloadRef,
      eventId: input.eventId,
      signerHint: input.signerHint,
      recipientsHint: input.recipients === undefined ? null : [...input.recipients],
      requestedBy: ctx.actor,
    };
  }

  /** Reads the payload and the template and decides: a draft to make, or the reason to refuse. */
  private async assess(tx: TenantTx, tenantId: string, input: IssueRequestInput): Promise<IssueDecision> {
    const refuse = (code: RejectCode, fields: string[], templateId: string | null = null): IssueDecision => ({ kind: 'REJECT', rejection: { code, fields, templateId } });
    // The payload lives under the prefix of the tenant: a reference to the storage of another tenant is a mistake of the module, not a refusal to record.
    if (!input.payloadRef.startsWith(`tenants/${tenantId}/`)) throw new DomainError('VALIDATION_FAILED', 422, 'payload_ref');
    const stored = await this.files.get(input.payloadRef);
    if (stored === undefined) return refuse('PAYLOAD_HASH_MISMATCH', ['payload_ref']);
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(stored.bytes).toString('utf8'));
    } catch {
      return refuse('PAYLOAD_SCHEMA_INVALID', ['payload']);
    }
    if (!isRecord(parsed)) return refuse('PAYLOAD_SCHEMA_INVALID', ['payload']);
    // The hash is computed again from the payload, never taken from the request (BR-DOC-11).
    let computed: string;
    try {
      computed = payloadSha256(parsed);
    } catch {
      return refuse('PAYLOAD_SCHEMA_INVALID', ['payload']);
    }
    if (computed !== input.payloadSha256) return refuse('PAYLOAD_HASH_MISMATCH', ['payload_sha256']);
    const secret = stateSecretDeclaration(parsed);
    if (secret !== undefined) return refuse('STATE_SECRET_NOT_SUPPORTED', [secret]);
    if (!(await this.documents.templateCodeExists(tx, input.templateCode))) return refuse('DOC_TEMPLATE_MISSING', ['template_code']);
    let template: TemplateRecord;
    try {
      template = await this.documents.templateFor(tx, { templateCode: input.templateCode }, input.asOfDate);
    } catch (error) {
      if (error instanceof DomainError && error.code === 'TEMPLATE_NOT_EFFECTIVE') return refuse('TEMPLATE_NOT_EFFECTIVE', ['template_code']);
      throw error;
    }
    let normalised;
    try {
      normalised = normalisedPayload(parsed);
    } catch (error) {
      if (error instanceof DomainError && error.code === 'PAYLOAD_SCHEMA_INVALID') return refuse('PAYLOAD_SCHEMA_INVALID', error.extensions?.fields as string[], template.id);
      throw error;
    }
    const missing = missingPayloadFields(normalised.payload, template.placeholderSchema);
    if (missing.length > 0) return refuse('PAYLOAD_SCHEMA_INVALID', missing, template.id);
    let recipients: DraftRecipient[];
    try {
      recipients = normaliseRecipients(input.recipients);
    } catch (error) {
      if (error instanceof DomainError) return refuse('PAYLOAD_SCHEMA_INVALID', ['recipients'], template.id);
      throw error;
    }
    const hint = input.signerHint ?? {};
    const unitId = typeof hint.drafting_unit_id === 'string' && UUID.test(lower(hint.drafting_unit_id)) ? lower(hint.drafting_unit_id) : undefined;
    if (unitId === undefined || (await this.registers.unitRef(tx, unitId)) === undefined) return refuse('PAYLOAD_SCHEMA_INVALID', ['signer_hint.drafting_unit_id'], template.id);
    const mode = hint.signing_mode === undefined ? 'DIRECT' : hint.signing_mode;
    const delegation = typeof hint.delegation_id === 'string' && UUID.test(lower(hint.delegation_id)) ? lower(hint.delegation_id) : null;
    if (typeof mode !== 'string' || !MODES.includes(mode) || (mode === 'DIRECT') !== (delegation === null)) return refuse('PAYLOAD_SCHEMA_INVALID', ['signer_hint.signing_mode'], template.id);
    // The signer is a hint: a member who is not active is left out, and the draft then says at review that a signer is missing.
    const hinted = typeof hint.membership_id === 'string' && UUID.test(lower(hint.membership_id)) ? lower(hint.membership_id) : null;
    const signer = hinted !== null && (await this.organisation.isActiveMember(tx, hinted, this.clock())) ? hinted : null;
    const named = [normalised.payload.summary, normalised.payload.title]
      .map((candidate) => (typeof candidate === 'string' ? candidate.normalize('NFC').trim() : ''))
      .find((candidate) => candidate.length >= MIN_TITLE && candidate.length <= MAX_TITLE);
    return { kind: 'ACCEPT', accepted: { template, payload: normalised.payload, unitId, recipients, signer, mode: mode as SigningMode, delegation, title: named ?? template.title } };
  }
}
