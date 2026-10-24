import { Body, Controller, HttpCode, Inject, Optional, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { DocumentStore, DocumentTemplateStore, NumberRegisterStore, OUTGOING_SCOPE_COLUMNS, OutgoingDocumentStore, SignatureStore, rendersWatermarked, scopePredicate } from '@machvon/db';
import { DomainError, NOOP_METRICS, versionConflict } from '@machvon/kernel';
import type { EffectiveAccess, MetricsSink } from '@machvon/kernel';
import { holdsOnWholeTenant } from '../adm/tenant-authority';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import type { EmailChannelPort } from './distribution-channel';
import { itemsForAllRecipients } from './distribution-rules';
import { DocumentDistributionService } from './distribution.service';
import { DOCUMENT_FILE_PORT } from './file-port';
import type { DocumentFilePort } from './file-port';
import { verifyForIssue } from './issue-gate';
import { OutgoingIssuance } from './issuance';
import type { TemplateOverride } from './issuance';
import { normaliseRecipients } from './outgoing-rules';
import type { RevocationPort } from './pades-verifier';
import { DOC_CLOCK, DOC_EMAIL_CHANNEL, DOC_METRICS, DOC_REVOCATION, DOC_TRUST_STORE } from './tokens';
import type { TrustStoreProvider } from './trust-anchors';
import { mayActOnUnit } from './unit-scope';

const OVERRIDE_FIELD = 'unconfirmed_override_reason';
const MIN_OVERRIDE_CHARS = 20;

/**
 * Issuing a sealed outgoing document (ST-DOC-010, DOC.md F7, BR-DOC-10, BR-DOC-17). The document becomes the one in force only after its two signatures have
 * been verified again, now, from the stored file (`verifyForIssue`); a document whose template waits for its legal confirmation is issued only with the
 * written reason of a person who may confirm, and it keeps its watermark. Everything happens in the transaction of the command: the state, the history row,
 * the issue request of the source module, the audit row and the single `doc.issued.v1`. Any refusal leaves the document SEALED and sends nothing.
 */
@Controller()
export class OutgoingIssuanceController {
  private readonly outgoing = new OutgoingDocumentStore();
  private readonly documents = new DocumentStore();
  private readonly templates = new DocumentTemplateStore();
  private readonly signatures = new SignatureStore();
  private readonly registers = new NumberRegisterStore();
  private readonly issuance = new OutgoingIssuance();
  private readonly distribution: DocumentDistributionService;
  private readonly metrics: MetricsSink;
  private readonly clock: () => Date;

  constructor(
    @Inject(DOCUMENT_FILE_PORT) private readonly files: DocumentFilePort,
    @Inject(DOC_TRUST_STORE) private readonly trust: TrustStoreProvider,
    @Inject(DOC_REVOCATION) private readonly revocation: RevocationPort,
    @Inject(DOC_EMAIL_CHANNEL) email: EmailChannelPort,
    @Optional() @Inject(DOC_METRICS) metrics?: MetricsSink,
    @Optional() @Inject(DOC_CLOCK) clock?: () => Date,
  ) {
    this.metrics = metrics ?? NOOP_METRICS;
    this.clock = clock ?? ((): Date => new Date());
    this.distribution = new DocumentDistributionService(email, this.metrics);
  }

  @Post('outgoing-documents/:id/issuance')
  @HttpCode(200)
  @OperationId('issueOutgoingDocument')
  @Command({ operation: 'issueOutgoingDocument', versioned: true })
  async issue(
    @Scope() scope: CommandScope,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: Schemas['DocIssuance'] | undefined,
  ): Promise<CommandResult & Record<string, unknown>> {
    const now = this.clock();
    const request = body ?? {};
    // A document the caller cannot see is indistinguishable from one that does not exist.
    const document = await this.outgoing.lock(scope.tx, id, (first) => scopePredicate(access, PERMISSIONS.issueOutgoingDocument, now, OUTGOING_SCOPE_COLUMNS, first));
    if (document === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (document.version !== scope.expectedVersion) throw versionConflict(document.version);
    if (document.status !== 'SEALED') throw new DomainError('DOCUMENT_STATE_INVALID', 409, 'status');
    if (request.distribute_now === true) await this.assertMayDistribute(scope, access, document.draftingUnitId, now);

    const version = document.currentVersionId === null ? undefined : await this.documents.findVersion(scope.tx, document.currentVersionId);
    if (version === undefined || version.stage !== 'ORG_SEALED' || version.scanStatus !== 'CLEAN') throw new DomainError('DOCUMENT_STATE_INVALID', 409, 'version');
    const file = await this.files.get(version.objectKey);
    if (file === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);

    const gate = await verifyForIssue({ bytes: file.bytes, expectedSha256: version.checksum, trust: this.trust, revocation: this.revocation, tenantId: scope.tenant.tenantId, now });
    if (!gate.ok) {
      this.metrics.increment('doc_signature_verification_total', { result: gate.overall.toLowerCase(), purpose: 'issue' });
      throw gate.error;
    }
    this.metrics.increment('doc_signature_verification_total', { result: 'valid', purpose: 'issue' });
    const { report } = gate.verification;
    await this.signatures.record(scope.tx, { versionId: version.id, signatures: report.signatures, verifiedAt: report.verifiedAt, verifierVersion: report.verifierVersion, reportObjectKey: null });

    const override = await this.templateOverride(scope, access, document.templateId, request.unconfirmed_override_reason);
    const issued = await this.issuance.issue(scope, document, { versionId: version.id, fileSha256: version.checksum }, now, override);
    this.metrics.increment('doc_issued_total', { route: issued.route.toLowerCase() });
    if (override !== undefined) this.metrics.increment('doc_template_unconfirmed_issued_total');
    if (document.sealedAt !== null) this.metrics.gauge('doc_issue_latency_seconds', Math.max(0, (now.getTime() - document.sealedAt.getTime()) / 1000));

    let final = issued;
    let distributionIds: string[] = [];
    if (request.distribute_now === true) {
      const distributed = await this.distribution.dispatch(scope, issued, itemsForAllRecipients(normaliseRecipients(issued.recipients as object[])), now);
      final = distributed.document;
      distributionIds = distributed.changes.map((change) => change.record.id);
    }
    return {
      ...commandResult(scope, final.status, final.version, final.id),
      document_id: final.documentId,
      document_number: final.documentNumber,
      symbol: final.symbol,
      issued_on: final.issuedOn,
      version_id: version.id,
      file_sha256: version.checksum,
      signature_status: report.overall,
      revocation_status: 'GOOD',
      template_unconfirmed: override !== undefined,
      distribution_ids: distributionIds,
    };
  }

  /**
   * BR-DOC-10: a document made from a template that is not confirmed (or whose layout is not) is issued only with a written reason of at least twenty
   * characters from someone who holds the right to confirm templates on the whole tenant; a reason given for a confirmed template is refused, because it
   * would record a justification for something that needed none.
   */
  private async templateOverride(scope: CommandScope, access: EffectiveAccess, templateId: string | null, raw: string | undefined): Promise<TemplateOverride | undefined> {
    const template = templateId === null ? undefined : await this.templates.find(scope.tx, templateId);
    const reason = raw === undefined ? undefined : raw.normalize('NFC').trim();
    if (template === undefined || !rendersWatermarked(template)) {
      if (reason !== undefined) throw new DomainError('VALIDATION_FAILED', 422, OVERRIDE_FIELD, { extensions: { reason: 'OVERRIDE_NOT_NEEDED' } });
      return undefined;
    }
    if (reason === undefined || reason.length < MIN_OVERRIDE_CHARS) throw new DomainError('TEMPLATE_PENDING_LEGAL_CONFIRMATION', 422, OVERRIDE_FIELD);
    if (!holdsOnWholeTenant(access, PERMISSIONS.confirmDocumentTemplateLegalBasis)) throw new DomainError('SCOPE_DENIED', 403);
    return { reason, by: scope.tenant.membershipId };
  }

  /** Distributing at once is a second right: the issuer needs the distribution permission over the unit that drafted the document. */
  private async assertMayDistribute(scope: CommandScope, access: EffectiveAccess, draftingUnitId: string, now: Date): Promise<void> {
    const unit = await this.registers.unitRef(scope.tx, draftingUnitId);
    if (unit === undefined || !mayActOnUnit(access, PERMISSIONS.dispatchOutgoingDocument, unit, now)) throw new DomainError('SCOPE_DENIED', 403);
  }
}
