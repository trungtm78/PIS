import { Body, Controller, HttpCode, Inject, Optional, Post, UseGuards } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { IndDictionaryStore, IndEntryRuleStore, IndFigureStore, IndImportAdapter, IndMappingStore, FileImportStore, previewFileImport, projectScope } from '@machvon/db';
import type { FileImportPreview } from '@machvon/db';
import { DomainError, INDICATOR_IMPORT_CONNECTOR, INDICATOR_IMPORT_MAX_ROWS, NOOP_METRICS, fileSha256, mappingFitsHeaders, mappingProblems, readTabularFile, validateUpload, vietnamDateOf } from '@machvon/kernel';
import type { EffectiveAccess, MetricsSink, TenantContext } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { FileService } from '../files';
import { ImportFileUploadGuard, UploadedBytes } from '../sas/theme-assets';
import type { UploadedFile } from '../sas/theme-assets';
import { rowErrorDto } from './ind-view';
import { IND_CLOCK, IND_METRICS } from './tokens';

const IMPORT_RESOURCE = 'file_import';
const CLASSIFICATION = 'INTERNAL';
/** How many rows of a result the answer carries: a file may have thousands, the screen shows the lines that need a person. */
const ROW_CAP = 500;

/**
 * The import of a form of the customer into figures of the dictionary (IND-1). A person hands over a CSV or Excel file; the door judges it by its bytes, scans it and stores it, and says which approved
 * mappings read it. The dry run reads the file through one approved mapping exactly as the apply will and writes nothing; the apply goes through the file import framework once per hash. Only a version of a
 * mapping that someone other than its maker approved reads a file (a sample of the platform is a template). A row is refused when its project is outside the scope of the caller, its period takes no entry, an
 * indicator is not one that is entered, a number does not fit, or an approved entry rule blocks it; a figure that the register holds with another number is never overwritten but opened as a difference.
 */
@Controller()
export class IndImportController {
  private readonly dictionary = new IndDictionaryStore();
  private readonly entryRules = new IndEntryRuleStore();
  private readonly mappings = new IndMappingStore();
  private readonly figures = new IndFigureStore();
  private readonly imports = new FileImportStore();
  private readonly metrics: MetricsSink;
  private readonly clock: () => Date;

  constructor(
    @Inject(FileService) private readonly files: FileService,
    @Optional() @Inject(IND_METRICS) metrics?: MetricsSink,
    @Optional() @Inject(IND_CLOCK) clock?: () => Date,
  ) {
    this.metrics = metrics ?? NOOP_METRICS;
    this.clock = clock ?? ((): Date => new Date());
  }

  /** Reads the file of an import from the object store: it must still be the file whose hash the caller names. */
  private async bytesOf(tenant: TenantContext, key: string, sha256: string): Promise<Uint8Array> {
    const { bytes } = await this.files.download(tenant, key);
    if (fileSha256(bytes) !== sha256) throw new DomainError('HASH_MISMATCH', 422, 'file');
    return bytes;
  }

  /** The adapter of one request: the approved mapping in force, the dictionary, the approved rules of the surface and the scope of the caller. */
  private async adapterFor(scope: CommandScope, access: EffectiveAccess, body: Schemas['IndImportRequest'], permission: string, now: Date): Promise<IndImportAdapter> {
    const day = vietnamDateOf(now);
    const mapping = await this.mappings.approved(scope.tx, body.mapping_code, day);
    const indicators = await this.dictionary.list(scope.tx, day);
    const rules = await this.entryRules.inForce(scope.tx, day, 'INDICATOR_IMPORT');
    // A mapping that names an indicator nobody defined, or one that is derived, cannot read a file at all.
    const problem = mappingProblems(mapping, indicators)[0];
    if (problem !== undefined) throw new DomainError('VALIDATION_FAILED', 422, `lines[${problem.line}].indicator`);
    let periodCode = body.period_code;
    let periodId: string | undefined;
    if (body.period_id !== undefined) {
      periodId = body.period_id.toLowerCase();
      const code = await this.figures.periodCode(scope.tx, periodId);
      if (code === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
      if (periodCode !== undefined && periodCode !== code) throw new DomainError('VALIDATION_FAILED', 422, 'period_code');
      periodCode = code;
    }
    return new IndImportAdapter({
      mapping,
      context: { projectCode: body.project_code, periodCode },
      indicators,
      rules,
      scope: projectScope(access, permission, now),
      actor: scope.tenant.membershipId,
      now,
      periodId,
    });
  }

  @Post('indicator-imports/files')
  @HttpCode(200)
  @UseGuards(ImportFileUploadGuard)
  @OperationId('uploadIndicatorFile')
  @Command({ operation: 'uploadIndicatorFile' })
  async upload(@Scope() scope: CommandScope, @UploadedBytes() file: UploadedFile): Promise<Schemas['IndFileUpload']> {
    const verdict = validateUpload({ declaredType: file.contentType, bytes: file.bytes, purpose: 'import' });
    if (!verdict.ok) throw new DomainError(verdict.code, verdict.status);
    const stored = await this.files.upload(scope.tenant, { purpose: 'import', declaredType: file.contentType, bytes: file.bytes });
    if (stored.scanStatus === 'INFECTED') throw new DomainError('FILE_NOT_CLEAN', 422);
    if (stored.scanStatus !== 'CLEAN') throw new DomainError('SCAN_PENDING', 409);
    // The table reader inflates a workbook: it reads only a file the scan found clean.
    const table = readTabularFile(file.bytes);
    if (table.rows.length === 0) throw new DomainError('IMPORT_EMPTY', 422, 'file');
    const catalogue = await this.mappings.catalogue(scope.tx, vietnamDateOf(this.clock()));
    const fitting = catalogue.filter((view) => view.active && mappingFitsHeaders(view.mapping, table.headers)).map((view) => view.mapping.code);
    await scope.audit({
      action: 'ind.import_file_uploaded',
      resourceType: IMPORT_RESOURCE,
      resourceId: scope.tenant.tenantId,
      classification: CLASSIFICATION,
      diff: { file_sha256: file.sha256, size_bytes: file.bytes.length, format: table.format, rows: table.rows.length, fitting_mappings: fitting },
    });
    return { file_object_key: stored.key, file_sha256: file.sha256, size_bytes: file.bytes.length, format: table.format, columns: table.headers, row_count: table.rows.length, fitting_mappings: fitting };
  }

  @Post('indicator-imports/preview')
  @HttpCode(200)
  @OperationId('previewIndicatorImport')
  @Command({ operation: 'previewIndicatorImport' })
  async preview(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['IndImportRequest']): Promise<Record<string, unknown>> {
    const now = this.clock();
    const bytes = await this.bytesOf(scope.tenant, body.file_object_key, body.file_sha256);
    const adapter = await this.adapterFor(scope, access, body, PERMISSIONS.previewIndicatorImport, now);
    const preview: FileImportPreview = await previewFileImport(scope.tx, adapter, bytes, { maxRows: INDICATOR_IMPORT_MAX_ROWS });
    await scope.audit({
      action: 'ind.import_previewed',
      resourceType: IMPORT_RESOURCE,
      resourceId: scope.tenant.tenantId,
      classification: CLASSIFICATION,
      diff: { mapping_code: body.mapping_code, format_version: preview.formatVersion, file_sha256: preview.fileSha256, already_applied: preview.alreadyApplied, counts: preview.counts },
    });
    const [code, version] = [body.mapping_code, adapter.mappingVersion];
    return {
      operation_id: scope.requestId,
      status: 'DRY_RUN',
      resource_version: 0,
      mode: 'DRY_RUN',
      mapping_code: code,
      mapping_version: version,
      format_version: preview.formatVersion,
      file_sha256: preview.fileSha256,
      already_applied: preview.alreadyApplied,
      counts: { total: preview.counts.total, valid: preview.counts.valid, errors: preview.counts.errors, duplicate: preview.counts.duplicate, conflict: preview.counts.conflict },
      rows: preview.rows.slice(0, ROW_CAP).map((row) => ({ line: row.line, business_key: row.businessKey, status: row.status, code: row.code ?? null, field: row.field ?? null, outcome: row.outcome ?? null, preview: row.preview ?? null })),
      rows_truncated: preview.rows.length > ROW_CAP,
    };
  }

  @Post('indicator-imports')
  @HttpCode(200)
  @OperationId('importIndicatorFile')
  @Command({ operation: 'importIndicatorFile' })
  async apply(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['IndImportRequest']): Promise<Record<string, unknown>> {
    const now = this.clock();
    const bytes = await this.bytesOf(scope.tenant, body.file_object_key, body.file_sha256);
    const adapter = await this.adapterFor(scope, access, body, PERMISSIONS.importIndicatorFile, now);
    const result = await this.imports.run(scope.tx, {
      adapter,
      bytes,
      fileObjectKey: body.file_object_key,
      expectedSha256: body.file_sha256,
      importedBy: scope.tenant.membershipId,
      fallbackOwnerId: scope.tenant.membershipId,
      correlationId: scope.correlationId,
      maxRows: INDICATOR_IMPORT_MAX_ROWS,
      metrics: this.metrics,
      now,
    });
    // The same file is never applied twice; a file that cannot be read is told as the framework tells it. Both leave nothing behind (the command rolls back).
    if (result.outcome === 'ALREADY_IMPORTED') throw new DomainError('IMPORT_FILE_ALREADY_APPLIED', 409, 'file');
    if (result.outcome === 'FAILED') throw new DomainError(result.errorCode ?? 'IMPORT_SCHEMA_INVALID', 422, 'file');
    const refused = await this.imports.quarantined(scope.tx, result.importId, ROW_CAP + 1);
    const errors = refused.slice(0, ROW_CAP).map(rowErrorDto);
    // A file none of whose rows can be taken is refused as a whole, with the line of each fault: the person corrects it and sends it again.
    if (result.counts.applied === 0 && result.counts.duplicate === 0 && refused.length > 0) {
      throw new DomainError('IMPORT_HAS_ERRORS', 422, 'file', { extensions: { counts: result.counts, errors, errors_truncated: refused.length > ROW_CAP } });
    }
    const counts = {
      total: result.counts.total,
      applied: result.counts.applied,
      duplicate: result.counts.duplicate,
      conflict: result.counts.conflict,
      quarantined: result.counts.quarantined,
      differences_opened: result.counts.differencesOpened,
    };
    const written = adapter.written;
    const mapping = { code: body.mapping_code, version: adapter.mappingVersion };
    // One audit row for the file: the figures it wrote carry the import, the line and the mapping version themselves and are append-only.
    await scope.audit({
      action: 'ind.import_applied',
      resourceType: IMPORT_RESOURCE,
      resourceId: result.importId,
      classification: CLASSIFICATION,
      diff: { mapping_code: mapping.code, mapping_version: mapping.version, connector_code: INDICATOR_IMPORT_CONNECTOR, format_version: adapter.formatVersion, file_sha256: body.file_sha256, counts, figures_written: written.figures, figures_unchanged: written.unchanged, figures_differing: written.differences },
    });
    await scope.emit({
      aggregateType: IMPORT_RESOURCE,
      aggregateId: result.importId,
      aggregateVersion: 1,
      type: 'ind.import.applied.v1',
      schemaVersion: 1,
      payload: {
        tenant_id: scope.tenant.tenantId,
        import_id: result.importId,
        mapping_code: mapping.code,
        mapping_version: mapping.version,
        file_sha256: body.file_sha256,
        rows_total: counts.total,
        rows_applied: counts.applied,
        rows_quarantined: counts.quarantined,
        figures_written: written.figures,
        differences_opened: counts.differences_opened,
        actor_id: scope.tenant.membershipId,
        occurred_at: now.toISOString(),
      },
      eventKey: `${IMPORT_RESOURCE}:${result.importId}:ind-applied`,
    });
    return {
      operation_id: scope.requestId,
      status: 'APPLIED',
      resource_version: 1,
      resource_id: result.importId,
      mode: 'APPLY',
      mapping_code: mapping.code,
      mapping_version: mapping.version,
      format_version: adapter.formatVersion,
      file_sha256: body.file_sha256,
      counts,
      figures_written: written.figures,
      figures_unchanged: written.unchanged,
      figures_differing: written.differences,
      errors,
      errors_truncated: refused.length > ROW_CAP,
    };
  }
}
