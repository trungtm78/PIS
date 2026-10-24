import { createHash } from 'node:crypto';
import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { MasterImportStore, TenantDatabase } from '@machvon/db';
import type { ImportBatchRow, ImportMode } from '@machvon/db';
import { DomainError, readTabularFile, validateUpload } from '@machvon/kernel';
import type { TenantContext } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { OperationId } from '../../operation-id.decorator';
import { encodeCursor, parsePageRequest } from '../../pagination';
import { CurrentTenant } from '../../tenant-context.decorator';
import { FileService } from '../files';
import { ImportFileUploadGuard, UploadedBytes } from '../sas/theme-assets';
import type { UploadedFile } from '../sas/theme-assets';

const RESOURCE_TYPE = 'master_import_batch';
const RECORD_RESOURCE_TYPE = 'master_record';
const BATCH_STATUSES: ReadonlySet<string> = new Set(['STAGED', 'VALIDATED', 'IN_REVIEW', 'APPLIED', 'FAILED', 'CANCELLED']);
const MODES: ReadonlySet<string> = new Set(['ATOMIC', 'PARTIAL']);
const DECISION_ACTIONS = { approve: 'master.import_approved', reject: 'master.import_rejected' } as const;

const sha256Of = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

function batchViewOf(batch: ImportBatchRow): Record<string, unknown> {
  return {
    id: batch.id,
    master_type: batch.masterType,
    file_object_key: batch.fileObjectKey,
    file_sha256: batch.fileSha256,
    mapping: batch.mapping,
    mode: batch.mode,
    status: batch.status,
    total_rows: batch.totalRows,
    error_rows: batch.errorRows,
    errors: batch.errors,
    applied_at: batch.appliedAt,
    applied_by: batch.appliedBy,
    reviewed_by: batch.reviewedBy,
    published_by: batch.publishedBy,
    decision_document_id: batch.decisionDocumentId,
    created_by: batch.createdBy,
    version: batch.version,
  };
}

/**
 * Bulk import of a catalogue (ST-MDM-006, MDM 3.1 F7): the file is uploaded through the shared pipeline (judged by its bytes, scanned), staged
 * (every row judged, the errors kept), applied (every record and change request created together, ATOMIC or PARTIAL) and then reviewed and
 * published as one by people who did not apply it. The file is the source of truth: stage and apply read it from the object store and
 * check its hash again.
 */
@Controller()
export class MasterImportController {
  private readonly store = new MasterImportStore();

  constructor(@Inject(FileService) private readonly files: FileService) {}

  /** Reads the file of a batch from the object store: it must still be the file that was staged. */
  private async bytesOf(tenant: TenantContext, key: string, sha256: string): Promise<Uint8Array> {
    const { bytes } = await this.files.download(tenant, key);
    if (sha256Of(bytes) !== sha256) throw new DomainError('VALIDATION_FAILED', 422, 'file_sha256');
    return bytes;
  }

  @Post('master-imports/files')
  @HttpCode(200)
  @UseGuards(ImportFileUploadGuard)
  @OperationId('uploadMasterImportFile')
  @Command({ operation: 'uploadMasterImportFile' })
  async upload(@Scope() scope: CommandScope, @UploadedBytes() file: UploadedFile): Promise<Schemas['MdmImportFile']> {
    // What the file is comes first (its bytes, not its name), then the scan, and only then whether it is a table: its columns and rows are what the mapping
    // step needs, and the table reader is a parser of the sender's bytes that reads only a file the scan found clean.
    const verdict = validateUpload({ declaredType: file.contentType, bytes: file.bytes, purpose: 'import' });
    if (!verdict.ok) throw new DomainError(verdict.code, verdict.status);
    const stored = await this.files.upload(scope.tenant, { purpose: 'import', declaredType: file.contentType, bytes: file.bytes });
    if (stored.scanStatus === 'INFECTED') throw new DomainError('FILE_NOT_CLEAN', 422);
    if (stored.scanStatus !== 'CLEAN') throw new DomainError('SCAN_PENDING', 409);
    const table = readTabularFile(file.bytes);
    await scope.audit({
      action: 'master.import_file_uploaded',
      resourceType: RESOURCE_TYPE,
      resourceId: scope.tenant.tenantId,
      diff: { file_sha256: file.sha256, size_bytes: file.bytes.length, format: table.format, rows: table.rows.length },
    });
    return { file_object_key: stored.key, file_sha256: file.sha256, size_bytes: file.bytes.length, format: table.format, columns: table.headers, row_count: table.rows.length };
  }

  @Post('master-imports')
  @HttpCode(200)
  @OperationId('stageMasterImport')
  @Command({ operation: 'stageMasterImport' })
  async stage(@Scope() scope: CommandScope, @Body() body: Schemas['MdmImportRequest']): Promise<CommandResult> {
    if (!MODES.has(body.mode)) throw new DomainError('VALIDATION_FAILED', 422, 'mode');
    const bytes = await this.bytesOf(scope.tenant, body.file_object_key, body.file_sha256);
    const batch = await this.store.stage(
      scope.tx,
      { masterType: body.master_type, fileObjectKey: body.file_object_key, fileSha256: body.file_sha256, mapping: body.mapping, mode: body.mode as ImportMode, bytes },
      scope.tenant.membershipId,
    );
    await scope.audit({
      action: 'master.import_staged',
      resourceType: RESOURCE_TYPE,
      resourceId: batch.id,
      diff: { master_type: batch.masterType, file_sha256: batch.fileSha256, mode: batch.mode, total_rows: batch.totalRows, error_rows: batch.errorRows },
    });
    return commandResult(scope, batch.status, batch.version, batch.id);
  }

  @Post('master-imports/:id/apply')
  @HttpCode(200)
  @OperationId('applyMasterImport')
  @Command({ operation: 'applyMasterImport', versioned: true })
  async apply(@Scope() scope: CommandScope, @Param('id', ParseUUIDPipe) id: string): Promise<CommandResult> {
    const staged = await this.store.find(scope.tx, id);
    if (staged === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const bytes = await this.bytesOf(scope.tenant, staged.fileObjectKey, staged.fileSha256);
    const applied = await this.store.apply(scope.tx, id, scope.expectedVersion ?? 0, bytes, scope.tenant.membershipId);
    await scope.audit({
      action: 'master.import_applied',
      resourceType: RESOURCE_TYPE,
      resourceId: id,
      diff: { master_type: applied.batch.masterType, file_sha256: applied.batch.fileSha256, mode: applied.batch.mode, created: applied.created, skipped: applied.skipped },
    });
    await scope.emit({
      aggregateType: RESOURCE_TYPE,
      aggregateId: id,
      aggregateVersion: applied.batch.version,
      type: 'master.import_submitted.v1',
      schemaVersion: 1,
      payload: { batch_id: id, master_type: applied.batch.masterType, rows: applied.created, skipped_rows: applied.skipped },
      eventKey: `${RESOURCE_TYPE}:${id}:submitted`,
    });
    return commandResult(scope, applied.batch.status, applied.batch.version, id);
  }

  @Post('master-imports/:id/decision')
  @HttpCode(200)
  @OperationId('decideMasterImport')
  @Command({ operation: 'decideMasterImport', versioned: true })
  async decide(@Scope() scope: CommandScope, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['MdmDecision']): Promise<CommandResult> {
    // A batch is approved or rejected as a whole: there is no "return" of a few of its rows.
    if (body.decision !== 'approve' && body.decision !== 'reject') throw new DomainError('VALIDATION_FAILED', 422, 'decision');
    const decided = await this.store.decide(scope.tx, id, scope.expectedVersion ?? 0, body.decision, scope.tenant.membershipId);
    await scope.audit({
      action: DECISION_ACTIONS[body.decision],
      resourceType: RESOURCE_TYPE,
      resourceId: id,
      reason: body.reason,
      diff: { master_type: decided.batch.masterType, decision: body.decision, changes: decided.changes, status: decided.batch.status },
    });
    return commandResult(scope, decided.batch.status, decided.batch.version, id);
  }

  @Post('master-imports/:id/publish')
  @HttpCode(200)
  @OperationId('publishMasterImport')
  @Command({ operation: 'publishMasterImport', versioned: true })
  async publish(@Scope() scope: CommandScope, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['CapApplyDecision']): Promise<CommandResult> {
    const published = await this.store.publish(scope.tx, id, scope.expectedVersion ?? 0, body.decision_document_id.toLowerCase(), scope.tenant.membershipId);
    const { batch } = published;
    await scope.audit({
      action: 'master.import_published',
      resourceType: RESOURCE_TYPE,
      resourceId: id,
      diff: { master_type: batch.masterType, file_sha256: batch.fileSha256, decision_document_id: body.decision_document_id, published: published.published.length },
    });
    for (const record of published.published) {
      await scope.emit({
        aggregateType: RECORD_RESOURCE_TYPE,
        aggregateId: record.recordId,
        aggregateVersion: record.recordVersion,
        type: 'master.published.v1',
        schemaVersion: 1,
        payload: {
          master_record_id: record.recordId,
          master_type: batch.masterType,
          business_key: record.businessKey,
          version_id: record.versionId,
          change_kind: 'CREATE',
          effective_from: record.validFrom,
        },
        eventKey: `${RECORD_RESOURCE_TYPE}:${record.recordId}:${record.changeId}`,
      });
    }
    await scope.emit({
      aggregateType: RESOURCE_TYPE,
      aggregateId: id,
      aggregateVersion: batch.version,
      type: 'master.import_applied.v1',
      schemaVersion: 1,
      payload: { batch_id: id, master_type: batch.masterType, file_sha256: batch.fileSha256, records: published.published.length },
      eventKey: `${RESOURCE_TYPE}:${id}:applied`,
    });
    return commandResult(scope, batch.status, batch.version, id);
  }
}

/** Reads of the import batches: the list for MDM-29 and one batch with its row errors. */
@Controller()
export class MasterImportReadsController {
  private readonly store = new MasterImportStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get('master-imports')
  @OperationId('listMasterImports')
  async list(
    @CurrentTenant() tenant: TenantContext,
    @Query('status') status?: unknown,
    @Query('limit') limit?: unknown,
    @Query('cursor') cursor?: unknown,
  ): Promise<{ items: Array<Record<string, unknown>>; next_cursor: string | null }> {
    const request = parsePageRequest(limit, cursor);
    if (status !== undefined && (typeof status !== 'string' || !BATCH_STATUSES.has(status))) throw new DomainError('VALIDATION_FAILED', 422, 'status');
    const rows = await this.database.withTenant(tenant, (tx) => this.store.list(tx, { status: status as string | undefined, limit: request.limit + 1, after: request.after }));
    const shown = rows.slice(0, request.limit);
    const last = shown[shown.length - 1];
    return {
      // The row errors belong to the batch itself, not to the list: a list of batches is short rows.
      items: shown.map((batch) => ({ ...batchViewOf(batch), errors: undefined })),
      next_cursor: rows.length > request.limit && last !== undefined ? encodeCursor({ code: last.createdAtKey, id: last.id }) : null,
    };
  }

  @Get('master-imports/:id')
  @OperationId('getMasterImport')
  async get(@CurrentTenant() tenant: TenantContext, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    return this.database.withTenant(tenant, async (tx) => {
      const batch = await this.store.find(tx, id);
      if (batch === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
      return { ...batchViewOf(batch), changes: await this.store.changeCounts(tx, id) };
    });
  }
}
