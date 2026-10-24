import { Body, Controller, HttpCode, Inject, Optional, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import {
  DocumentStore,
  NumberRegisterStore,
  OUTGOING_SCOPE_COLUMNS,
  OutgoingDocumentStore,
  OutgoingDraftStore,
  REGISTER_SCOPE_COLUMNS,
  SignatureStore,
  TenantDatabase,
  scopePredicate,
} from '@machvon/db';
import type { DocumentClassification, DraftRecipient, OutgoingDocumentRecord, TenantTx } from '@machvon/db';
import { DomainError, NOOP_METRICS, vietnamDateOf, versionConflict } from '@machvon/kernel';
import type { EffectiveAccess, MetricsSink } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { FileService } from '../files';
import { assertPdf, pageCountOf, readNumberFields, sha256Hex, verifyExternalSignatures } from './external-signature';
import { DOCUMENT_FILE_PORT } from './file-port';
import type { DocumentFilePort } from './file-port';
import { OutgoingIssuance } from './issuance';
import { normaliseRecipients } from './outgoing-rules';
import { revisionEnds } from './pdf-objects';
import type { SigningProvider } from './signing-port';
import type { SigningPort } from './signing-port';
import { DOC_CLOCK, DOC_METRICS, DOC_SIGNING_PORT, DOC_TRUST_STORE } from './tokens';
import type { TrustStoreProvider } from './trust-anchors';
import { mayActOnUnit } from './unit-scope';

const OUTGOING_TYPE = 'outgoing_document';
const PDF_MIME = 'application/pdf';
const DEFAULT_LAYOUT_PROFILE = 'ND30_A4_STANDARD';
const SUBJECT_MODULE = /^[A-Z]{2,10}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// The number, a slash and the sign of the agency: "128/QD-UBND", "05/BC-SKHDT-QLDA".
const SYMBOL_SHAPE = /^[0-9]{1,9}\/[\p{L}0-9.]+(?:-[\p{L}0-9.]+)*$/u;
const DATE_SHAPE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;

const lower = (value: string): string => value.toLowerCase();

/** A date written year-month-day that exists, or undefined. */
function calendarDate(text: string): string | undefined {
  if (!DATE_SHAPE.test(text)) return undefined;
  const parsed = new Date(`${text}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text ? undefined : text;
}

/**
 * Documents that were signed outside the system (ST-DOC-009, DOC.md F5): the production path of the first release, because no certification authority
 * sandbox exists yet (roadmap K10). (a) The leader signs a file made from the approved PDF with their own tool and the clerk uploads it: both the
 * signature and the content are checked, and the document goes on to be numbered and sealed in the system. (b) A document that was signed and numbered in
 * another system is entered in a register with the number it has. Both read the file through the shared upload pipeline (scanned, judged by its bytes), verify
 * every signature against the trust anchors of the tenant with a proven signing time, and refuse anything else with the reason.
 */
@Controller()
export class SignedDocumentsController {
  private readonly outgoing = new OutgoingDocumentStore();
  private readonly drafts = new OutgoingDraftStore();
  private readonly documents = new DocumentStore();
  private readonly registers = new NumberRegisterStore();
  private readonly signatures = new SignatureStore();
  private readonly issuance = new OutgoingIssuance();
  private readonly metrics: MetricsSink;
  private readonly clock: () => Date;

  constructor(
    @Inject(TenantDatabase) private readonly database: TenantDatabase,
    @Inject(DOCUMENT_FILE_PORT) private readonly stored: DocumentFilePort,
    @Inject(FileService) private readonly uploads: FileService,
    @Inject(DOC_TRUST_STORE) private readonly trust: TrustStoreProvider,
    @Inject(DOC_SIGNING_PORT) private readonly signing: SigningPort,
    @Optional() @Inject(DOC_METRICS) metrics?: MetricsSink,
    @Optional() @Inject(DOC_CLOCK) clock?: () => Date,
  ) {
    this.metrics = metrics ?? NOOP_METRICS;
    this.clock = clock ?? ((): Date => new Date());
  }

  @Post('outgoing-documents/:id/signed-uploads')
  @HttpCode(200)
  @OperationId('uploadLeaderSignedDocument')
  @Command({ operation: 'uploadLeaderSignedDocument', versioned: true })
  async uploadLeaderSigned(
    @Scope() scope: CommandScope,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: Schemas['DocSignedUpload'],
  ): Promise<CommandResult & Record<string, unknown>> {
    const now = this.clock();
    const actor = scope.tenant.membershipId;
    // A document the caller cannot see is indistinguishable from one that does not exist.
    const document = await this.outgoing.lock(scope.tx, id, (first) => scopePredicate(access, PERMISSIONS.uploadLeaderSignedDocument, now, OUTGOING_SCOPE_COLUMNS, first));
    if (document === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (document.version !== scope.expectedVersion) throw versionConflict(document.version);
    if (document.status !== 'SUBMITTED') throw new DomainError('DOCUMENT_STATE_INVALID', 409, 'status');
    // The drafter does not put the leader's signature on their own document: someone else takes the signed file in (BR-DOC-24).
    if (document.drafterUserId === actor) throw new DomainError('SELF_APPROVAL_DENIED', 403, 'signer_user_id');
    if (body.declared_signer_user_id !== undefined && lower(body.declared_signer_user_id) !== document.signerUserId) throw new DomainError('SIGNER_NOT_AUTHORIZED', 422, 'declared_signer_user_id', { extensions: { reason: 'SIGNER_DECLARED_OTHER' } });

    const bytes = await this.fileOf(scope, body.file_object_key, body.file_sha256);
    if (document.currentVersionId === null) throw new DomainError('DOCUMENT_STATE_INVALID', 409, 'version');
    const base = await this.documents.findVersion(scope.tx, document.currentVersionId);
    if (base === undefined || base.stage !== 'RENDERED_FINAL') throw new DomainError('DOCUMENT_STATE_INVALID', 409, 'version');
    const approved = await this.stored.get(base.objectKey);
    if (approved === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    // What the leader signed is what was approved: the file keeps every byte of the locked PDF and adds to it (an incremental signature).
    if (bytes.length <= approved.bytes.length || sha256Hex(bytes.subarray(0, approved.bytes.length)) !== base.checksum) {
      throw new DomainError('SIGNED_CONTENT_MISMATCH', 422, 'file_object_key');
    }
    const verified = await verifyExternalSignatures(bytes, this.trust, scope.tenant.tenantId, now, 1);
    const [signature] = verified.signatures;
    if (verified.signatures.length !== 1 || signature === undefined || signature.role !== 'LEADER') {
      throw new DomainError('SIGNATURE_INVALID', 422, 'file_object_key', { extensions: { findings: [verified.signatures.length === 1 ? 'LEADER_FIELD_REQUIRED' : 'ONE_SIGNATURE_EXPECTED'] } });
    }
    await this.assertSignerIdentity(scope.tx, document, signature.fingerprintSha256);

    const version = await this.storeVersion(scope, document, bytes, base.checksum, 'LEADER_SIGNED', document.classification as DocumentClassification);
    await this.signatures.record(scope.tx, { versionId: version.id, signatures: verified.signatures, verifiedAt: verified.report.verifiedAt, verifierVersion: verified.report.verifierVersion, reportObjectKey: null });
    // A session that is still open in the system is of no use now: the leader has signed.
    const cancelled = await this.drafts.cancelOpenSessions(scope.tx, document.id, actor);
    const advanced = await this.outgoing.markSignedExternally(scope.tx, document.id, { expectedVersion: document.version, signedAt: verified.firstSignedAt, actor });
    await this.drafts.appendEvent(scope.tx, {
      outgoingDocumentId: document.id,
      kind: 'SIGNED_UPLOADED',
      fromStatus: 'SUBMITTED',
      toStatus: 'SIGNED',
      actor,
      documentVersion: advanced.version,
      occurredAt: now,
      details: { version_id: version.id, file_sha256: version.checksum, signed_at: verified.firstSignedAt.toISOString(), route: 'EXTERNAL_UPLOAD' },
    });
    await scope.audit({
      action: 'outgoing_document.signed_upload',
      resourceType: OUTGOING_TYPE,
      resourceId: document.id,
      diff: { version_id: version.id, file_sha256: version.checksum, signer_fingerprint: signature.fingerprintSha256, signed_at: verified.firstSignedAt.toISOString(), profile: signature.profile },
    });
    await scope.emit({
      aggregateType: OUTGOING_TYPE,
      aggregateId: document.id,
      aggregateVersion: advanced.version,
      type: 'doc.signed.v1',
      schemaVersion: 1,
      payload: { outgoing_document_id: document.id, document_id: document.documentId, version_id: version.id, signed_at: verified.firstSignedAt.toISOString(), route: 'EXTERNAL_UPLOAD' },
      eventKey: `${OUTGOING_TYPE}:${document.id}:${advanced.version}`,
    });
    for (const session of cancelled) {
      if (session.providerTxnRef === null) continue;
      const ref = { provider: session.adapterCode as SigningProvider, sessionId: session.providerTxnRef, expiresAt: session.expiresAt };
      scope.afterCommit(async () => {
        await this.signing.cancel(ref).catch(() => this.metrics.increment('doc_signing_cancel_failed_total', { role: 'upload' }));
      });
    }
    this.metrics.increment('doc_signed_upload_total', { outcome: 'accepted' });
    return {
      ...commandResult(scope, 'SIGNED', advanced.version, document.id),
      version_id: version.id,
      file_sha256: version.checksum,
      route: 'EXTERNAL_UPLOAD',
      signature_status: signature.status,
      signed_at: verified.firstSignedAt.toISOString(),
    };
  }

  @Post('outgoing-documents/external-registrations')
  @HttpCode(200)
  @OperationId('registerExternallySignedDocument')
  @Command({ operation: 'registerExternallySignedDocument' })
  async registerExternal(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['DocExternalRegistration']): Promise<CommandResult & Record<string, unknown>> {
    const now = this.clock();
    const actor = scope.tenant.membershipId;
    const unitId = lower(body.drafting_unit_id);
    const unit = await this.registers.unitRef(scope.tx, unitId);
    if (unit === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'drafting_unit_id');
    if (!mayActOnUnit(access, PERMISSIONS.registerExternallySignedDocument, unit, now)) throw new DomainError('SCOPE_DENIED', 403);
    const issuedOn = calendarDate(body.declared_issued_on);
    if (issuedOn === undefined || issuedOn > vietnamDateOf(now)) throw new DomainError('VALIDATION_FAILED', 422, 'declared_issued_on');
    if (!Number.isSafeInteger(body.declared_number) || body.declared_number < 1 || body.declared_number > 999_999_999) throw new DomainError('VALIDATION_FAILED', 422, 'declared_number');
    const symbol = body.declared_symbol.normalize('NFC').trim();
    if (!SYMBOL_SHAPE.test(symbol) || Number(symbol.slice(0, symbol.indexOf('/'))) !== body.declared_number) throw new DomainError('SYMBOL_FORMAT_INVALID', 422, 'declared_symbol');
    const register = await this.registers.findRegister(scope.tx, lower(body.register_id), (first) => scopePredicate(access, PERMISSIONS.registerExternallySignedDocument, now, REGISTER_SCOPE_COLUMNS, first));
    if (register === undefined || register.direction !== 'OUTGOING') throw new DomainError('VALIDATION_FAILED', 422, 'register_id');
    if (register.scopeDocTypes.length > 0 && !register.scopeDocTypes.includes(body.doc_type_code)) throw new DomainError('VALIDATION_FAILED', 422, 'register_id');
    const docType = await this.documents.docTypeFor(scope.tx, body.doc_type_code, issuedOn);
    if (docType === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'doc_type_code');
    if (body.subject_module !== undefined && (body.subject_id === undefined || !SUBJECT_MODULE.test(body.subject_module) || !UUID.test(lower(body.subject_id)))) throw new DomainError('SUBJECT_REF_INVALID', 422, 'subject_id');
    if (body.subject_module === undefined && body.subject_id !== undefined) throw new DomainError('SUBJECT_REF_INVALID', 422, 'subject_module');
    const recipients: DraftRecipient[] = normaliseRecipients(body.recipients);

    const bytes = await this.fileOf(scope, body.file_object_key, body.file_sha256);
    // The signatures come before the number: a file that cannot be relied on is refused whatever number it carries.
    const verified = await verifyExternalSignatures(bytes, this.trust, scope.tenant.tenantId, now, 2);
    const last = verified.signatures[verified.signatures.length - 1];
    if (last === undefined || last.coversEndOffset !== bytes.length) {
      throw new DomainError('SIGNATURE_INVALID', 422, 'file_object_key', { extensions: { findings: ['SEAL_DOES_NOT_COVER_FILE'] } });
    }
    this.assertDeclaredMatches(bytes, { number: body.declared_number, symbol, issuedOn });

    const title = body.title.normalize('NFC').trim();
    const anchor = await this.documents.insertDocument(scope.tx, {
      docKind: 'OUTGOING',
      docTypeCode: body.doc_type_code,
      title,
      classification: 'INTERNAL',
      createdBy: actor,
      issuerUnitId: unitId,
      ...(body.subject_module === undefined || body.subject_id === undefined ? {} : { subjectModule: body.subject_module, subjectId: lower(body.subject_id) }),
    });
    const allocation = await this.registers.registerExternal(scope.tx, { registerId: register.id, documentId: anchor.id, number: body.declared_number, symbol, issuedOn, allocatedBy: actor });
    const layout = await this.documents.layoutProfileByCode(scope.tx, DEFAULT_LAYOUT_PROFILE, issuedOn);
    const issued = await this.outgoing.insertIssuedExternally(scope.tx, {
      documentId: anchor.id,
      layoutProfileId: layout.id,
      draftingUnitId: unitId,
      registerId: register.id,
      allocationId: allocation.allocationId,
      recipients,
      leaderSignedAt: verified.firstSignedAt,
      sealedAt: verified.lastSignedAt,
      issuedAt: now,
      actor,
    });
    const checksum = sha256Hex(bytes);
    const version = await this.storeVersion(scope, issued, bytes, null, 'ORG_SEALED', 'INTERNAL');
    await this.signatures.record(scope.tx, { versionId: version.id, signatures: verified.signatures, verifiedAt: verified.report.verifiedAt, verifierVersion: verified.report.verifierVersion, reportObjectKey: null });
    await this.drafts.appendEvent(scope.tx, {
      outgoingDocumentId: issued.id,
      kind: 'EXTERNALLY_REGISTERED',
      fromStatus: null,
      toStatus: 'ISSUED',
      actor,
      documentVersion: issued.version,
      occurredAt: now,
      details: { register_id: register.id, number: allocation.number, symbol, issued_on: issuedOn, file_sha256: checksum, version_id: version.id },
    });
    const registered = await this.outgoing.find(scope.tx, issued.id);
    if (registered === undefined) throw new Error('registered document vanished');
    await this.issuance.announce(scope, registered, { versionId: version.id, fileSha256: checksum }, now);
    this.metrics.increment('doc_external_registration_total', { outcome: 'issued' });
    return {
      ...commandResult(scope, 'ISSUED', registered.version, registered.id),
      document_id: registered.documentId,
      route: 'EXTERNAL_UPLOAD',
      register_id: register.id,
      number: allocation.number,
      symbol,
      issued_on: issuedOn,
      version_id: version.id,
      file_sha256: checksum,
    };
  }

  /** The file of an upload, from the shared pipeline: it exists for this tenant, is clean, is the file whose hash was declared and is a PDF. */
  private async fileOf(scope: CommandScope, key: string, sha256: string): Promise<Buffer> {
    const { bytes } = await this.uploads.download(scope.tenant, key);
    if (sha256Hex(bytes) !== sha256.toLowerCase()) throw new DomainError('VALIDATION_FAILED', 422, 'file_sha256');
    assertPdf(bytes);
    return Buffer.from(bytes);
  }

  /** BR-DOC-14 f9: the signature was made with a certificate registered for the named signer, and that certificate is Active. */
  private async assertSignerIdentity(tx: TenantTx, document: OutgoingDocumentRecord, fingerprint: string | null): Promise<void> {
    const options = await this.outgoing.certificatesFor(tx, { holderMembershipId: document.signerUserId, draftingUnitId: document.draftingUnitId });
    const own = options.find((option) => option.kind === 'PERSONAL' && option.fingerprintSha256 === fingerprint);
    if (own === undefined) throw new DomainError('SIGNER_NOT_AUTHORIZED', 422, 'file_object_key', { extensions: { reason: 'SIGNER_IDENTITY_MISMATCH' } });
    if (own.status !== 'Active') throw new DomainError('CERTIFICATE_NOT_ACTIVE', 422, 'file_object_key');
  }

  /** The number, the symbol and the date the file prints in its form fields, when it has them, are the ones the clerk declared. */
  private assertDeclaredMatches(bytes: Uint8Array, declared: { number: number; symbol: string; issuedOn: string }): void {
    const printed = readNumberFields(bytes);
    const [year = '', month = '', day = ''] = declared.issuedOn.split('-');
    const mismatch =
      (printed.doc_number !== undefined && Number(printed.doc_number.replace(/\D/g, '')) !== declared.number ? 'declared_number' : undefined) ??
      (printed.doc_symbol !== undefined && printed.doc_symbol.trim() !== declared.symbol ? 'declared_symbol' : undefined) ??
      (printed.doc_date !== undefined && ![`${day}/${month}/${year}`, `${Number(day)}/${Number(month)}/${year}`].includes(printed.doc_date.trim()) ? 'declared_issued_on' : undefined);
    if (mismatch !== undefined) throw new DomainError('VALIDATION_FAILED', 422, mismatch, { extensions: { reason: 'DECLARED_DIFFERS_FROM_FILE' } });
  }

  private async storeVersion(
    scope: CommandScope,
    document: OutgoingDocumentRecord,
    bytes: Buffer,
    prefixSha256: string | null,
    stage: 'LEADER_SIGNED' | 'ORG_SEALED',
    classification: DocumentClassification,
  ): Promise<{ id: string; checksum: string }> {
    const checksum = sha256Hex(bytes);
    // Like every stored file the key holds the digest, so a step that is repeated writes the same object, never a second one.
    const key = `tenants/${scope.tenant.tenantId}/documents/${document.documentId}-${checksum}.pdf`;
    await this.stored.put(key, bytes, PDF_MIME);
    const appended = await this.documents.appendVersion(scope.tx, {
      documentId: document.documentId,
      objectKey: key,
      checksum,
      mime: PDF_MIME,
      pageCount: await pageCountOf(bytes),
      classification,
      stage,
      byteLength: bytes.length,
      ...(prefixSha256 === null ? {} : { prefixSha256 }),
      pdfRevisionCount: revisionEnds(bytes.toString('latin1')).length,
      createdBy: scope.tenant.membershipId,
    });
    // The shared pipeline scanned the file before it was linked: there is nothing left for the malware scan to find.
    const scanned = await this.documents.setScanResult(scope.tx, appended.id, 'CLEAN');
    return { id: scanned.id, checksum };
  }
}
