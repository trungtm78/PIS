import { randomUUID } from 'node:crypto';
import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { AuditWriter, BidProposalReads, BidProposalStore, TenantDatabase, projectScope } from '@machvon/db';
import type { ProposalFile, ProposalFileInput, ProposalLine, ProposalViewer } from '@machvon/db';
import { DomainError, asUuid, fileSha256, parseObjectKey, validateUpload } from '@machvon/kernel';
import type { EffectiveAccess, TenantContext } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { encodeCursor, parsePageRequest } from '../../pagination';
import { CurrentTenant } from '../../tenant-context.decorator';
import { assertPdf, pageCountOf } from '../doc/external-signature';
import { FileService } from '../files';
import { DocumentFileUploadGuard, UploadedBytes } from '../sas/theme-assets';
import type { UploadedFile } from '../sas/theme-assets';

const RECEIVE_PERMISSION = PERMISSIONS.receiveProposal;
const EVALUATE_PERMISSION = PERMISSIONS.declareConflictOfInterest;
const RESOURCE_TYPE = 'proposal';
/** The purpose under which the shared upload pipeline keeps the files of documents. */
const DOCUMENT_PURPOSE = 'document';

/** A file of a proposal as the evaluators read it: what it is, never where it is kept. */
const fileView = (file: ProposalFile): Record<string, unknown> => ({
  id: file.id,
  part: file.part,
  title: file.title,
  mime: file.mime,
  page_count: file.pageCount,
  size_bytes: file.sizeBytes,
  received_at: file.receivedAt,
});

/**
 * A proposal as its reader may see it (BR-BID-03, an allowlist): the metadata for everyone who may see it at all, and the price (and, in the detail, the files) only in the
 * full view. The `access` says which view it is, so the screen can say why the rest is missing.
 */
export function proposalDto(line: ProposalLine, files?: readonly ProposalFile[]): Record<string, unknown> {
  return {
    id: line.id,
    package: { id: line.package.id, code: line.package.code, title: line.package.title },
    project: { id: line.project.id, code: line.project.code },
    contractor: { id: line.contractor.id, legal_name: line.contractor.legalName },
    revision: line.revision,
    status: line.status,
    submitted_at: line.submittedAt,
    access_released_at: line.accessReleasedAt,
    locked: !line.released,
    file_count: line.fileCount,
    classification: line.classification,
    access: line.view,
    conflict_standing: line.standing,
    version: line.version,
    ...(line.view === 'FULL' ? { bid_price_vnd: line.bidPriceVnd } : {}),
    ...(line.view === 'FULL' && files !== undefined ? { documents: files.map(fileView) } : {}),
  };
}

/**
 * The sealed proposal (ST-BID-004, BID 3 F3): a clerk of the scope of `bid.proposal.receive` logs the files a contractor handed in while the bids are open. Each file comes
 * through the shared upload pipeline first (judged by its bytes, scanned, stored under the tenant); the proposal names the clean uploads, and each is read again here, so that
 * what is kept is the file whose digest the clerk named. The proposal is stored confidential, sealed until the opening of the bids of its package.
 */
@Controller()
export class ProposalController {
  private readonly proposals = new BidProposalStore();

  constructor(@Inject(FileService) private readonly files: FileService) {}

  @Post('proposals/files')
  @HttpCode(200)
  @UseGuards(DocumentFileUploadGuard)
  @OperationId('uploadProposalFile')
  @Command({ operation: 'uploadProposalFile' })
  async upload(@Scope() scope: CommandScope, @UploadedBytes() file: UploadedFile): Promise<Schemas['BidProposalFileUpload']> {
    // What the file is comes first (its bytes, not its name), then whether it is a PDF the reader can open.
    const verdict = validateUpload({ declaredType: file.contentType, bytes: file.bytes, purpose: DOCUMENT_PURPOSE });
    if (!verdict.ok) throw new DomainError(verdict.code, verdict.status);
    assertPdf(file.bytes);
    const stored = await this.files.upload(scope.tenant, { purpose: DOCUMENT_PURPOSE, declaredType: file.contentType, bytes: file.bytes });
    if (stored.scanStatus === 'INFECTED') throw new DomainError('FILE_NOT_CLEAN', 422);
    if (stored.scanStatus !== 'CLEAN') throw new DomainError('SCAN_PENDING', 409);
    // The PDF reader is a parser of the sender's bytes: it reads only a file the scan found clean.
    const pages = await pageCountOf(file.bytes);
    await scope.audit({
      action: 'bid.proposal_file_uploaded',
      resourceType: 'proposal_file',
      resourceId: scope.tenant.tenantId,
      diff: { file_sha256: file.sha256, size_bytes: file.bytes.length, page_count: pages },
      classification: 'CONFIDENTIAL',
    });
    return { file_object_key: stored.key, file_sha256: file.sha256, size_bytes: file.bytes.length, page_count: pages };
  }

  @Post('proposals')
  @HttpCode(200)
  @OperationId('receiveProposal')
  @Command({ operation: 'receiveProposal' })
  async receive(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['BidProposalReceive']): Promise<CommandResult> {
    const now = new Date();
    const packageId = idOf(body.package_id, 'package_id');
    const contractorId = idOf(body.contractor_id, 'contractor_id');
    const files = await this.filesOf(scope.tenant, body.documents);
    const received = await this.proposals.receive(
      scope.tx,
      { packageId, contractorId, submittedAt: body.submitted_at, bidPriceVnd: body.bid_price_vnd, files },
      scope.tenant.membershipId,
      projectScope(access, RECEIVE_PERMISSION, now),
      now,
    );
    // The audit row and the event say that a proposal came in and from whom, never what it offers: no price, no file name.
    await scope.audit({
      action: 'bid.proposal_received',
      resourceType: RESOURCE_TYPE,
      resourceId: received.id,
      diff: {
        package_code: received.packageCode,
        contractor_id: received.contractorId,
        revision: received.revision,
        submitted_at: received.submittedAt,
        access_released_at: received.accessReleasedAt,
        file_count: received.fileCount,
        has_price: received.hasPrice,
        superseded_id: received.supersededId,
      },
      classification: 'CONFIDENTIAL',
    });
    await scope.emit({
      aggregateType: RESOURCE_TYPE,
      aggregateId: received.id,
      aggregateVersion: received.version,
      type: 'bid.proposal.received.v1',
      schemaVersion: 1,
      payload: {
        tenant_id: scope.tenant.tenantId,
        proposal_id: received.id,
        package_id: received.packageId,
        project_id: received.projectId,
        contractor_id: received.contractorId,
        revision: received.revision,
        file_count: received.fileCount,
        submitted_at: received.submittedAt,
        access_released_at: received.accessReleasedAt,
        superseded_id: received.supersededId,
        actor_id: scope.tenant.membershipId,
        occurred_at: now.toISOString(),
      },
      eventKey: `${RESOURCE_TYPE}:${received.id}:${received.version}`,
    });
    return commandResult(scope, 'RECEIVED', received.version, received.id);
  }

  /** Reads each upload again: it must exist for the tenant, be clean and be the file whose digest the clerk named, and it is a PDF. Only what the store needs is kept. */
  private async filesOf(tenant: TenantContext, documents: Schemas['BidProposalReceive']['documents']): Promise<ProposalFileInput[]> {
    const inputs: ProposalFileInput[] = [];
    for (const document of documents) {
      const parts = parseObjectKey(document.file_object_key);
      if (parts === undefined || parts.kind !== DOCUMENT_PURPOSE) throw new DomainError('VALIDATION_FAILED', 422, 'documents', { extensions: { reason: 'FILE_KEY_INVALID' } });
      const { object, bytes } = await this.files.download(tenant, document.file_object_key);
      const digest = fileSha256(bytes);
      if (digest !== document.file_sha256.toLowerCase()) throw new DomainError('VALIDATION_FAILED', 422, 'documents', { extensions: { reason: 'FILE_DIGEST_MISMATCH' } });
      assertPdf(bytes);
      inputs.push({
        part: document.part,
        title: document.title.normalize('NFC').trim(),
        objectKey: document.file_object_key,
        checksum: digest,
        mime: object.contentType,
        pageCount: await pageCountOf(bytes),
        byteLength: bytes.length,
      });
    }
    return inputs;
  }
}

const idOf = (value: unknown, field: string): string => {
  const id = typeof value === 'string' ? asUuid(value) : undefined;
  if (id === undefined) throw new DomainError('VALIDATION_FAILED', 422, field);
  return id.toLowerCase();
};

/**
 * The proposals for reading (BID-05, BR-BID-03). What a caller sees of one is decided by the kernel from where they stand: the clerk sees its metadata at all times, a member of
 * the evaluation team sees all of it from the opening of the bids and only if no conflict stands between them and the bidder. A proposal the caller may not see does not exist
 * for them (404); one they would see but for the declaration they owe is 403 CONFLICT_UNDECLARED, and opening one in full leaves a row in the audit trail.
 */
@Controller('resources/proposal')
export class ProposalReadsController {
  private readonly reads = new BidProposalReads();
  private readonly audit: AuditWriter;

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {
    this.audit = new AuditWriter(database);
  }

  @Get()
  @OperationId('get_resources_proposal')
  async list(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Query('package_id') packageId?: unknown,
    @Query('limit') limit?: unknown,
    @Query('cursor') cursor?: unknown,
  ): Promise<{ items: Array<Record<string, unknown>>; next_cursor: string | null; as_of: string }> {
    const request = parsePageRequest(limit, cursor);
    const now = new Date();
    const filter = packageId === undefined ? undefined : idOf(packageId, 'package_id');
    const page = await this.database.withTenant(tenant, (tx) => this.reads.list(tx, viewerOf(tenant, access, now), { packageId: filter }, request));
    return {
      items: page.lines.map((line) => proposalDto(line)),
      next_cursor: page.more && page.last !== undefined ? encodeCursor(page.last) : null,
      as_of: now.toISOString(),
    };
  }

  @Get(':id')
  @OperationId('get_resources_proposal_id')
  async get(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    const now = new Date();
    const found = await this.database.withTenant(tenant, async (tx) => {
      const seen = await this.reads.find(tx, id.toLowerCase(), viewerOf(tenant, access, now));
      if (seen.kind === 'SEEN' && seen.line.view === 'FULL') {
        // Opening the contents of a sealed proposal is recorded: who, which proposal, when.
        await this.audit.recordInTx(tx, tenant.membershipId, {
          action: 'bid.proposal_opened',
          resourceType: RESOURCE_TYPE,
          resourceId: seen.line.id,
          diff: { package_code: seen.line.package.code, contractor_id: seen.line.contractor.id, revision: seen.line.revision, file_count: seen.files.length },
          classification: 'CONFIDENTIAL',
          correlationId: randomUUID(),
          requestId: randomUUID(),
        });
      }
      return seen;
    });
    if (found.kind === 'HIDDEN') throw new DomainError('RESOURCE_NOT_FOUND', 404);
    if (found.kind === 'DECLARATION_REQUIRED') throw new DomainError('CONFLICT_UNDECLARED', 403);
    return proposalDto(found.line, found.files);
  }
}

function viewerOf(tenant: TenantContext, access: EffectiveAccess, now: Date): ProposalViewer {
  return {
    membershipId: tenant.membershipId,
    evaluate: projectScope(access, EVALUATE_PERMISSION, now),
    receive: projectScope(access, RECEIVE_PERMISSION, now),
    now,
  };
}
