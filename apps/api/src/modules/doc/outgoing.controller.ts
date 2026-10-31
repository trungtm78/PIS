import { createHash, randomUUID } from 'node:crypto';
import { Body, Controller, Get, HttpCode, Inject, Optional, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import {
  CertificateStore,
  DocumentDistributionStore,
  DocumentStore,
  DocumentTemplateStore,
  NumberRegisterStore,
  OUTGOING_SCOPE_COLUMNS,
  OutgoingDocumentStore,
  OutgoingDraftStore,
  OutgoingSupersessionStore,
  REGISTER_SCOPE_COLUMNS,
  SignatureStore,
  TenantDatabase,
  rendersWatermarked,
  scopePredicate,
} from '@machvon/db';
import type { CertificateRow, DistributionRecord, DocumentVersionRecord, OutgoingDocumentRecord, OutgoingStatus, SigningRole, SigningSessionRecord, TenantTx, VersionStage } from '@machvon/db';
import { DomainError, NOOP_METRICS, formatRegisterNumber, objectKey, signingTimeText, vietnamDateOf, versionConflict } from '@machvon/kernel';
import type { EffectiveAccess, MetricsSink, TenantContext } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { encodeCursor, parsePageRequest } from '../../pagination';
import { CurrentTenant } from '../../tenant-context.decorator';
import { DOCUMENT_FILE_PORT } from './file-port';
import type { DocumentFilePort } from './file-port';
import { applyNumbering } from './numbering-revision';
import { verifyPdfSignatures } from './pades-verifier';
import { PdfStructureError } from './pdf-incremental';
import { revisionEnds } from './pdf-objects';
import { embedSignature, prepareSignature, signedBytesOf } from './pdf-signing';
import type { PreparedSignature } from './pdf-signing';
import type { SessionRef, SigningPort, SigningProvider } from './signing-port';
import { DOC_CLOCK, DOC_METRICS, DOC_SIGNING_PORT, DOC_TRUST_STORE } from './tokens';
import type { TrustStoreProvider } from './trust-anchors';
import { SignerAuthority } from './signer-authority';
import { mayActOnUnit } from './unit-scope';

const OUTGOING_TYPE = 'outgoing_document';
const SESSION_TYPE = 'doc_signing_session';
const PDF_MIME = 'application/pdf';
const SIGNING_KIND = 'signing';
const LEADER_FIELD = 'sig_leader';
const ORGANIZATION_FIELD = 'sig_org';
// DocMDP level 2 (BR-DOC-14 b): fill in fields and add signatures, no other change to the content.
const DOCMDP_FIELDS_AND_SIGNATURES = 2;
const YEAR_TEXT = /^[0-9]{4}$/;
const DATE_TEXT = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
const BEFORE_SIGNATURE: readonly OutgoingStatus[] = ['DRAFT', 'IN_REVIEW', 'SUBMITTED'];
const STATUSES: readonly string[] = [
  'DRAFT',
  'IN_REVIEW',
  'SUBMITTED',
  'SIGNED',
  'NUMBERED',
  'SEALED',
  'ISSUED',
  'DELIVERED',
  'ACKNOWLEDGED',
  'FILED',
  'ARCHIVED',
  'CANCELLED',
  'RECALLED',
  'REPLACED',
  'CORRECTED',
];

const sha256Of = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

function iso(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

function documentView(row: OutgoingDocumentRecord): Record<string, unknown> {
  return {
    id: row.id,
    document_id: row.documentId,
    title: row.title,
    doc_type_code: row.docTypeCode,
    status: row.status,
    route: row.route,
    urgency: row.urgency,
    circulation: row.circulation,
    drafting_unit_id: row.draftingUnitId,
    drafter_user_id: row.drafterUserId,
    signer_user_id: row.signerUserId,
    signer_title: row.signerTitle,
    signing_mode: row.signingMode,
    clerk_user_id: row.clerkUserId,
    register_id: row.registerId,
    allocation_id: row.allocationId,
    document_number: row.documentNumber,
    number_year: row.numberYear,
    symbol: row.symbol,
    issued_on: row.issuedOn,
    recipients: row.recipients,
    current_version_id: row.currentVersionId,
    leader_signed_at: iso(row.leaderSignedAt),
    numbered_at: iso(row.numberedAt),
    sealed_at: iso(row.sealedAt),
    issued_at: iso(row.issuedAt),
    created_at: row.createdAt.toISOString(),
    version: row.version,
    effect_status: row.effectStatus,
    classification: row.classification,
    template_id: row.templateId,
    source_module: row.sourceModule,
    source_ref: row.sourceRef,
    payload_sha256: row.payloadSha256,
    review_due_on: row.reviewDueOn,
    cancel_reason: row.cancelReason,
    recall_reason: row.recallReason,
    recalled_at: iso(row.recalledAt),
    recalled_by: row.recalledBy,
    delegation_id: row.delegationId,
  };
}

/** One recipient of the document on one channel, as the issue and distribution screen shows it (no internal ids beyond its own and the unit). */
function distributionView(row: DistributionRecord): Record<string, unknown> {
  return {
    id: row.id,
    recipient_kind: row.recipientKind,
    recipient_unit_id: row.recipientUnitId,
    recipient_name: row.recipientName,
    recipient_code: row.recipientCode,
    channel: row.channel,
    status: row.status,
    acknowledgement_required: row.acknowledgementRequired,
    sent_at: iso(row.sentAt),
    delivered_at: iso(row.deliveredAt),
    acknowledged_at: iso(row.acknowledgedAt),
    external_ref: row.externalRef,
    attempts: row.attempts,
    error_code: row.errorCode,
    recall_notice_at: iso(row.recallNoticeAt),
    version: row.version,
  };
}

function sessionView(row: SigningSessionRecord): Record<string, unknown> {
  return {
    id: row.id,
    outgoing_document_id: row.outgoingDocumentId,
    role: row.role,
    status: row.status,
    signer_user_id: row.signerUserId,
    signing_certificate_id: row.signingCertificateId,
    adapter_code: row.adapterCode,
    adapter_status: row.adapterStatus,
    base_version_id: row.baseVersionId,
    result_version_id: row.resultVersionId,
    digest_hex: row.digestHex,
    expires_at: row.expiresAt.toISOString(),
    attempts: row.attempts,
    error_code: row.errorCode,
    created_at: row.createdAt.toISOString(),
    version: row.version,
  };
}

function statusFilter(value: unknown): OutgoingStatus | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !STATUSES.includes(value)) throw new DomainError('VALIDATION_FAILED', 422, 'status');
  return value as OutgoingStatus;
}

function textFilter(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0 || value.length > 64) throw new DomainError('VALIDATION_FAILED', 422, field);
  return value;
}

function yearFilter(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !YEAR_TEXT.test(value)) throw new DomainError('VALIDATION_FAILED', 422, 'year');
  return Number(value);
}

function unitFilter(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw new DomainError('VALIDATION_FAILED', 422, 'drafting_unit_id');
  return value.toLowerCase();
}

/** `YYYY-MM-DD` as a calendar date, or undefined. */
function calendarDate(text: string): string | undefined {
  if (!DATE_TEXT.test(text)) return undefined;
  const parsed = new Date(`${text}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text ? undefined : text;
}

function displayDate(isoDate: string): string {
  const [year, month, day] = isoDate.split('-');
  return `${day}/${month}/${year}`;
}

/**
 * Outgoing documents of ST-DOC-005 (DOC.md F4 and F6): the leader signs behind the signing port, the clerk numbers the
 * document by an incremental update and the organisation seals the whole file. Every step is one command: it changes the
 * state of the document, writes the new file version, the audit row and the outbox event in one transaction, so a
 * provider that cannot be reached leaves the document as it was and the same call can be repeated.
 */
@Controller()
export class OutgoingController {
  private readonly outgoing = new OutgoingDocumentStore();
  private readonly documents = new DocumentStore();
  private readonly registers = new NumberRegisterStore();
  private readonly certificates = new CertificateStore();
  private readonly signatures = new SignatureStore();
  private readonly drafts = new OutgoingDraftStore();
  private readonly distributions = new DocumentDistributionStore();
  private readonly supersessions = new OutgoingSupersessionStore();
  private readonly templates = new DocumentTemplateStore();
  private readonly authority = new SignerAuthority();
  private readonly metrics: MetricsSink;
  private readonly clock: () => Date;

  constructor(
    @Inject(TenantDatabase) private readonly database: TenantDatabase,
    @Inject(DOCUMENT_FILE_PORT) private readonly files: DocumentFilePort,
    @Inject(DOC_SIGNING_PORT) private readonly signing: SigningPort,
    @Inject(DOC_TRUST_STORE) private readonly trust: TrustStoreProvider,
    @Optional() @Inject(DOC_METRICS) metrics?: MetricsSink,
    @Optional() @Inject(DOC_CLOCK) clock?: () => Date,
  ) {
    this.metrics = metrics ?? NOOP_METRICS;
    this.clock = clock ?? ((): Date => new Date());
  }

  @Get('outgoing-documents')
  @OperationId('listOutgoingDocuments')
  async list(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Query('status') status?: unknown,
    @Query('doc_type_code') docTypeCode?: unknown,
    @Query('drafting_unit_id') draftingUnitId?: unknown,
    @Query('year') year?: unknown,
    @Query('limit') limit?: unknown,
    @Query('cursor') cursor?: unknown,
  ): Promise<{ items: Array<Record<string, unknown>>; next_cursor: string | null }> {
    const request = parsePageRequest(limit, cursor);
    const filters = {
      status: statusFilter(status),
      docTypeCode: textFilter(docTypeCode, 'doc_type_code'),
      draftingUnitId: unitFilter(draftingUnitId),
      year: yearFilter(year),
    };
    const now = this.clock();
    const rows = await this.database.withTenant(tenant, (tx) =>
      this.outgoing.list(
        tx,
        filters,
        { limit: request.limit + 1, after: request.after === undefined ? undefined : { sortKey: request.after.code, id: request.after.id } },
        (first) => scopePredicate(access, PERMISSIONS.listOutgoingDocuments, now, OUTGOING_SCOPE_COLUMNS, first),
      ),
    );
    const shown = rows.slice(0, request.limit);
    const last = shown[shown.length - 1];
    return {
      items: shown.map(documentView),
      next_cursor: rows.length > request.limit && last !== undefined ? encodeCursor({ code: last.sortKey, id: last.id }) : null,
    };
  }

  @Get('outgoing-documents/:id')
  @OperationId('getOutgoingDocument')
  async get(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<Record<string, unknown>> {
    const now = this.clock();
    const loaded = await this.database.withTenant(tenant, async (tx) => {
      const row = await this.outgoing.find(tx, id, (first) => scopePredicate(access, PERMISSIONS.getOutgoingDocument, now, OUTGOING_SCOPE_COLUMNS, first));
      if (row === undefined) return undefined;
      const [sessions, versions, certificates] = await Promise.all([
        this.outgoing.sessionsOf(tx, row.id),
        this.outgoing.versionsOf(tx, row.documentId),
        this.outgoing.certificatesFor(tx, { holderMembershipId: row.signerUserId, draftingUnitId: row.draftingUnitId }),
      ]);
      const signatures = row.currentVersionId === null ? [] : await this.signatures.latest(tx, row.currentVersionId);
      const content = await this.drafts.contentOf(tx, row.id);
      const review = await this.drafts.latestEvent(tx, row.id, ['REVIEW_APPROVED', 'RETURNED']);
      const distributed = await this.distributions.listFor(tx, row.id);
      const template = row.templateId === null ? undefined : await this.templates.find(tx, row.templateId);
      const relations = await this.supersessions.relationsOf(tx, row.documentId, (first) => scopePredicate(access, PERMISSIONS.getOutgoingDocument, now, OUTGOING_SCOPE_COLUMNS, first));
      return { row, sessions, versions, certificates, signatures, content, review, distributed, template, relations };
    });
    // A document the caller cannot see is indistinguishable from one that does not exist.
    if (loaded === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return {
      ...documentView(loaded.row),
      payload: loaded.content?.payload ?? {},
      subject_module: loaded.content?.subjectModule ?? null,
      subject_id: loaded.content?.subjectId ?? null,
      reply_to_incoming_id: loaded.content?.replyToIncomingId ?? null,
      // Whether the template (or its layout) still waits for its legal confirmation: an issue then needs the written reason of a legal officer (BR-DOC-10).
      renders_watermarked: loaded.template === undefined ? false : rendersWatermarked(loaded.template),
      unconfirmed_override_reason: loaded.row.unconfirmedOverrideReason,
      distributions: loaded.distributed.map(distributionView),
      // The documents that replace, correct or recall this one and those it does so to (BR-DOC-21): the timeline of DOC-19.
      relations: loaded.relations.map((relation) => ({
        id: relation.id,
        kind: relation.kind,
        direction: relation.direction,
        document_id: relation.documentId,
        outgoing_document_id: relation.outgoingDocumentId,
        title: relation.title,
        symbol: relation.symbol,
        status: relation.status,
        note: relation.note,
        created_at: relation.createdAt,
      })),
      latest_review:
        loaded.review === undefined
          ? null
          : {
              kind: loaded.review.kind,
              actor_id: loaded.review.actorId,
              comment: loaded.review.comment,
              checklist: loaded.review.details.checklist ?? null,
              file_sha256: loaded.review.details.file_sha256 ?? null,
              occurred_at: loaded.review.occurredAt.toISOString(),
            },
      sessions: loaded.sessions.map(sessionView),
      versions: loaded.versions.map((version) => ({
        id: version.id,
        version: version.version,
        stage: version.stage,
        checksum: version.checksum,
        byte_length: version.byteLength,
        page_count: version.pageCount,
        scan_status: version.scanStatus,
        prefix_sha256: version.prefixSha256,
        created_at: version.createdAt.toISOString(),
      })),
      certificates: loaded.certificates.map((certificate) => ({
        id: certificate.id,
        kind: certificate.kind,
        holder_membership_id: certificate.holderMembershipId,
        organization_unit_id: certificate.organizationUnitId,
        subject_dn: certificate.subjectDn,
        issuer_dn: certificate.issuerDn,
        valid_from: certificate.validFrom.toISOString(),
        valid_until: certificate.validUntil.toISOString(),
        fingerprint_sha256: certificate.fingerprintSha256,
        status: certificate.status,
      })),
      signatures: loaded.signatures.map((signature) => ({
        role: signature.role,
        status: signature.status,
        subject_dn: signature.subjectDn,
        signed_at: iso(signature.signedAt),
        incremental_changes_allowed: signature.incrementalChangesAllowed,
        findings: signature.findings,
      })),
    };
  }

  @Post('outgoing-documents/:id/leader-signing-sessions')
  @HttpCode(202)
  @OperationId('startLeaderSigning')
  @Command({ operation: 'startLeaderSigning', versioned: true })
  async startLeaderSigning(
    @Scope() scope: CommandScope,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: Schemas['DocSigningStart'] | undefined,
  ): Promise<CommandResult & Record<string, unknown>> {
    const now = this.clock();
    const request = body ?? {};
    const document = await this.lockDocument(scope, access, id, PERMISSIONS.startLeaderSigning, now);
    this.assertVersion(document, scope);
    if (document.status !== 'SUBMITTED') throw new DomainError('DOCUMENT_STATE_INVALID', 409, 'status');
    const actor = scope.tenant.membershipId;
    // The drafter never signs their own document as leader; only the named signer does (DOC.md F4).
    if (document.drafterUserId === actor) throw new DomainError('SELF_APPROVAL_DENIED', 403, 'signer_user_id');
    if (document.signerUserId !== actor) throw new DomainError('SIGNER_NOT_AUTHORIZED', 422, 'signer_user_id');
    // A document signed for someone else (KT., TM., TL., TUQ.) needs the delegation to be in force now, not only when it was approved.
    await this.authority.assertDelegation(scope.tx, {
      documentType: document.docTypeCode,
      amountVnd: null,
      draftingUnitId: document.draftingUnitId,
      signerId: actor,
      signingMode: document.signingMode,
      delegationId: document.delegationId,
      at: now,
      businessDate: vietnamDateOf(now),
    });
    const certificate = await this.chooseCertificate(scope.tx, request.certificate_id, { kind: 'PERSONAL', holder: actor, document });
    const prepared = await this.prepareSession(scope, document, {
      role: 'LEADER',
      stage: 'RENDERED_FINAL',
      field: LEADER_FIELD,
      docMdpLevel: request.certify_docmdp === true ? DOCMDP_FIELDS_AND_SIGNATURES : undefined,
      certificate,
      adapter: request.adapter_code,
      now,
    });
    await scope.audit({
      action: 'outgoing_document.leader_signing.start',
      resourceType: OUTGOING_TYPE,
      resourceId: document.id,
      diff: { session_id: prepared.id, certificate_id: certificate.id, adapter_code: prepared.adapterCode, expires_at: prepared.expiresAt.toISOString() },
    });
    await scope.emit({
      aggregateType: OUTGOING_TYPE,
      aggregateId: document.id,
      aggregateVersion: document.version,
      type: 'doc.signing_started.v1',
      schemaVersion: 1,
      payload: { outgoing_document_id: document.id, document_id: document.documentId, session_id: prepared.id, role: 'LEADER', expires_at: prepared.expiresAt.toISOString() },
      eventKey: `${SESSION_TYPE}:${prepared.id}:started`,
    });
    this.metrics.increment('doc_signing_started_total', { role: 'leader' });
    return this.startedResult(scope, prepared, document);
  }

  @Post('signing-sessions/:id/completion')
  @HttpCode(200)
  @OperationId('completeSigningSession')
  @Command({ operation: 'completeSigningSession', versioned: true })
  async completeSigningSession(
    @Scope() scope: CommandScope,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: Schemas['DocSigningCompletion'] | undefined,
  ): Promise<CommandResult & Record<string, unknown>> {
    const now = this.clock();
    const request = body ?? {};
    const permission = PERMISSIONS.completeSigningSession;
    const scoped = (first: number) => scopePredicate(access, permission, now, OUTGOING_SCOPE_COLUMNS, first);
    const peek = await this.outgoing.findSession(scope.tx, id, { scope: scoped });
    if (peek === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    // The document is locked before the session: the start commands take the locks in the same order.
    const document = await this.outgoing.lock(scope.tx, peek.outgoingDocumentId);
    const session = await this.outgoing.findSession(scope.tx, id, { lock: true });
    if (document === undefined || session === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (session.version !== scope.expectedVersion) throw versionConflict(session.version);
    if (session.status === 'SIGNED' || session.status === 'EMBEDDED' || session.status === 'FAILED') throw new DomainError('DOCUMENT_STATE_INVALID', 409, 'session');
    if (session.status === 'EXPIRED' || session.status === 'CANCELLED' || now.getTime() >= session.expiresAt.getTime()) throw new DomainError('SIGNING_SESSION_EXPIRED', 409);
    const actor = scope.tenant.membershipId;
    if (session.signerUserId !== actor) throw new DomainError('SIGNER_NOT_AUTHORIZED', 422, 'signer_user_id');
    const role = session.role;
    const expectedStatus: OutgoingStatus = role === 'LEADER' ? 'SUBMITTED' : 'NUMBERED';
    if (document.status !== expectedStatus) throw new DomainError('DOCUMENT_STATE_INVALID', 409, 'status');
    if (role === 'ORGANIZATION') {
      // The route guard checks `doc.outgoing.sign`; sealing is the clerk's `doc.outgoing.seal`, held over the drafting unit.
      const unit = await this.registers.unitRef(scope.tx, document.draftingUnitId);
      if (unit === undefined || !mayActOnUnit(access, PERMISSIONS.startOrganizationSeal, unit, now)) throw new DomainError('SCOPE_DENIED', 403);
    }
    const certificate = session.signingCertificateId === null ? undefined : await this.certificates.find(scope.tx, session.signingCertificateId);
    if (certificate === undefined || certificate.status !== 'Active') throw new DomainError('CERTIFICATE_NOT_ACTIVE', 422, 'certificate_id');
    if (request.client_digest_hex !== undefined && request.client_digest_hex !== session.digestHex) throw new DomainError('DIGEST_MISMATCH', 422, 'client_digest_hex');

    const base = await this.currentPdf(scope.tx, document, role === 'LEADER' ? 'RENDERED_FINAL' : 'NUMBERED');
    if (base.version.id !== session.baseVersionId) throw new DomainError('DOCUMENT_STATE_INVALID', 409, 'base_version_id');
    const prepared = await this.preparedFile(scope, session);
    if (sha256Of(signedBytesOf(prepared)) !== session.digestHex) throw new DomainError('DIGEST_MISMATCH', 422, 'digest_hex');
    const cms = await this.signatureFor(session, request.cms_signature);
    let signed: Buffer;
    try {
      signed = embedSignature(prepared, cms);
    } catch (error) {
      if (error instanceof PdfStructureError) throw new DomainError('SIGNATURE_INVALID', 422, 'cms_signature');
      throw error;
    }
    const report = await verifyPdfSignatures(signed, await this.trust.forTenant(scope.tenant.tenantId), now, { policy: 'LENIENT_TIME' });
    const mine = report.signatures.find((signature) => signature.role === role);
    // LENIENT_TIME lets an unproven signing time through, nothing else: an incomplete chain or an unknown revocation is not a signature to build on.
    if (mine === undefined || mine.status === 'INVALID' || report.overall !== 'VALID' || mine.fingerprintSha256 !== certificate.fingerprintSha256) {
      this.metrics.increment('doc_signing_completed_total', { role: role.toLowerCase(), outcome: 'invalid' });
      throw new DomainError('SIGNATURE_INVALID', 422, 'cms_signature', { extensions: { findings: mine?.findings ?? [] } });
    }
    const stored = await this.storeVersion(scope, document, base.version, signed, role === 'LEADER' ? 'LEADER_SIGNED' : 'ORG_SEALED', sha256Of(base.bytes));
    await this.signatures.record(scope.tx, { versionId: stored.id, signatures: report.signatures, verifiedAt: report.verifiedAt, verifierVersion: report.verifierVersion, reportObjectKey: null });
    const completed = await this.outgoing.completeSession(scope.tx, session.id, { resultVersionId: stored.id, actor });
    const advanced =
      role === 'LEADER'
        ? await this.outgoing.markSigned(scope.tx, document.id, { expectedVersion: document.version, signedAt: now, actor })
        : await this.outgoing.markSealed(scope.tx, document.id, { expectedVersion: document.version, sealedAt: now, actor });
    const sealed = role === 'ORGANIZATION';
    await this.drafts.appendEvent(scope.tx, {
      outgoingDocumentId: document.id,
      kind: sealed ? 'SEALED' : 'LEADER_SIGNED',
      fromStatus: document.status,
      toStatus: advanced.status,
      actor,
      documentVersion: advanced.version,
      occurredAt: now,
      details: { version_id: stored.id, session_id: session.id },
    });
    await scope.audit({
      action: sealed ? 'outgoing_document.organization_seal.complete' : 'outgoing_document.leader_signing.complete',
      resourceType: OUTGOING_TYPE,
      resourceId: document.id,
      diff: { session_id: session.id, version_id: stored.id, certificate_id: certificate.id, overall: report.overall, signature_status: mine.status },
    });
    await scope.emit({
      aggregateType: OUTGOING_TYPE,
      aggregateId: document.id,
      aggregateVersion: advanced.version,
      type: sealed ? 'doc.sealed.v1' : 'doc.signed.v1',
      schemaVersion: 1,
      payload: { outgoing_document_id: document.id, document_id: document.documentId, version_id: stored.id, session_id: session.id, signed_at: now.toISOString() },
      eventKey: `${OUTGOING_TYPE}:${document.id}:${advanced.version}`,
    });
    this.metrics.increment('doc_signing_completed_total', { role: role.toLowerCase(), outcome: 'embedded' });
    return {
      ...commandResult(scope, sealed ? 'SEALED' : 'SIGNED', completed.version, completed.id),
      outgoing_document_id: document.id,
      document_status: advanced.status,
      document_version: advanced.version,
      result_version_id: stored.id,
      signature_status: mine.status,
      overall: report.overall,
    };
  }

  @Post('outgoing-documents/:id/numbering')
  @HttpCode(200)
  @OperationId('assignOutgoingDocumentNumber')
  @Command({ operation: 'assignOutgoingDocumentNumber', versioned: true })
  async assignNumber(
    @Scope() scope: CommandScope,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: Schemas['DocNumbering'] | undefined,
  ): Promise<CommandResult & Record<string, unknown>> {
    const now = this.clock();
    const request = body ?? {};
    const document = await this.lockDocument(scope, access, id, PERMISSIONS.assignOutgoingDocumentNumber, now);
    this.assertVersion(document, scope);
    if (BEFORE_SIGNATURE.includes(document.status)) throw new DomainError('NUMBERING_BEFORE_SIGNATURE', 422, 'status');
    if (document.status !== 'SIGNED' || document.leaderSignedAt === null) throw new DomainError('DOCUMENT_STATE_INVALID', 409, 'status');
    if (now.getTime() < document.leaderSignedAt.getTime()) throw new DomainError('NUMBERING_BEFORE_SIGNATURE', 422, 'issued_on');
    if (request.register_id === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'register_id');
    const issuedOn = request.issued_on === undefined ? vietnamDateOf(now) : calendarDate(request.issued_on);
    if (issuedOn === undefined || issuedOn > vietnamDateOf(now) || issuedOn < vietnamDateOf(document.leaderSignedAt)) throw new DomainError('VALIDATION_FAILED', 422, 'issued_on');
    const actor = scope.tenant.membershipId;
    const register = await this.registers.findRegister(scope.tx, request.register_id, (first) =>
      scopePredicate(access, PERMISSIONS.assignOutgoingDocumentNumber, now, REGISTER_SCOPE_COLUMNS, first),
    );
    if (register === undefined || register.direction !== 'OUTGOING') throw new DomainError('VALIDATION_FAILED', 422, 'register_id');
    if (register.scopeDocTypes.length > 0 && !register.scopeDocTypes.includes(document.docTypeCode)) throw new DomainError('VALIDATION_FAILED', 422, 'register_id');
    const docType = await this.documents.docTypeFor(scope.tx, document.docTypeCode, issuedOn);
    if (docType === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'doc_type_code');

    const base = await this.currentPdf(scope.tx, document, 'LEADER_SIGNED');
    const trust = await this.trust.forTenant(scope.tenant.tenantId);
    // The leader signature must still hold before a number is spent on the document (DOC.md F6).
    const before = await verifyPdfSignatures(base.bytes, trust, now, { policy: 'LENIENT_TIME' });
    const leader = before.signatures.find((signature) => signature.role === 'LEADER');
    if (leader === undefined || leader.status === 'INVALID' || before.overall !== 'VALID') throw new DomainError('LEADER_SIGNATURE_BROKEN', 422);

    // The row lock on the register, the counter, the allocation and the document change commit together or not at all.
    const allocation = await this.registers.allocateNumber(scope.tx, {
      registerId: register.id,
      documentId: document.documentId,
      issuedAt: new Date(`${issuedOn}T12:00:00+07:00`),
      symbolPattern: docType.symbolPattern,
      parts: { ...(docType.abbreviation === null ? {} : { type: docType.abbreviation }), agency: register.registerCode, unit: await this.unitCode(scope.tx, register.organizationUnitId) },
      allocatedBy: actor,
    });
    const numbered = applyNumbering(base.bytes, { docNumber: formatRegisterNumber(allocation.number), docSymbol: allocation.symbol, docDate: displayDate(allocation.issuedOn) });
    const after = await verifyPdfSignatures(numbered.pdf, trust, now, { policy: 'LENIENT_TIME' });
    const kept = after.signatures.find((signature) => signature.role === 'LEADER');
    if (kept === undefined || kept.status === 'INVALID' || after.overall !== 'VALID' || kept.incrementalChangesAllowed !== true) throw new DomainError('INCREMENTAL_UPDATE_FAILED', 422);
    const stored = await this.storeVersion(scope, document, base.version, numbered.pdf, 'NUMBERED', numbered.prefixSha256);
    await this.signatures.record(scope.tx, { versionId: stored.id, signatures: after.signatures, verifiedAt: after.verifiedAt, verifierVersion: after.verifierVersion, reportObjectKey: null });
    const advanced = await this.outgoing.markNumbered(scope.tx, document.id, {
      expectedVersion: document.version,
      registerId: register.id,
      allocationId: allocation.allocationId,
      numberedAt: now,
      clerk: actor,
    });
    await this.drafts.appendEvent(scope.tx, {
      outgoingDocumentId: document.id,
      kind: 'NUMBERED',
      fromStatus: 'SIGNED',
      toStatus: 'NUMBERED',
      actor,
      documentVersion: advanced.version,
      occurredAt: now,
      details: { register_id: register.id, number: allocation.number, symbol: allocation.symbol, version_id: stored.id },
    });
    await scope.audit({
      action: 'outgoing_document.number',
      resourceType: OUTGOING_TYPE,
      resourceId: document.id,
      diff: { register_id: register.id, number: allocation.number, symbol: allocation.symbol, issued_on: allocation.issuedOn, version_id: stored.id, prefix_sha256: numbered.prefixSha256, note: request.clerk_note ?? null },
    });
    await scope.emit({
      aggregateType: OUTGOING_TYPE,
      aggregateId: document.id,
      aggregateVersion: advanced.version,
      type: 'doc.numbered.v1',
      schemaVersion: 1,
      payload: {
        outgoing_document_id: document.id,
        document_id: document.documentId,
        register_id: register.id,
        allocation_id: allocation.allocationId,
        number: allocation.number,
        symbol: allocation.symbol,
        issued_on: allocation.issuedOn,
        version_id: stored.id,
      },
      eventKey: `${OUTGOING_TYPE}:${document.id}:${advanced.version}`,
    });
    this.metrics.increment('doc_numbered_total', { outcome: 'numbered' });
    return {
      ...commandResult(scope, 'NUMBERED', advanced.version, document.id),
      number: allocation.number,
      display_number: formatRegisterNumber(allocation.number),
      symbol: allocation.symbol,
      issued_on: allocation.issuedOn,
      version_id: stored.id,
      prefix_sha256: numbered.prefixSha256,
    };
  }

  @Post('outgoing-documents/:id/organization-seal-sessions')
  @HttpCode(202)
  @OperationId('startOrganizationSeal')
  @Command({ operation: 'startOrganizationSeal', versioned: true })
  async startOrganizationSeal(
    @Scope() scope: CommandScope,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: Schemas['DocSealStart'] | undefined,
  ): Promise<CommandResult & Record<string, unknown>> {
    const now = this.clock();
    const request = body ?? {};
    const document = await this.lockDocument(scope, access, id, PERMISSIONS.startOrganizationSeal, now);
    this.assertVersion(document, scope);
    if (document.status !== 'NUMBERED') throw new DomainError('DOCUMENT_STATE_INVALID', 409, 'status');
    const certificate = await this.chooseCertificate(scope.tx, request.certificate_id, { kind: 'ORGANIZATION', holder: null, document });
    const prepared = await this.prepareSession(scope, document, {
      role: 'ORGANIZATION',
      stage: 'NUMBERED',
      field: ORGANIZATION_FIELD,
      docMdpLevel: undefined,
      certificate,
      adapter: request.adapter_code,
      now,
    });
    await scope.audit({
      action: 'outgoing_document.organization_seal.start',
      resourceType: OUTGOING_TYPE,
      resourceId: document.id,
      diff: { session_id: prepared.id, certificate_id: certificate.id, adapter_code: prepared.adapterCode, expires_at: prepared.expiresAt.toISOString() },
    });
    await scope.emit({
      aggregateType: OUTGOING_TYPE,
      aggregateId: document.id,
      aggregateVersion: document.version,
      type: 'doc.seal_started.v1',
      schemaVersion: 1,
      payload: { outgoing_document_id: document.id, document_id: document.documentId, session_id: prepared.id, role: 'ORGANIZATION', expires_at: prepared.expiresAt.toISOString() },
      eventKey: `${SESSION_TYPE}:${prepared.id}:started`,
    });
    this.metrics.increment('doc_signing_started_total', { role: 'organization' });
    return this.startedResult(scope, prepared, document);
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

  private async unitCode(tx: TenantTx, unitId: string): Promise<string> {
    const [row] = await tx.query<{ code: string }>('select code from machvon.organization_unit where id = $1::uuid', [unitId]);
    return row?.code ?? '';
  }

  /** The registered certificate for a signing step: the one asked for, or the Active one that ends last. */
  private async chooseCertificate(
    tx: TenantTx,
    requested: string | undefined,
    wanted: { kind: 'PERSONAL' | 'ORGANIZATION'; holder: string | null; document: OutgoingDocumentRecord },
  ): Promise<CertificateRow> {
    const options = await this.outgoing.certificatesFor(tx, { holderMembershipId: wanted.holder, draftingUnitId: wanted.document.draftingUnitId });
    const fit = options.filter((option) => option.kind === wanted.kind && (requested === undefined || option.id === requested));
    if (requested !== undefined && fit.length === 0) {
      // Unknown, of the wrong kind or belonging to someone else: the caller is told it cannot be used, not which it was.
      throw new DomainError('CERTIFICATE_NOT_ACTIVE', 422, 'certificate_id');
    }
    const active = fit.find((option) => option.status === 'Active');
    if (active === undefined) throw new DomainError('CERTIFICATE_NOT_ACTIVE', 422, 'certificate_id');
    const row = await this.certificates.find(tx, active.id);
    if (row === undefined) throw new DomainError('CERTIFICATE_NOT_ACTIVE', 422, 'certificate_id');
    return row;
  }

  /** The file version a step works on: PDF, scanned clean and in the stage the step expects. */
  private async currentPdf(tx: TenantTx, document: OutgoingDocumentRecord, stage: VersionStage): Promise<{ version: DocumentVersionRecord; bytes: Buffer }> {
    if (document.currentVersionId === null) throw new DomainError('DOCUMENT_STATE_INVALID', 409, 'version');
    const version = await this.documents.findVersion(tx, document.currentVersionId);
    if (version === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (version.stage !== stage) throw new DomainError('DOCUMENT_STATE_INVALID', 409, 'version');
    if (version.mime !== PDF_MIME) throw new DomainError('DOCUMENT_VERSION_NOT_PDF', 422);
    if (version.scanStatus === 'PENDING') throw new DomainError('SCAN_PENDING', 409);
    if (version.scanStatus === 'INFECTED') throw new DomainError('SCOPE_DENIED', 403);
    const file = await this.files.get(version.objectKey);
    if (file === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return { version, bytes: Buffer.from(file.bytes) };
  }

  /**
   * Opens a session for one signature field: the field is prepared (an incremental update with room for the CMS), the
   * provider receives only the SHA-256 of the covered bytes, and the prepared file waits under the id of the session.
   */
  private async prepareSession(
    scope: CommandScope,
    document: OutgoingDocumentRecord,
    input: {
      role: SigningRole;
      stage: VersionStage;
      field: string;
      docMdpLevel: number | undefined;
      certificate: CertificateRow;
      adapter: string | undefined;
      now: Date;
    },
  ): Promise<SigningSessionRecord> {
    const actor = scope.tenant.membershipId;
    if (input.adapter !== undefined && this.signing.provider !== 'MOCK' && this.signing.provider !== input.adapter) throw new DomainError('SIGNING_ADAPTER_UNAVAILABLE', 422, 'adapter_code');
    // A session whose time ran out no longer blocks a new one.
    await this.outgoing.expireDue(scope.tx, document.id, input.role, input.now, actor);
    if ((await this.outgoing.openSession(scope.tx, document.id, input.role)) !== undefined) throw new DomainError('SIGNING_SESSION_OPEN', 409);
    const base = await this.currentPdf(scope.tx, document, input.stage);
    let prepared: PreparedSignature;
    try {
      prepared = prepareSignature(base.bytes, {
        fieldName: input.field,
        signingTime: input.now,
        appearanceText: signingTimeText(input.now),
        ...(input.docMdpLevel === undefined ? {} : { docMdpLevel: input.docMdpLevel as 1 | 2 | 3 }),
      });
    } catch (error) {
      if (error instanceof PdfStructureError) throw new DomainError('DOCUMENT_STATE_INVALID', 409, input.field);
      throw error;
    }
    const digest = sha256Of(signedBytesOf(prepared));
    const sessionId = randomUUID();
    // The provider is asked first: when it cannot be reached nothing has been written and the same call can be repeated.
    const ref = await this.signing.startSession({ digestSha256: digest, certificateFingerprint: input.certificate.fingerprintSha256, correlationId: scope.correlationId });
    try {
      const session = await this.outgoing.createSession(scope.tx, {
        id: sessionId,
        outgoingDocumentId: document.id,
        role: input.role,
        signerUserId: actor,
        signingCertificateId: input.certificate.id,
        adapterCode: ref.provider,
        adapterStatus: ref.provider === 'MOCK' ? 'MOCK' : 'PROPOSED',
        baseVersionId: base.version.id,
        digestHex: digest,
        byteRange: prepared.byteRange,
        providerTxnRef: ref.sessionId,
        expiresAt: ref.expiresAt,
        actor,
      });
      // The prepared file goes last: it is the one write the database transaction cannot roll back, so a step that fails
      // before it leaves no object that no session row points to.
      await this.files.put(this.preparedKey(scope.tenant.tenantId, sessionId), prepared.pdf, PDF_MIME);
      return session;
    } catch (error) {
      // The signer must not be asked to approve a session the platform no longer knows.
      await this.signing.cancel(ref).catch(() => this.metrics.increment('doc_signing_cancel_failed_total', { role: input.role.toLowerCase() }));
      throw error;
    }
  }

  private startedResult(scope: CommandScope, session: SigningSessionRecord, document: OutgoingDocumentRecord): CommandResult & Record<string, unknown> {
    return {
      ...commandResult(scope, session.status, session.version, session.id),
      outgoing_document_id: document.id,
      role: session.role,
      expires_at: session.expiresAt.toISOString(),
      digest_hex: session.digestHex,
      adapter_code: session.adapterCode,
      adapter_status: session.adapterStatus,
    };
  }

  private preparedKey(tenantId: string, sessionId: string): string {
    return objectKey(tenantId, SIGNING_KIND, sessionId);
  }

  /** The prepared file of a session, with the positions of the signature value that were fixed when it was prepared. */
  private async preparedFile(scope: CommandScope, session: SigningSessionRecord): Promise<PreparedSignature> {
    const file = await this.files.get(this.preparedKey(scope.tenant.tenantId, session.id));
    const range = session.byteRange;
    if (file === undefined || range === null) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return { pdf: Buffer.from(file.bytes), byteRange: range, contentsStart: range[1], contentsEnd: range[2] };
  }

  /** The CMS the signer produced: handed in by the signing agent, or collected from the provider after the signer approved. */
  private async signatureFor(session: SigningSessionRecord, supplied: string | undefined): Promise<Uint8Array> {
    if (supplied !== undefined) return Buffer.from(supplied, 'base64');
    if (session.providerTxnRef === null) throw new DomainError('SIGNING_ADAPTER_UNAVAILABLE', 422);
    const ref: SessionRef = { provider: session.adapterCode as SigningProvider, sessionId: session.providerTxnRef, expiresAt: session.expiresAt };
    const payload = await this.signing.collect(ref);
    // The signer has not confirmed yet: the session stays open and the screen asks again.
    if (payload === 'PENDING') throw new DomainError('SIGNING_SESSION_OPEN', 409, 'otp_confirmation');
    return payload.cms;
  }

  private async storeVersion(
    scope: CommandScope,
    document: OutgoingDocumentRecord,
    base: DocumentVersionRecord,
    bytes: Buffer,
    stage: VersionStage,
    prefixSha256: string,
  ): Promise<DocumentVersionRecord> {
    const checksum = sha256Of(bytes);
    // Like every stored file the key holds the digest, so a step that is repeated writes the same object, never a second one.
    const key = `tenants/${scope.tenant.tenantId}/documents/${document.documentId}-${checksum}.pdf`;
    await this.files.put(key, bytes, PDF_MIME);
    const appended = await this.documents.appendVersion(scope.tx, {
      documentId: document.documentId,
      objectKey: key,
      checksum,
      mime: PDF_MIME,
      pageCount: base.pageCount,
      classification: base.classification,
      stage,
      byteLength: bytes.length,
      rendererVersion: base.rendererVersion ?? undefined,
      templateId: base.templateId ?? undefined,
      prefixSha256,
      pdfRevisionCount: revisionEnds(bytes.toString('latin1')).length,
      createdBy: scope.tenant.membershipId,
    });
    // The bytes come from the platform and the signing port, not from an upload: there is nothing for the malware scan to find.
    return this.documents.setScanResult(scope.tx, appended.id, 'CLEAN');
  }
}
