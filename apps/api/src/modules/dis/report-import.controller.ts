import { createHash } from 'node:crypto';
import { Body, Controller, Get, HttpCode, Inject, Optional, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { DisImportStore, DisPeriodStore, EntNarrativeStore, IMPORT_RESOURCE, REPORT_RESOURCE, TenantDatabase, projectScope } from '@machvon/db';
import type { PeriodRow, ReportImportBatchRow } from '@machvon/db';
import { DomainError, NARRATIVE_IMPORT_MAPPING, mappingOf, parseNarrativeImport, parseReportImport, readTabularFile, validateUpload } from '@machvon/kernel';
import type { EffectiveAccess, TenantContext } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { periodAccess } from './period-gate';
import { OperationId } from '../../operation-id.decorator';
import { CurrentTenant } from '../../tenant-context.decorator';
import { FileService } from '../files';
import { ImportFileUploadGuard, UploadedBytes } from '../sas/theme-assets';
import type { UploadedFile } from '../sas/theme-assets';
import { DIS_CLOCK } from './tokens';

const IMPORT_PERMISSION = PERMISSIONS.createReportImport;
const FILE_PURPOSE = 'import';
/** The kind of period a weekly report is made for; the layout of the workbook is the weekly one. */
const WEEK = 'WEEK';

const sha256Of = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

export function importView(batch: ReportImportBatchRow): Record<string, unknown> {
  return {
    id: batch.id,
    period_id: batch.periodId,
    file_sha256: batch.fileSha256,
    mapping_version: batch.mappingVersion,
    status: batch.status,
    total_rows: batch.totalRows,
    valid_rows: batch.validRows,
    error_rows: batch.errorRows,
    errors: batch.faults.map((fault) => ({ line: fault.line, project_code: fault.projectCode, field: fault.field, code: fault.code })),
    drafts_created: batch.draftsCreated,
    drafts_updated: batch.draftsUpdated,
    applied_at: batch.appliedAt,
    applied_by: batch.appliedBy,
    created_at: batch.createdAt,
    created_by: batch.createdBy,
    version: batch.version,
  };
}

/**
 * The bulk import of weekly reports (ST-DIS-008, DIS 3 F1, DIS-10). The workbook goes through the shared upload pipeline (judged by its bytes, scanned, a table); a dry run reads it with the layout
 * named by `mapping_version` and keeps the fault of every row with its line, its column and a code; only a file without a fault is applied, in one transaction, and every row makes the draft of its
 * project (or brings up to date the one it has) with source IMPORT: nothing is handed in, and a file is applied once for a period. The file is the source of truth: the dry run and the apply read it
 * from the object store and check its hash again, and the apply judges every row again against the register as it is then.
 */
@Controller()
export class ReportImportController {
  private readonly imports = new DisImportStore();
  private readonly periods = new DisPeriodStore();
  private readonly narratives = new EntNarrativeStore();
  private readonly clock: () => Date;

  constructor(
    @Inject(FileService) private readonly files: FileService,
    @Inject(TenantDatabase) private readonly database: TenantDatabase,
    @Optional() @Inject(DIS_CLOCK) clock?: () => Date,
  ) {
    this.clock = clock ?? ((): Date => new Date());
  }

  /** Reads the file of a batch from the object store: it must still be the file that was named. */
  private async bytesOf(tenant: TenantContext, key: string, sha256: string): Promise<Uint8Array> {
    const { bytes } = await this.files.download(tenant, key);
    if (sha256Of(bytes) !== sha256) throw new DomainError('VALIDATION_FAILED', 422, 'file_sha256');
    return bytes;
  }

  @Post('report-imports/files')
  @HttpCode(200)
  @UseGuards(ImportFileUploadGuard)
  @OperationId('uploadReportImportFile')
  @Command({ operation: 'uploadReportImportFile' })
  async upload(@Scope() scope: CommandScope, @UploadedBytes() file: UploadedFile): Promise<Schemas['DisImportFile']> {
    // What the file is comes first (its bytes, not its name), then the scan, and only then whether it is a table.
    const verdict = validateUpload({ declaredType: file.contentType, bytes: file.bytes, purpose: FILE_PURPOSE });
    if (!verdict.ok) throw new DomainError(verdict.code, verdict.status);
    const stored = await this.files.upload(scope.tenant, { purpose: FILE_PURPOSE, declaredType: file.contentType, bytes: file.bytes });
    if (stored.scanStatus === 'INFECTED') throw new DomainError('FILE_NOT_CLEAN', 422);
    if (stored.scanStatus !== 'CLEAN') throw new DomainError('SCAN_PENDING', 409);
    const table = readTabularFile(file.bytes);
    await scope.audit({
      action: 'dis.report_import_file_uploaded',
      resourceType: IMPORT_RESOURCE,
      resourceId: scope.tenant.tenantId,
      diff: { file_sha256: file.sha256, size_bytes: file.bytes.length, format: table.format, rows: table.rows.length },
    });
    return { file_object_key: stored.key, file_sha256: file.sha256, size_bytes: file.bytes.length, format: table.format, columns: table.headers, row_count: table.rows.length };
  }

  @Post('report-imports')
  @HttpCode(200)
  @OperationId('createReportImport')
  @Command({ operation: 'createReportImport' })
  async create(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['DisImportRequest']): Promise<CommandResult> {
    const now = this.clock();
    // The template of the narratives of a period (ENT-3b) is read by the same upload, dry run and apply as the weekly workbook.
    if (body.mapping_version === NARRATIVE_IMPORT_MAPPING) return this.createNarrative(scope, access, body, now);
    mappingOf(body.mapping_version);
    // The period is held against a close or a lock until the transaction ends, as a send holds it.
    const period = await this.periods.find(scope.tx, body.period_id, 'share');
    if (period === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404, 'period_id');
    if (period.periodType !== WEEK) throw new DomainError('VALIDATION_FAILED', 422, 'period_id');
    // The rows are judged in the reach of the grants that allow the period: a grant for the project and another for the period do not add up.
    const reach = await periodAccess(scope.tx, this.periods, period.id, access, IMPORT_PERMISSION, now);
    const applied = await this.imports.appliedFor(scope.tx, period.id, body.file_sha256);
    if (applied !== undefined) throw new DomainError('IMPORT_FILE_ALREADY_APPLIED', 409, 'file_sha256', { extensions: { import_id: applied.id } });
    const bytes = await this.bytesOf(scope.tenant, body.file_object_key, body.file_sha256);
    const parsed = parseReportImport(body.mapping_version, readTabularFile(bytes));
    const judgement = await this.imports.judge(scope.tx, parsed, period, { scope: projectScope(reach, IMPORT_PERMISSION, now), actor: scope.tenant.membershipId, now });
    const batch = await this.imports.record(scope.tx, {
      periodId: period.id,
      fileObjectKey: body.file_object_key,
      fileSha256: body.file_sha256,
      mappingVersion: body.mapping_version,
      totalRows: parsed.totalRows,
      faults: judgement.faults,
      actor: scope.tenant.membershipId,
    });
    await scope.audit({
      action: 'dis.report_import_validated',
      resourceType: IMPORT_RESOURCE,
      resourceId: batch.id,
      diff: { period_code: period.code, file_sha256: batch.fileSha256, mapping_version: batch.mappingVersion, total_rows: batch.totalRows, valid_rows: batch.validRows, error_rows: batch.errorRows, status: batch.status },
    });
    return commandResult(scope, batch.status, batch.version, batch.id);
  }

  @Post('report-imports/:id/apply')
  @HttpCode(200)
  @OperationId('applyReportImport')
  @Command({ operation: 'applyReportImport', versioned: true })
  async apply(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<CommandResult> {
    const now = this.clock();
    const batch = await this.imports.lockForApply(scope.tx, id, scope.expectedVersion ?? 0, scope.tenant.membershipId);
    const period = await this.periods.find(scope.tx, batch.periodId, 'share');
    if (period === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404, 'period_id');
    const reach = await periodAccess(scope.tx, this.periods, period.id, access, IMPORT_PERMISSION, now);
    const bytes = await this.bytesOf(scope.tenant, batch.fileObjectKey, batch.fileSha256);
    if (batch.mappingVersion === NARRATIVE_IMPORT_MAPPING) return this.applyNarrative(scope, batch, period, projectScope(reach, IMPORT_PERMISSION, now), bytes, now);
    const parsed = parseReportImport(batch.mappingVersion, readTabularFile(bytes));
    const context = { scope: projectScope(reach, IMPORT_PERMISSION, now), actor: scope.tenant.membershipId, now };
    // The rows are judged again against the register as it is now: a project that was reported on, or a period that was locked, since the dry run is told here, before anything is written.
    const judgement = await this.imports.judge(scope.tx, parsed, period, context);
    if (judgement.faults.some((fault) => fault.code === 'PERIOD_LOCKED')) throw new DomainError('PERIOD_LOCKED', 409, 'period_id');
    if (judgement.faults.length > 0) throw new DomainError('IMPORT_HAS_ERRORS', 422, 'file', { extensions: { error_rows: new Set(judgement.faults.map((fault) => fault.line)).size } });
    const done = await this.imports.apply(scope.tx, batch, judgement, period, context);
    for (const draft of done.drafts) {
      await scope.audit({
        action: draft.action === 'CREATED' ? 'dis.report_created' : 'dis.report_import_updated',
        resourceType: REPORT_RESOURCE,
        resourceId: draft.id,
        diff: { project_code: draft.projectCode, period_code: period.code, source_kind: 'IMPORT', import_batch_id: batch.id, version: draft.version },
      });
    }
    await scope.audit({
      action: 'dis.report_import_applied',
      resourceType: IMPORT_RESOURCE,
      resourceId: id,
      diff: { period_code: period.code, file_sha256: batch.fileSha256, drafts_created: done.batch.draftsCreated, drafts_updated: done.batch.draftsUpdated, version: done.batch.version },
    });
    await scope.emit({
      aggregateType: IMPORT_RESOURCE,
      aggregateId: id,
      aggregateVersion: done.batch.version,
      type: 'report.import_applied.v1',
      schemaVersion: 1,
      payload: { tenant_id: scope.tenant.tenantId, actor_id: scope.tenant.membershipId, occurred_at: now.toISOString(), import_id: id, period_id: period.id, drafts_created: done.batch.draftsCreated, drafts_updated: done.batch.draftsUpdated },
      eventKey: `${IMPORT_RESOURCE}:${id}:applied`,
    });
    return commandResult(scope, done.batch.status, done.batch.version, id);
  }

  private async createNarrative(scope: CommandScope, access: EffectiveAccess, body: Schemas['DisImportRequest'], now: Date): Promise<CommandResult> {
    const period = await this.periods.find(scope.tx, body.period_id, 'share');
    if (period === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404, 'period_id');
    const reach = await periodAccess(scope.tx, this.periods, period.id, access, IMPORT_PERMISSION, now);
    const applied = await this.imports.appliedFor(scope.tx, period.id, body.file_sha256);
    if (applied !== undefined) throw new DomainError('IMPORT_FILE_ALREADY_APPLIED', 409, 'file_sha256', { extensions: { import_id: applied.id } });
    const bytes = await this.bytesOf(scope.tenant, body.file_object_key, body.file_sha256);
    const parsed = parseNarrativeImport(readTabularFile(bytes));
    const judgement = await this.narratives.judge(scope.tx, parsed, period.id, { scope: projectScope(reach, IMPORT_PERMISSION, now), actor: scope.tenant.membershipId, now });
    const batch = await this.imports.record(scope.tx, {
      periodId: period.id,
      fileObjectKey: body.file_object_key,
      fileSha256: body.file_sha256,
      mappingVersion: body.mapping_version,
      totalRows: parsed.totalRows,
      faults: judgement.faults,
      actor: scope.tenant.membershipId,
    });
    await scope.audit({
      action: 'dis.report_import_validated',
      resourceType: IMPORT_RESOURCE,
      resourceId: batch.id,
      diff: { period_code: period.code, file_sha256: batch.fileSha256, mapping_version: batch.mappingVersion, total_rows: batch.totalRows, valid_rows: batch.validRows, error_rows: batch.errorRows, status: batch.status },
    });
    return commandResult(scope, batch.status, batch.version, batch.id);
  }

  /** The apply of a file of narratives: the rows are judged again against the register as it is now, and only a file without a fault is written. */
  private async applyNarrative(scope: CommandScope, batch: ReportImportBatchRow, period: PeriodRow, reach: ReturnType<typeof projectScope>, bytes: Uint8Array, now: Date): Promise<CommandResult> {
    const context = { scope: reach, actor: scope.tenant.membershipId, now };
    const judgement = await this.narratives.judge(scope.tx, parseNarrativeImport(readTabularFile(bytes)), period.id, context);
    if (judgement.faults.some((fault) => fault.code === 'PERIOD_LOCKED')) throw new DomainError('PERIOD_LOCKED', 409, 'period_id');
    if (judgement.faults.length > 0) throw new DomainError('IMPORT_HAS_ERRORS', 422, 'file', { extensions: { error_rows: new Set(judgement.faults.map((fault) => fault.line)).size } });
    const done = await this.narratives.apply(scope.tx, batch, judgement, context);
    for (const draft of done.drafts) {
      await scope.audit({ action: 'dis.report_narrative_imported', resourceType: REPORT_RESOURCE, resourceId: draft.id, diff: { project_code: draft.projectCode, period_code: period.code, import_batch_id: batch.id, version: draft.version } });
    }
    await scope.audit({
      action: 'dis.report_import_applied',
      resourceType: IMPORT_RESOURCE,
      resourceId: batch.id,
      diff: { period_code: period.code, file_sha256: batch.fileSha256, mapping_version: batch.mappingVersion, drafts_created: done.batch.draftsCreated, drafts_updated: done.batch.draftsUpdated, version: done.batch.version },
    });
    await scope.emit({
      aggregateType: IMPORT_RESOURCE,
      aggregateId: batch.id,
      aggregateVersion: done.batch.version,
      type: 'report.import_applied.v1',
      schemaVersion: 1,
      payload: { tenant_id: scope.tenant.tenantId, actor_id: scope.tenant.membershipId, occurred_at: now.toISOString(), import_id: batch.id, period_id: period.id, drafts_created: done.batch.draftsCreated, drafts_updated: done.batch.draftsUpdated },
      eventKey: `${IMPORT_RESOURCE}:${batch.id}:applied`,
    });
    return commandResult(scope, done.batch.status, done.batch.version, batch.id);
  }

  @Get('report-imports/:id')
  @OperationId('getReportImport')
  async get(@CurrentTenant() tenant: TenantContext, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    return this.database.withTenant(tenant, async (tx) => {
      const found = await this.imports.find(tx, id);
      // A batch is its maker's alone: its faults name projects of the scope of that person.
      if (found === undefined || found.createdBy !== tenant.membershipId) throw new DomainError('RESOURCE_NOT_FOUND', 404);
      return importView(found);
    });
  }
}
