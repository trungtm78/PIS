import { Body, Controller, Get, HttpCode, Inject, Optional, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { PayTreasuryImportStore, TenantDatabase, checkTreasuryLayout } from '@machvon/db';
import { DomainError, NOOP_METRICS, asUuid, objectKey, readTabularFile, validateUpload } from '@machvon/kernel';
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
import { holdsOnWholeTenant } from '../adm/tenant-authority';
import { FileService } from '../files';
import { dateOf } from '../mdm/inputs';
import { ImportFileUploadGuard, UploadedBytes } from '../sas/theme-assets';
import type { UploadedFile } from '../sas/theme-assets';
import { PAY_METRICS } from './tokens';
import { treasuryImportLineView, treasuryImportView } from './treasury-view';

const RESOURCE_TYPE = 'treasury_import';
const CLASSIFICATION = 'INTERNAL';
/** The purpose under which the shared upload pipeline stores the file of an import. */
const UPLOAD_PURPOSE = 'import';

/**
 * The Treasury statement import (ST-PAY-006, PAY 3.3 step 3). The file is the one the upload pipeline stored (judged by its bytes, scanned, private
 * to the tenant); its SHA-256 is its identity, so the same file again answers ALREADY_IMPORTED with the first import and changes nothing, and two
 * calls at once give exactly one application. A file covers every project of the tenant and consumes its identity once, so only a caller who
 * holds `treasury.import` on the whole tenant may import: a narrower grant could shadow a file for a wider one. The adapter is PROPOSED and the
 * layout a working assumption (docs/pay-treasury-import.md); the real API is MISSING.
 */
@Controller()
export class TreasuryImportController {
  private readonly store = new PayTreasuryImportStore();
  private readonly metrics: MetricsSink;

  constructor(
    @Inject(FileService) private readonly files: FileService,
    @Optional() @Inject(PAY_METRICS) metrics?: MetricsSink,
  ) {
    this.metrics = metrics ?? NOOP_METRICS;
  }

  /**
   * The upload of a statement file: judged by its bytes, read as a table, checked against the headers of the layout so that the screen can say what the file
   * lacks before it is imported, scanned and stored under the tenant. Nothing is imported yet: the id and the hash it answers are what `importTreasuryStatement` takes.
   */
  @Post('treasury-imports/files')
  @HttpCode(200)
  @UseGuards(ImportFileUploadGuard)
  @OperationId('uploadTreasuryStatementFile')
  @Command({ operation: 'uploadTreasuryStatementFile' })
  async upload(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @UploadedBytes() file: UploadedFile): Promise<Schemas['PayStatementFile']> {
    if (!holdsOnWholeTenant(access, PERMISSIONS.uploadTreasuryStatementFile)) throw new DomainError('SCOPE_DENIED', 403);
    const verdict = validateUpload({ declaredType: file.contentType, bytes: file.bytes, purpose: UPLOAD_PURPOSE });
    if (!verdict.ok) throw new DomainError(verdict.code, verdict.status);
    let table;
    try {
      table = readTabularFile(file.bytes);
    } catch (error) {
      // A file that is not a table is a file in the wrong layout, whatever the reader calls it.
      if (error instanceof DomainError) throw new DomainError('TREASURY_IMPORT_SCHEMA_INVALID', 422, 'file');
      throw error;
    }
    const layout = checkTreasuryLayout(table.headers);
    const stored = await this.files.upload(scope.tenant, { purpose: UPLOAD_PURPOSE, declaredType: file.contentType, bytes: file.bytes });
    if (stored.scanStatus === 'INFECTED') throw new DomainError('FILE_NOT_CLEAN', 422);
    if (stored.scanStatus !== 'CLEAN') throw new DomainError('SCAN_PENDING', 409);
    const fileName = file.name ?? `statement-${file.sha256.slice(0, 12)}`;
    await scope.audit({
      action: 'pay.treasury_file_uploaded',
      resourceType: RESOURCE_TYPE,
      resourceId: scope.tenant.tenantId,
      classification: CLASSIFICATION,
      diff: { file_sha256: file.sha256, size_bytes: file.bytes.length, format: table.format, rows: table.rows.length, layout_ok: layout.ok },
    });
    return {
      file_object_id: stored.key.split('/').pop() ?? '',
      file_sha256: file.sha256,
      size_bytes: file.bytes.length,
      file_name: fileName,
      format: table.format,
      columns: table.headers,
      row_count: table.rows.length,
      layout_ok: layout.ok,
      missing_columns: layout.missing,
    };
  }

  @Post('treasury-imports')
  @HttpCode(200)
  @OperationId('importTreasuryStatement')
  @Command({ operation: 'importTreasuryStatement', ttl: 'extended' })
  async import(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['PayImportTreasuryStatement']): Promise<CommandResult & Record<string, unknown>> {
    if (!holdsOnWholeTenant(access, PERMISSIONS.importTreasuryStatement)) throw new DomainError('SCOPE_DENIED', 403);
    const fileId = asUuid(body.file_object_id);
    if (fileId === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'file_object_id');
    const statementDate = body.statement_date === undefined ? undefined : dateOf(body.statement_date, 'statement_date');
    const fileObjectKey = objectKey(scope.tenant.tenantId, UPLOAD_PURPOSE, fileId);
    // The bytes are read again from the store: the hash that was recorded at the upload must still be the hash of the file that is read.
    const { bytes } = await this.files.download(scope.tenant, fileObjectKey);
    const now = new Date();
    const done = await this.store.import(scope.tx, {
      bytes,
      fileObjectKey,
      expectedSha256: body.file_sha256,
      sourceKind: body.source_kind,
      statementDate,
      fileName: body.file_name?.trim() === '' ? undefined : body.file_name?.trim(),
      importedBy: scope.tenant.membershipId,
      correlationId: scope.correlationId,
      now,
      metrics: this.metrics,
    });
    const repeated = done.outcome === 'ALREADY_IMPORTED';
    const figures = {
      import_id: done.importId,
      file_sha256: done.fileSha256,
      source_kind: body.source_kind,
      row_total: done.counts.total,
      row_new: done.counts.new,
      row_duplicate: done.counts.duplicate,
      row_conflict: done.counts.conflict,
      row_error: done.counts.error,
      differences_opened: done.differencesOpened,
      applied_amount_vnd: done.appliedAmountVnd,
    };
    // A file that was imported already changes nothing: the trail records only that it was asked again.
    await scope.audit({
      action: repeated ? 'pay.treasury_import_repeated' : 'pay.treasury_import_applied',
      resourceType: RESOURCE_TYPE,
      resourceId: done.importId,
      classification: CLASSIFICATION,
      diff: repeated ? { import_id: done.importId, file_sha256: done.fileSha256 } : { ...figures, ...(statementDate === undefined ? {} : { statement_date: statementDate }) },
    });
    if (!repeated) {
      await scope.emit({
        aggregateType: RESOURCE_TYPE,
        aggregateId: done.importId,
        aggregateVersion: 1,
        type: 'pay.treasury_import.applied.v1',
        schemaVersion: 1,
        payload: { tenant_id: scope.tenant.tenantId, actor_id: scope.tenant.membershipId, occurred_at: now.toISOString(), status: done.outcome, ...figures },
        eventKey: `${RESOURCE_TYPE}:${done.importId}:applied`,
      });
    }
    return {
      ...commandResult(scope, done.outcome, 1, done.importId),
      result: done.outcome,
      duplicate: repeated,
      row_total: done.counts.total,
      row_new: done.counts.new,
      row_duplicate: done.counts.duplicate,
      row_conflict: done.counts.conflict,
      row_error: done.counts.error,
      differences_opened: done.differencesOpened,
    };
  }
}

/**
 * One import with what became of its lines, its differences and the state of the adapter (PAY-13). An import belongs to the whole tenant, as
 * the file does: a caller without `treasury.import.read` on the whole tenant finds it as they would find one that does not exist.
 */
@Controller()
export class TreasuryImportReadsController {
  private readonly store = new PayTreasuryImportStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get('treasury-imports')
  @OperationId('listTreasuryImports')
  async list(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Query('limit') limit?: unknown,
    @Query('cursor') cursor?: unknown,
  ): Promise<{ items: Array<Record<string, unknown>>; next_cursor: string | null; as_of: string }> {
    const request = parsePageRequest(limit, cursor);
    // An import belongs to the whole tenant, as the file does: without the read on the whole tenant the list is empty.
    const rows = holdsOnWholeTenant(access, PERMISSIONS.listTreasuryImports)
      ? await this.database.withTenant(tenant, (tx) => this.store.list(tx, { limit: request.limit + 1, after: request.after }))
      : [];
    const shown = rows.slice(0, request.limit);
    const last = shown[shown.length - 1];
    return {
      items: shown.map(treasuryImportLineView),
      next_cursor: rows.length > request.limit && last !== undefined ? encodeCursor({ code: last.importedAtKey, id: last.id }) : null,
      as_of: new Date().toISOString(),
    };
  }

  @Get('treasury-imports/:id')
  @OperationId('getTreasuryImport')
  async get(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    if (!holdsOnWholeTenant(access, PERMISSIONS.getTreasuryImport)) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const view = await this.database.withTenant(tenant, async (tx) => {
      const header = await this.store.find(tx, id);
      if (header === undefined) return undefined;
      return treasuryImportView(header, {
        lines: await this.store.rows(tx, header.id),
        differences: await this.store.items(tx, header.id),
        connector: await this.store.connector(tx),
        totals: await this.store.totals(tx),
      });
    });
    if (view === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return view;
  }
}
