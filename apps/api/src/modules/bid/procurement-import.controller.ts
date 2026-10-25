import { Body, Controller, HttpCode, Inject, Optional, Post, UseGuards } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { BidProcurementImport, FileImportStore, ProcurementImportAdapter, previewFileImport, projectScope } from '@machvon/db';
import type { FileImportPreview, ImportedMilestone, QuarantinedRow } from '@machvon/db';
import {
  DomainError,
  NOOP_METRICS,
  PROCUREMENT_ADAPTER_STATUS,
  PROCUREMENT_CONNECTOR,
  PROCUREMENT_FORMAT_VERSION,
  fileSha256,
  planFileImport,
  procurementFileFormat,
  readTabularFile,
  validateUpload,
} from '@machvon/kernel';
import type { EffectiveAccess, MetricsSink, TenantContext } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { holdsOnWholeTenant } from '../adm/tenant-authority';
import { FileService } from '../files';
import { ImportFileUploadGuard, UploadedBytes } from '../sas/theme-assets';
import type { UploadedFile } from '../sas/theme-assets';
import { BID_METRICS } from './tokens';

const IMPORT_PERMISSION = PERMISSIONS.importProcurementFile;
const IMPORT_RESOURCE = 'procurement_import_batch';
const PACKAGE_RESOURCE = 'procurement_package';
/** The cursor of the position of the connector: the one the baseline gives each tenant. */
const CURSOR_SCOPE = 'DEFAULT';
/** How many rows of a result the answer carries: a file may have thousands, the screen shows the lines that need a person. */
const ROW_CAP = 500;

const adapterView = {
  connector_code: PROCUREMENT_CONNECTOR,
  format_version: PROCUREMENT_FORMAT_VERSION,
  // The adapter is a proposal: it reads the file a person hands over, and calls no system of the State.
  status: PROCUREMENT_ADAPTER_STATUS,
};

function errorView(row: QuarantinedRow): Record<string, unknown> {
  return { line: row.line, business_key: row.businessKey, code: row.errorCode, field: row.field, preview: row.maskedPreview };
}

function previewRowView(row: FileImportPreview['rows'][number]): Record<string, unknown> {
  return {
    line: row.line,
    business_key: row.businessKey,
    status: row.status,
    ...(row.outcome === undefined ? {} : { outcome: row.outcome }),
    ...(row.code === undefined ? {} : { code: row.code, field: row.field }),
    preview: row.preview ?? null,
  };
}

/**
 * The file of the national bidding system (ST-BID-005, BID 3 F8). A procurement planner downloads an export of the national system and hands it over: the door judges it by its
 * bytes, scans it and stores it; the import reads it as a dry run first (nothing is written), then applies it once (the same bytes are never applied twice) through the file import
 * framework. The apply writes the actual date of the milestones that have none, links each package to its code on the network and keeps the differences for a person to settle.
 * No API of the national system is called: the adapter is PROPOSED (D05).
 */
@Controller()
export class ProcurementImportController {
  private readonly batches = new BidProcurementImport();
  private readonly imports = new FileImportStore();
  private readonly metrics: MetricsSink;

  constructor(
    @Inject(FileService) private readonly files: FileService,
    @Optional() @Inject(BID_METRICS) metrics?: MetricsSink,
  ) {
    this.metrics = metrics ?? NOOP_METRICS;
  }

  /** Reads the file of an import from the object store: it must still be the file whose hash the caller names. */
  private async bytesOf(tenant: TenantContext, key: string, sha256: string): Promise<Uint8Array> {
    const { bytes } = await this.files.download(tenant, key);
    if (fileSha256(bytes) !== sha256) throw new DomainError('HASH_MISMATCH', 422, 'file');
    return bytes;
  }

  @Post('procurement-imports/files')
  @HttpCode(200)
  @UseGuards(ImportFileUploadGuard)
  @OperationId('uploadProcurementFile')
  @Command({ operation: 'uploadProcurementFile' })
  async upload(@Scope() scope: CommandScope, @UploadedBytes() file: UploadedFile): Promise<Schemas['BidProcurementFileUpload']> {
    // What the file is comes first (its bytes, not its name), then whether it is a table with the columns of the layout.
    const verdict = validateUpload({ declaredType: file.contentType, bytes: file.bytes, purpose: 'import' });
    if (!verdict.ok) throw new DomainError(verdict.code, verdict.status);
    const stored = await this.files.upload(scope.tenant, { purpose: 'import', declaredType: file.contentType, bytes: file.bytes });
    if (stored.scanStatus === 'INFECTED') throw new DomainError('FILE_NOT_CLEAN', 422);
    if (stored.scanStatus !== 'CLEAN') throw new DomainError('SCAN_PENDING', 409);
    // The table reader is a parser of the sender's bytes (it inflates a workbook): it reads only a file the scan found clean.
    const table = readTabularFile(file.bytes);
    // The layout is checked on the whole file once it is known to be clean: an unreadable or empty file, or one without the columns, is 422 IMPORT_SCHEMA_INVALID or IMPORT_EMPTY.
    planFileImport(procurementFileFormat, file.bytes);
    await scope.audit({
      action: 'bid.procurement_file_uploaded',
      resourceType: 'file_import',
      resourceId: scope.tenant.tenantId,
      diff: { file_sha256: file.sha256, size_bytes: file.bytes.length, format: table.format, rows: table.rows.length },
    });
    return { file_object_key: stored.key, file_sha256: file.sha256, size_bytes: file.bytes.length, format: table.format, columns: table.headers, row_count: table.rows.length };
  }

  @Post('procurement-imports')
  @HttpCode(200)
  @OperationId('importProcurementFile')
  @Command({ operation: 'importProcurementFile' })
  async import(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['BidImportRequest']): Promise<Record<string, unknown>> {
    const now = new Date();
    const dryRun = body.mode === 'DRY_RUN';
    // The file spans every package of the tenant and its hash is used once: applying it is for whoever holds the right on the whole tenant. A unit-scoped planner who applied it
    // would quarantine the rows of the packages outside their scope and shut the tenant-wide planner out with IMPORT_FILE_ALREADY_APPLIED.
    if (!dryRun && !holdsOnWholeTenant(access, IMPORT_PERMISSION)) throw new DomainError('SCOPE_DENIED', 403);
    // The layout of the file is versioned: a caller that names another layout than the one the adapter reads is refused before the file is opened.
    if (body.mapping_version !== undefined && body.mapping_version !== PROCUREMENT_FORMAT_VERSION) throw new DomainError('VALIDATION_FAILED', 422, 'mapping_version');
    const bytes = await this.bytesOf(scope.tenant, body.file_object_key, body.file_sha256);
    const context = { scope: projectScope(access, IMPORT_PERMISSION, now), actor: scope.tenant.membershipId, now };

    if (dryRun) {
      const preview = await previewFileImport(scope.tx, new ProcurementImportAdapter(context), bytes);
      await scope.audit({
        action: 'bid.procurement_import_previewed',
        resourceType: IMPORT_RESOURCE,
        resourceId: scope.tenant.tenantId,
        diff: { connector_code: preview.connectorCode, format_version: preview.formatVersion, file_sha256: preview.fileSha256, already_applied: preview.alreadyApplied, counts: preview.counts },
      });
      return {
        operation_id: scope.requestId,
        status: 'DRY_RUN',
        resource_version: 0,
        mode: 'DRY_RUN',
        adapter: adapterView,
        file_sha256: preview.fileSha256,
        already_applied: preview.alreadyApplied,
        counts: preview.counts,
        rows_total: preview.counts.total,
        rows_ok: preview.counts.valid,
        rows_error: preview.counts.errors,
        rows: preview.rows.slice(0, ROW_CAP).map(previewRowView),
        rows_truncated: preview.rows.length > ROW_CAP,
      };
    }

    const batchId = await this.batches.begin(scope.tx, { fileSha256: body.file_sha256, fileObjectKey: body.file_object_key, actor: scope.tenant.membershipId });
    const adapter = new ProcurementImportAdapter({ ...context, batchId });
    const result = await this.imports.run(scope.tx, {
      adapter,
      bytes,
      fileObjectKey: body.file_object_key,
      expectedSha256: body.file_sha256,
      importedBy: scope.tenant.membershipId,
      fallbackOwnerId: scope.tenant.membershipId,
      correlationId: scope.correlationId,
      cursorScope: CURSOR_SCOPE,
      metrics: this.metrics,
      now,
    });
    // The same file is never applied twice; a file that cannot be read is told as the framework tells it. Both leave nothing behind (the command rolls back).
    if (result.outcome === 'ALREADY_IMPORTED') throw new DomainError('IMPORT_FILE_ALREADY_APPLIED', 409, 'file');
    if (result.outcome === 'FAILED') throw new DomainError(result.errorCode ?? 'IMPORT_SCHEMA_INVALID', 422, 'file');
    const refused = await this.imports.quarantined(scope.tx, result.importId, ROW_CAP + 1);
    const errors = refused.slice(0, ROW_CAP).map(errorView);
    // A file none of whose rows can be taken is refused as a whole, with the line of each fault: the planner corrects it and sends it again.
    if (result.counts.applied === 0 && result.counts.duplicate === 0 && refused.length > 0) {
      throw new DomainError('IMPORT_HAS_ERRORS', 422, 'file', { extensions: { counts: result.counts, errors, errors_truncated: refused.length > ROW_CAP } });
    }
    await this.batches.finish(
      scope.tx,
      batchId,
      { rowsTotal: result.counts.total, rowsOk: result.counts.applied, rowsError: result.counts.quarantined, errors: refused.slice(0, ROW_CAP).map((row) => ({ line: row.line, business_key: row.businessKey, code: row.errorCode, field: row.field })) },
      scope.tenant.membershipId,
    );
    await scope.audit({
      action: 'bid.procurement_import_applied',
      resourceType: IMPORT_RESOURCE,
      resourceId: batchId,
      diff: {
        connector_code: PROCUREMENT_CONNECTOR,
        format_version: PROCUREMENT_FORMAT_VERSION,
        adapter_status: PROCUREMENT_ADAPTER_STATUS,
        file_sha256: body.file_sha256,
        import_id: result.importId,
        counts: result.counts,
        milestones_written: adapter.imported.length,
      },
    });
    await scope.emit({
      aggregateType: IMPORT_RESOURCE,
      aggregateId: batchId,
      aggregateVersion: 2,
      type: 'bid.import.applied.v1',
      schemaVersion: 1,
      payload: {
        tenant_id: scope.tenant.tenantId,
        batch_id: batchId,
        import_id: result.importId,
        file_sha256: body.file_sha256,
        adapter_status: PROCUREMENT_ADAPTER_STATUS,
        rows_total: result.counts.total,
        rows_ok: result.counts.applied,
        rows_error: result.counts.quarantined,
        differences_opened: result.counts.differencesOpened,
        actor_id: scope.tenant.membershipId,
        occurred_at: now.toISOString(),
      },
      eventKey: `${IMPORT_RESOURCE}:${batchId}:applied`,
    });
    for (const written of adapter.imported) await this.recordImported(scope, written, now);
    return {
      operation_id: scope.requestId,
      status: 'APPLIED',
      resource_version: 2,
      resource_id: batchId,
      mode: 'APPLY',
      adapter: adapterView,
      file_sha256: body.file_sha256,
      counts: result.counts,
      rows_total: result.counts.total,
      rows_ok: result.counts.applied,
      rows_error: result.counts.quarantined,
      milestones_written: adapter.imported.length,
      errors,
      errors_truncated: refused.length > ROW_CAP,
    };
  }

  /** The audit row and the event of a milestone that a file wrote (the same event as a milestone recorded by hand, with its source). */
  private async recordImported(scope: CommandScope, written: ImportedMilestone, now: Date): Promise<void> {
    await scope.audit({
      action: 'bid.milestone_recorded',
      resourceType: PACKAGE_RESOURCE,
      resourceId: written.packageId,
      diff: { package_code: written.packageCode, milestone_kind: written.kind, actual_at: written.actualAt, source: 'IMPORT', action: written.action, batch_id: written.batchId },
    });
    await scope.emit({
      aggregateType: PACKAGE_RESOURCE,
      aggregateId: written.packageId,
      aggregateVersion: written.version,
      type: 'bid.milestone.recorded.v1',
      schemaVersion: 1,
      payload: {
        tenant_id: scope.tenant.tenantId,
        package_id: written.packageId,
        project_id: written.projectId,
        milestone_kind: written.kind,
        actual_at: written.actualAt,
        source: 'IMPORT',
        version: written.version,
        actor_id: scope.tenant.membershipId,
        occurred_at: now.toISOString(),
      },
      eventKey: `${PACKAGE_RESOURCE}:${written.packageId}:${written.version}`,
    });
  }
}
