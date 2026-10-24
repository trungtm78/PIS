import { Controller, HttpCode, Inject, Optional, Post, UseGuards } from '@nestjs/common';
import { DomainError, NOOP_METRICS, validateUpload } from '@machvon/kernel';
import type { MetricsSink } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import type { Schemas } from '../../contract-types';
import type { CommandScope } from '../../command-scope';
import { OperationId } from '../../operation-id.decorator';
import { FileService } from '../files';
import { ImportFileUploadGuard, UploadedBytes } from '../sas/theme-assets';
import type { UploadedFile } from '../sas/theme-assets';
import { assertPdf, pageCountOf, sha256Hex } from './external-signature';
import { verifyPdfSignatures } from './pades-verifier';
import { DOC_CLOCK, DOC_METRICS, DOC_TRUST_STORE } from './tokens';
import type { TrustStoreProvider } from './trust-anchors';

/**
 * A PDF into DOC through the shared upload pipeline (judged by its bytes, scanned, stored under the tenant), and a first look at what it holds: how
 * many pages and which signatures, with their verdicts. Nothing is attached to a document yet: the key and the hash it answers are what
 * `uploadLeaderSignedDocument` and `registerExternallySignedDocument` take, and those commands verify again, strictly, before they accept anything.
 */
@Controller()
export class DocumentFilesController {
  private readonly metrics: MetricsSink;
  private readonly clock: () => Date;

  constructor(
    @Inject(FileService) private readonly files: FileService,
    @Inject(DOC_TRUST_STORE) private readonly trust: TrustStoreProvider,
    @Optional() @Inject(DOC_METRICS) metrics?: MetricsSink,
    @Optional() @Inject(DOC_CLOCK) clock?: () => Date,
  ) {
    this.metrics = metrics ?? NOOP_METRICS;
    this.clock = clock ?? ((): Date => new Date());
  }

  @Post('document-files')
  @HttpCode(200)
  @UseGuards(ImportFileUploadGuard)
  @OperationId('uploadDocumentFile')
  @Command({ operation: 'uploadDocumentFile' })
  async upload(@Scope() scope: CommandScope, @UploadedBytes() file: UploadedFile): Promise<Schemas['DocFileUpload']> {
    const verdict = validateUpload({ declaredType: file.contentType, bytes: file.bytes, purpose: 'document' });
    if (!verdict.ok) throw new DomainError(verdict.code, verdict.status);
    assertPdf(file.bytes);
    const pages = await pageCountOf(file.bytes);
    const stored = await this.files.upload(scope.tenant, { purpose: 'document', declaredType: file.contentType, bytes: file.bytes });
    if (stored.scanStatus === 'INFECTED') throw new DomainError('FILE_NOT_CLEAN', 422);
    if (stored.scanStatus !== 'CLEAN') throw new DomainError('SCAN_PENDING', 409);
    const report = await verifyPdfSignatures(file.bytes, await this.trust.forTenant(scope.tenant.tenantId), this.clock(), { policy: 'STRICT' });
    await scope.audit({
      action: 'document.file_uploaded',
      resourceType: 'document_file',
      resourceId: scope.tenant.tenantId,
      diff: { file_sha256: sha256Hex(file.bytes), size_bytes: file.bytes.length, page_count: pages, signature_count: report.signatures.length, overall: report.overall },
    });
    this.metrics.increment('doc_file_upload_total', { outcome: 'stored' });
    return {
      file_object_key: stored.key,
      file_sha256: sha256Hex(file.bytes),
      size_bytes: file.bytes.length,
      page_count: pages,
      overall: report.overall,
      signatures: report.signatures.map((signature) => ({
        role: signature.role,
        status: signature.status,
        chain_status: signature.chainStatus,
        signed_at: signature.signedAt === null ? null : signature.signedAt.toISOString(),
        timestamp_proven: signature.timestampAt !== null,
        incremental_changes_allowed: signature.incrementalChangesAllowed,
        findings: signature.findings,
      })),
    };
  }
}
