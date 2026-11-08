import { Controller, Get, HttpCode, Inject, Post, Query, UseGuards } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { TenantDatabase, VendorPortalAttachmentStore, VendorPortalPolicyReader, VendorPortalStore } from '@machvon/db';
import type { PortalAttachmentRow } from '@machvon/db';
import { DomainError, PORTAL_UPLOAD_MIMES, PORTAL_UPLOAD_PURPOSES, assertPortalUpload, assertScanClean, validateUpload } from '@machvon/kernel';
import type { EffectiveAccess, TenantContext } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import type { CommandScope } from '../../command-scope';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { CurrentTenant } from '../../tenant-context.decorator';
import { pageCountOf } from '../doc/external-signature';
import { FileService } from '../files';
import { ImportFileUploadGuard, UploadedBytes } from '../sas/theme-assets';
import type { UploadedFile } from '../sas/theme-assets';
import { PORTAL_UPLOAD_SCAN } from './tokens';
import { scanFailClosed } from './portal-upload-scan';
import type { PortalUploadScanPort } from './portal-upload-scan';
import { PORTAL_CLASS, announcePortal, assertHoldsAnywhere } from './vendor-portal-view';
import { todayOf } from './vendor-view';

/** The purpose under which the shared upload pipeline keeps the files of documents. */
const DOCUMENT_PURPOSE = 'document';

const attachmentDto = (row: PortalAttachmentRow): Record<string, unknown> => ({
  id: row.id,
  document_id: row.documentId,
  purpose: row.purpose,
  title: row.title,
  mime: row.mime,
  size_bytes: row.sizeBytes,
  sha256: row.sha256,
  uploaded_at: row.uploadedAt,
  linked_kind: row.linkedKind,
  linked_id: row.linkedId,
});

/**
 * The generic upload of the contractor portal (PORTAL-2, VND-24; docs/vendor-investigation.md section 14). One file per call, judged by its bytes (PDF, PNG or JPEG), at most the size the rule `VENDOR_PORTAL_ACCESS` gives (and
 * never more than 10 MiB, the ceiling of the guard), scanned by the portal scan hook BEFORE it is stored (the default hook fails closed: 409 `SCAN_PENDING`; an infected file is 422 `FILE_NOT_CLEAN`), stored by the shared upload
 * pipeline under the tenant prefix, and registered as a document of the DOC framework that belongs to the contractor of the caller (taken from the guest membership, never from the request). The id it answers is what the
 * `document_id` fields of the portal commands take; those commands accept only an attachment of their own contractor.
 */
@Controller()
export class PortalAttachmentController {
  private readonly attachments = new VendorPortalAttachmentStore();
  private readonly portal = new VendorPortalStore();
  private readonly policies = new VendorPortalPolicyReader();

  constructor(
    @Inject(FileService) private readonly files: FileService,
    @Inject(PORTAL_UPLOAD_SCAN) private readonly scanner: PortalUploadScanPort,
    @Inject(TenantDatabase) private readonly database: TenantDatabase,
  ) {}

  @Post('portal/attachments')
  @HttpCode(200)
  @UseGuards(ImportFileUploadGuard)
  @OperationId('uploadPortalAttachment')
  @Command({ operation: 'uploadPortalAttachment' })
  async upload(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @UploadedBytes() file: UploadedFile, @Query('purpose') purposeValue?: unknown, @Query('title') titleValue?: unknown): Promise<Record<string, unknown>> {
    assertHoldsAnywhere(access, PERMISSIONS.uploadPortalAttachment);
    const now = new Date();
    if (typeof purposeValue !== 'string') throw new DomainError('VALIDATION_FAILED', 422, 'purpose');
    if (typeof titleValue !== 'string' || titleValue.trim().length < 1 || titleValue.trim().length > 200) throw new DomainError('VALIDATION_FAILED', 422, 'title');
    // Nobody who is not a guest bound to a contractor gets a byte stored.
    await this.attachments.callerOf(scope.tx, scope.tenant.membershipId);
    const limits = (await this.policies.access(scope.tx, todayOf(now))).value;
    const purpose = assertPortalUpload({ purpose: purposeValue, sizeBytes: file.bytes.length, maxBytes: limits.max_upload_bytes });
    const verdict = validateUpload({ declaredType: file.contentType, bytes: file.bytes, purpose: DOCUMENT_PURPOSE });
    if (!verdict.ok) throw new DomainError(verdict.code, verdict.status);
    if (!(PORTAL_UPLOAD_MIMES as readonly string[]).includes(verdict.contentType)) throw new DomainError('FILE_TYPE_NOT_ALLOWED', 422);
    assertScanClean(await scanFailClosed(this.scanner, file.bytes, { tenantId: scope.tenant.tenantId, mime: verdict.contentType }));
    const stored = await this.files.upload(scope.tenant, { purpose: DOCUMENT_PURPOSE, declaredType: file.contentType, bytes: file.bytes });
    if (stored.scanStatus === 'INFECTED') throw new DomainError('FILE_NOT_CLEAN', 422);
    if (stored.scanStatus !== 'CLEAN') throw new DomainError('SCAN_PENDING', 409);
    // The PDF reader is a parser of the sender's bytes: it reads only a file both scans found clean.
    const pages = verdict.contentType === 'application/pdf' ? await pageCountOf(file.bytes) : 1;
    const row = await this.attachments.register(scope.tx, scope.tenant.membershipId, { purpose, title: titleValue, mime: verdict.contentType, sizeBytes: file.bytes.length, sha256: file.sha256, objectKey: stored.key, pageCount: pages });
    await announcePortal(scope, now, {
      action: 'vnd.portal_attachment_uploaded',
      resourceType: 'portal_attachment',
      resourceId: row.id,
      classification: PORTAL_CLASS.answer,
      version: 1,
      eventType: 'vnd.portal.attachment.uploaded.v1',
      diff: { contractor_id: row.contractorId, document_id: row.documentId, purpose: row.purpose, mime: row.mime, size_bytes: row.sizeBytes, file_sha256: row.sha256 },
    });
    return attachmentDto(row);
  }

  @Get('portal/attachments')
  @OperationId('listPortalAttachments')
  async list(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Query('purpose') purpose?: unknown): Promise<Record<string, unknown>> {
    assertHoldsAnywhere(access, PERMISSIONS.listPortalAttachments);
    if (purpose !== undefined && (typeof purpose !== 'string' || !(PORTAL_UPLOAD_PURPOSES as readonly string[]).includes(purpose))) throw new DomainError('VALIDATION_FAILED', 422, 'purpose');
    const now = new Date();
    return this.database.withTenant(tenant, async (tx) => {
      await this.portal.enter(tx, tenant.membershipId);
      const rows = await this.attachments.listOwn(tx, purpose);
      const limits = (await this.policies.access(tx, todayOf(now))).value;
      return { items: rows.map(attachmentDto), limits: { max_bytes: limits.max_upload_bytes, mimes: [...PORTAL_UPLOAD_MIMES] }, as_of: now.toISOString() };
    });
  }
}
