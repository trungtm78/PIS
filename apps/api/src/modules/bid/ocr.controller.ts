import { randomUUID } from 'node:crypto';
import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { AuditWriter, BidOcrStore, TenantDatabase, projectScope } from '@machvon/db';
import type { OcrPageLine, ProposalViewer, ScopeBuilder } from '@machvon/db';
import { DomainError, MAX_OCR_TEXT_BYTES, OCR_CONFIDENCE_THRESHOLD_TEXT, OCR_STATUSES, asUuid, fileSha256, parseObjectKey, validateUpload } from '@machvon/kernel';
import type { EffectiveAccess, OcrStatus, TenantContext } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { encodeCursor, parsePageRequest } from '../../pagination';
import { CurrentTenant } from '../../tenant-context.decorator';
import { FileService } from '../files';
import { DocumentFileUploadGuard, UploadedBytes } from '../sas/theme-assets';
import type { UploadedFile } from '../sas/theme-assets';

const EVALUATE_PERMISSION = PERMISSIONS.declareConflictOfInterest;
const REVIEW_PERMISSION = PERMISSIONS.reviewOcrPage;
const READ_PERMISSION = PERMISSIONS.listProposalOcrPages;
const RESOURCE_TYPE = 'document_page_ocr';
const PROPOSAL_TYPE = 'proposal';
/** The purpose under which the shared upload pipeline keeps the files of documents; a corrected text is kept under it as plain text. */
const DOCUMENT_PURPOSE = 'document';
const TEXT_TYPE = 'text/plain';

const idOf = (value: unknown, field: string): string => {
  const id = typeof value === 'string' ? asUuid(value) : undefined;
  if (id === undefined) throw new DomainError('VALIDATION_FAILED', 422, field);
  return id.toLowerCase();
};

/** Both scopes at once: a page is seen by whoever evaluates the project and holds the OCR permission over it. */
export const within =
  (first: ScopeBuilder, second: ScopeBuilder): ScopeBuilder =>
  (start) => {
    const left = first(start);
    const right = second(start + left.params.length);
    return { sql: `(${left.sql} and ${right.sql})`, params: [...left.params, ...right.params] };
  };

/**
 * Who reads the pages: a member of the evaluation team of the project, with the OCR permission over it. The clerk who receives proposals sees their metadata and no page, so there is no
 * receiving right here: the proposal is the full view for the evaluator, or it does not exist for the caller.
 */
function viewerOf(tenant: TenantContext, access: EffectiveAccess, permission: string, now: Date): ProposalViewer {
  return {
    membershipId: tenant.membershipId,
    evaluate: within(projectScope(access, EVALUATE_PERMISSION, now), projectScope(access, permission, now)),
    receive: () => ({ sql: 'false', params: [] }),
    now,
  };
}

type TextState = 'READABLE' | 'DIGEST_MISMATCH' | 'MISSING';

interface ReadText {
  text: string | null;
  state: TextState;
}

/** A page as the reviewer reads it: what the page is and the texts, never where they are kept. */
export function ocrPageDto(line: OcrPageLine, original: ReadText, correction: ReadText | undefined): Record<string, unknown> {
  const state = original.state !== 'READABLE' || correction === undefined ? original.state : correction.state;
  return {
    id: line.id,
    document_version_id: line.documentVersionId,
    page_index: line.pageIndex,
    ocr_confidence: line.confidence,
    review_status: line.status,
    table_mismatch: line.tableMismatch,
    reviewed_by: line.reviewedBy,
    reviewed_at: line.reviewedAt,
    note: line.note,
    engine_version: line.engineVersion,
    text: original.text,
    text_state: state,
    corrected_text: correction?.text ?? null,
  };
}

/**
 * The OCR of the pages of a proposal and its review (ST-BID-008, BID 3 F3, BR-BID-03/06, BID-06). The pipeline of the analysis records the pages (BidOcrStore.recordPages); a page below the
 * confidence threshold, or with a table whose total is not the sum of its lines, waits for a member of the evaluation team to confirm it or to correct it with a text of their own, and the
 * financial analysis does not run while a page of the proposal waits. A page is seen and reviewed only by whoever has the full view of its proposal: for anyone else it does not exist (404).
 * Reading a page leaves a row in the audit trail; so does reviewing one, and neither carries any of the text.
 */
@Controller()
export class OcrController {
  private readonly store = new BidOcrStore();
  private readonly audit: AuditWriter;

  constructor(
    @Inject(TenantDatabase) private readonly database: TenantDatabase,
    @Inject(FileService) private readonly files: FileService,
  ) {
    this.audit = new AuditWriter(database);
  }

  @Post('document-page-ocr/files')
  @HttpCode(200)
  @UseGuards(DocumentFileUploadGuard)
  @OperationId('uploadOcrCorrectionFile')
  @Command({ operation: 'uploadOcrCorrectionFile' })
  async upload(@Scope() scope: CommandScope, @UploadedBytes() file: UploadedFile): Promise<Schemas['BidOcrCorrectionFileUpload']> {
    // The text of a correction is plain text, judged by its bytes, and no longer than a page of a bid may be.
    const verdict = validateUpload({ declaredType: file.contentType, bytes: file.bytes, purpose: DOCUMENT_PURPOSE });
    if (!verdict.ok) throw new DomainError(verdict.code, verdict.status);
    if (verdict.contentType !== TEXT_TYPE) throw new DomainError('FILE_TYPE_NOT_ALLOWED', 422);
    if (file.bytes.length > MAX_OCR_TEXT_BYTES) throw new DomainError('PAYLOAD_TOO_LARGE', 413);
    const stored = await this.files.upload(scope.tenant, { purpose: DOCUMENT_PURPOSE, declaredType: file.contentType, bytes: file.bytes });
    if (stored.scanStatus === 'INFECTED') throw new DomainError('FILE_NOT_CLEAN', 422);
    if (stored.scanStatus !== 'CLEAN') throw new DomainError('SCAN_PENDING', 409);
    await scope.audit({
      action: 'bid.ocr_correction_uploaded',
      resourceType: RESOURCE_TYPE,
      resourceId: scope.tenant.tenantId,
      diff: { file_sha256: file.sha256, size_bytes: file.bytes.length },
      classification: 'CONFIDENTIAL',
    });
    return { file_object_key: stored.key, file_sha256: file.sha256, size_bytes: file.bytes.length };
  }

  @Post('document-page-ocr/:id/review')
  @HttpCode(200)
  @OperationId('reviewOcrPage')
  @Command({ operation: 'reviewOcrPage' })
  async review(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['BidOcrReview']): Promise<CommandResult> {
    const now = new Date();
    const reviewed = await this.store.review(
      scope.tx,
      id.toLowerCase(),
      { decision: body.decision, correctedTextObjectKey: body.corrected_text_object_key, note: body.note },
      scope.tenant.membershipId,
      viewerOf(scope.tenant, access, REVIEW_PERMISSION, now),
      (key) => this.correctionOf(scope.tenant, key),
    );
    // The audit row and the event say which page was reviewed, how, and whether the proposal can go on to the financial analysis; they carry no text, not even the note.
    await scope.audit({
      action: 'bid.ocr_reviewed',
      resourceType: RESOURCE_TYPE,
      resourceId: reviewed.id,
      diff: {
        proposal_id: reviewed.proposalId,
        package_code: reviewed.packageCode,
        contractor_id: reviewed.contractorId,
        document_version_id: reviewed.documentVersionId,
        page_index: reviewed.pageIndex,
        ocr_confidence: reviewed.confidence,
        table_mismatch: reviewed.tableMismatch,
        previous_status: reviewed.previousStatus,
        status: reviewed.status,
        has_note: reviewed.hasNote,
        financial_ready: reviewed.financialReady,
      },
      classification: 'CONFIDENTIAL',
    });
    await scope.emit({
      aggregateType: RESOURCE_TYPE,
      aggregateId: reviewed.id,
      aggregateVersion: 1,
      type: 'bid.ocr.reviewed.v1',
      schemaVersion: 1,
      payload: {
        tenant_id: scope.tenant.tenantId,
        page_id: reviewed.id,
        proposal_id: reviewed.proposalId,
        package_id: reviewed.packageId,
        project_id: reviewed.projectId,
        contractor_id: reviewed.contractorId,
        document_version_id: reviewed.documentVersionId,
        page_index: reviewed.pageIndex,
        decision: reviewed.status,
        financial_ready: reviewed.financialReady,
        actor_id: scope.tenant.membershipId,
        occurred_at: now.toISOString(),
      },
      // A page is reviewed once, so one event stands for it.
      eventKey: `${RESOURCE_TYPE}:${reviewed.id}:reviewed`,
    });
    return commandResult(scope, reviewed.status, 1, reviewed.id);
  }

  @Get('proposals/:id/ocr-pages')
  @OperationId('listProposalOcrPages')
  async list(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('document_version_id') documentVersionId?: unknown,
    @Query('review_status') reviewStatus?: unknown,
    @Query('limit') limit?: unknown,
    @Query('cursor') cursor?: unknown,
  ): Promise<Record<string, unknown>> {
    const request = parsePageRequest(limit, cursor);
    const now = new Date();
    const filter = {
      documentVersionId: documentVersionId === undefined ? undefined : idOf(documentVersionId, 'document_version_id'),
      status: reviewStatus === undefined ? undefined : statusOf(reviewStatus),
    };
    const proposalId = id.toLowerCase();
    const found = await this.database.withTenant(tenant, async (tx) => {
      const listed = await this.store.listForProposal(tx, proposalId, viewerOf(tenant, access, READ_PERMISSION, now), filter, request);
      if (listed.kind === 'SEEN') {
        // Opening the pages of a sealed proposal is recorded: who, which proposal, when, how many pages.
        await this.audit.recordInTx(tx, tenant.membershipId, {
          action: 'bid.ocr_opened',
          resourceType: PROPOSAL_TYPE,
          resourceId: listed.proposal.id,
          diff: { package_code: listed.proposal.package.code, contractor_id: listed.proposal.contractor.id, revision: listed.proposal.revision, page_count: listed.pages.length },
          classification: 'CONFIDENTIAL',
          correlationId: randomUUID(),
          requestId: randomUUID(),
        });
      }
      return listed;
    });
    if (found.kind === 'HIDDEN') throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (found.kind === 'DECLARATION_REQUIRED') throw new DomainError('CONFLICT_UNDECLARED', 403);
    const items: Array<Record<string, unknown>> = [];
    for (const line of found.pages) {
      const original = await this.textOf(tenant, line.textObjectKey, line.textSha256);
      const correction = line.correctedTextObjectKey === null || line.correctedTextSha256 === null ? undefined : await this.textOf(tenant, line.correctedTextObjectKey, line.correctedTextSha256);
      items.push(ocrPageDto(line, original, correction));
    }
    return {
      items,
      next_cursor: found.more && found.last !== undefined ? encodeCursor(found.last) : null,
      as_of: now.toISOString(),
      financial_ready: found.gate.ready,
      blocked_pages: found.gate.blocked.length,
      threshold: OCR_CONFIDENCE_THRESHOLD_TEXT,
      documents: found.documents.map((document) => ({ document_version_id: document.documentVersionId, title: document.title, part: document.part, page_count: document.pageCount })),
    };
  }

  /** Reads a text from the store and checks it against the digest recorded with it: a text that was changed after it was recorded is not shown as the reading of the page. */
  private async textOf(tenant: TenantContext, key: string, sha256: string): Promise<ReadText> {
    let stored: Awaited<ReturnType<FileService['readStored']>>;
    try {
      stored = await this.files.readStored(tenant, key);
    } catch (error) {
      if (error instanceof DomainError && error.status === 404) return { text: null, state: 'MISSING' };
      throw error;
    }
    if (fileSha256(stored.bytes) !== sha256) return { text: null, state: 'DIGEST_MISMATCH' };
    return { text: new TextDecoder().decode(stored.bytes), state: 'READABLE' };
  }

  /** The text a reviewer puts in place of a page: a clean plain text of this tenant that came through the upload pipeline as a document. */
  private async correctionOf(tenant: TenantContext, key: string): Promise<{ sha256: string }> {
    const parts = parseObjectKey(key);
    if (parts === undefined || parts.kind !== DOCUMENT_PURPOSE) throw new DomainError('VALIDATION_FAILED', 422, 'corrected_text_object_key', { extensions: { reason: 'FILE_KEY_INVALID' } });
    const { object, bytes } = await this.files.download(tenant, key);
    if (object.contentType !== TEXT_TYPE || bytes.length > MAX_OCR_TEXT_BYTES)
      throw new DomainError('VALIDATION_FAILED', 422, 'corrected_text_object_key', { extensions: { reason: 'FILE_TYPE_INVALID' } });
    return { sha256: fileSha256(bytes) };
  }
}

function statusOf(value: unknown): OcrStatus {
  const status = OCR_STATUSES.find((candidate) => candidate === value);
  if (status === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'review_status');
  return status;
}
