import { createHash, randomUUID } from 'node:crypto';
import { Body, Controller, Get, Header, HttpCode, Inject, Optional, Param, ParseUUIDPipe, Post, Query, StreamableFile } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { AuditWriter, DisExportStore, DisPeriodStore, DisSnapshotStore, EXPORT_ACTION, EXPORT_RESOURCE_TYPE, TenantDatabase, projectScope } from '@machvon/db';
import {
  DomainError,
  EXPORT_PROJECT_CAP,
  EXPORT_ROW_CAP,
  NOOP_METRICS,
  PDF_ROW_CAP,
  UPLOAD_PURPOSES,
  assertLinkable,
  buildExportDocument,
  csvOf,
  objectKey,
  parseObjectKey,
  selectColumns,
  xlsxOf,
} from '@machvon/kernel';
import type { EffectiveAccess, ExportFormat, MetricsSink, TenantContext, UnitScale } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { periodAccess } from './period-gate';
import { OperationId } from '../../operation-id.decorator';
import { Public } from '../../public.decorator';
import { CurrentTenant } from '../../tenant-context.decorator';
import { FileService } from '../files';
import { DOCX_MEDIA_TYPE, docxOf } from '../reports';
import { pdfOf } from './export-pdf';
import { DIS_CLOCK, DIS_METRICS } from './tokens';

const EXPORT_PERMISSION = PERMISSIONS.createReportExport;
export const REPORT_EXPORT_METRIC = 'dis_report_export_total';
export const REPORT_EXPORT_DOWNLOAD_METRIC = 'dis_report_export_download_total';
const FORMATS: readonly ExportFormat[] = ['CSV', 'XLSX', 'PDF', 'DOCX'];
const SCALES: readonly UnitScale[] = ['VND', 'MILLION_VND'];
const MEDIA_TYPE: Readonly<Record<ExportFormat, string>> = {
  CSV: 'text/csv',
  XLSX: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  PDF: 'application/pdf',
  DOCX: DOCX_MEDIA_TYPE,
};
const EXTENSION: Readonly<Record<ExportFormat, string>> = { CSV: 'csv', XLSX: 'xlsx', PDF: 'pdf', DOCX: 'docx' };
/** The kernel caps a signed link at five minutes; a new one is issued each time the download is asked for, and the permission is judged each time. */
const LINK_TTL_SECONDS = 300;
const SIGNATURE = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The export of a frozen snapshot (ST-DIS-016, DIS 3 F9, DIS-17). Making the file judges the caller's scope as it is now (only the lines of the projects they may see), refuses a snapshot that is not frozen
 * (422 SNAPSHOT_NOT_FROZEN) and a file above the caps (422 EXPORT_ROW_CAP_EXCEEDED), writes it to the object store of the tenant as a clean file and keeps the record in the audit trail. Asking for the
 * download judges the scope again: if the caller no longer sees every project the file names, the answer is 403 SCOPE_DENIED and no link is issued, so that a number cannot outlive the right to see it
 * (NFR-TENANCY-06). The link is signed and short-lived; a file belongs to the person who made it.
 */
@Controller()
export class ReportExportController {
  private readonly snapshots = new DisSnapshotStore();
  private readonly periods = new DisPeriodStore();
  private readonly exports = new DisExportStore();
  private readonly audit: AuditWriter;
  private readonly metrics: MetricsSink;
  private readonly clock: () => Date;

  constructor(
    @Inject(TenantDatabase) private readonly database: TenantDatabase,
    @Inject(FileService) private readonly files: FileService,
    @Optional() @Inject(DIS_METRICS) metrics?: MetricsSink,
    @Optional() @Inject(DIS_CLOCK) clock?: () => Date,
  ) {
    this.audit = new AuditWriter(database);
    this.metrics = metrics ?? NOOP_METRICS;
    this.clock = clock ?? ((): Date => new Date());
  }

  @Post('report-exports')
  @HttpCode(200)
  @OperationId('createReportExport')
  @Command({ operation: 'createReportExport' })
  async create(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['DisExportRequest']): Promise<CommandResult> {
    const now = this.clock();
    const format = body.format as ExportFormat;
    if (!FORMATS.includes(format)) throw new DomainError('VALIDATION_FAILED', 422, 'format');
    const unitScale = (body.unit_scale ?? 'VND') as UnitScale;
    if (!SCALES.includes(unitScale)) throw new DomainError('VALIDATION_FAILED', 422, 'unit_scale');
    selectColumns(body.columns);
    const snapshot = await this.snapshots.find(scope.tx, body.snapshot_id);
    if (snapshot === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404, 'snapshot_id');
    if (snapshot.status !== 'FROZEN') throw new DomainError('SNAPSHOT_NOT_FROZEN', 422, 'snapshot_id');
    const period = await this.periods.find(scope.tx, snapshot.periodId);
    if (period === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404, 'snapshot_id');
    const reach = await periodAccess(scope.tx, this.periods, period.id, access, EXPORT_PERMISSION, now);
    // A page of Word weighs like a page of PDF: the same cap.
    const cap = format === 'PDF' || format === 'DOCX' ? PDF_ROW_CAP : EXPORT_ROW_CAP;
    const read = await this.exports.lines(scope.tx, projectScope(reach, EXPORT_PERMISSION, now), snapshot.id, cap);
    if (read.overflow || read.projectIds.length > EXPORT_PROJECT_CAP) throw new DomainError('EXPORT_ROW_CAP_EXCEEDED', 422, 'snapshot_id', { extensions: { row_cap: cap } });
    // Nothing of the snapshot is in the scope of the caller: there is no file to make.
    if (read.lines.length === 0) throw new DomainError('SCOPE_DENIED', 403);
    const document = buildExportDocument({
      snapshotId: snapshot.id,
      periodCode: period.code,
      snapshotKind: snapshot.snapshotKind,
      asOfDate: snapshot.asOfDate,
      treasuryCutoffDate: snapshot.treasuryCutoffDate,
      definitionStatus: snapshot.definitionStatus,
      createdAt: now,
      unitCodes: read.unitCodes,
      lines: read.lines,
      columns: body.columns,
      unitScale,
    });
    const bytes: Uint8Array = format === 'CSV' ? new Uint8Array(Buffer.from(csvOf(document), 'utf8')) : format === 'XLSX' ? xlsxOf(document) : format === 'DOCX' ? await docxOf(document) : await pdfOf(document);
    const stored = await this.files.upload(scope.tenant, { purpose: 'report_export', declaredType: MEDIA_TYPE[format], bytes });
    // Only a file the antivirus has passed is ever offered (SCAN_PENDING, FILE_NOT_CLEAN).
    assertLinkable(stored.scanStatus);
    const exportId = parseObjectKey(stored.key)?.id;
    if (exportId === undefined) throw new Error('the object store returned a key that is not a tenant key');
    await scope.audit({
      action: EXPORT_ACTION,
      resourceType: EXPORT_RESOURCE_TYPE,
      resourceId: exportId,
      classification: 'CONFIDENTIAL',
      diff: {
        snapshot_id: snapshot.id,
        period_code: period.code,
        format,
        rows: read.lines.length,
        project_ids: read.projectIds,
        unit_codes: read.unitCodes,
        columns: body.columns ?? null,
        unit_scale: unitScale,
        definition_status: snapshot.definitionStatus,
        max_bytes: UPLOAD_PURPOSES.report_export.maxBytes,
        size_bytes: bytes.length,
        file_sha256: createHash('sha256').update(bytes).digest('hex'),
      },
    });
    scope.afterCommit(() => this.metrics.increment(REPORT_EXPORT_METRIC, { format, definition_status: snapshot.definitionStatus }));
    return commandResult(scope, 'READY', 1, exportId);
  }

  @Get('report-exports/:id/download')
  @OperationId('getReportExportDownload')
  async download(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    const now = this.clock();
    const scope = projectScope(access, EXPORT_PERMISSION, now);
    const checked = await this.database.withTenant(tenant, async (tx) => {
      const record = await this.exports.recordOf(tx, id);
      // A file of another person, or of no one, looks the same: not found.
      if (record === undefined || record.actorId !== tenant.membershipId) throw new DomainError('RESOURCE_NOT_FOUND', 404);
      const visible = await this.exports.visibleProjects(tx, scope, record.snapshotId, record.projectIds);
      return { record, allowed: visible >= record.projectIds.length };
    });
    const entry = { resourceType: EXPORT_RESOURCE_TYPE, resourceId: id, correlationId: randomUUID(), requestId: randomUUID(), classification: 'CONFIDENTIAL' as const };
    if (!checked.allowed) {
      // The scope has narrowed since the file was made: the link is not issued, and the refusal is a record.
      await this.audit.recordDenied(tenant, { ...entry, action: 'dis.report_export_download', diff: { reason: 'SCOPE_NARROWED', snapshot_id: checked.record.snapshotId } });
      this.metrics.increment(REPORT_EXPORT_DOWNLOAD_METRIC, { outcome: 'denied' });
      throw new DomainError('SCOPE_DENIED', 403);
    }
    const grant = await this.files.presignDownload(tenant, objectKey(tenant.tenantId, 'report_export', id), LINK_TTL_SECONDS);
    const expiresAt = new Date(grant.expires * 1000);
    await this.database.withTenant(tenant, (tx) =>
      this.audit.recordInTx(tx, tenant.membershipId, { ...entry, action: 'dis.report_export_download', diff: { snapshot_id: checked.record.snapshotId, expires_at: expiresAt.toISOString() } }),
    );
    this.metrics.increment(REPORT_EXPORT_DOWNLOAD_METRIC, { outcome: 'issued' });
    const query = new URLSearchParams({ tenant: tenant.tenantId, expires: String(grant.expires), signature: grant.signature });
    return {
      export_id: id,
      url: `/report-exports/${id}/file?${query.toString()}`,
      expires_at: expiresAt.toISOString(),
      format: checked.record.format,
      rows: checked.record.rows,
      file_sha256: checked.record.fileSha256,
    };
  }

  /**
   * The signed link of the download: it serves the bytes while the signature is good and the time has not run out, and nothing else (a forged, altered, expired or foreign link all answer the same 401
   * SIGNATURE_INVALID). It names no person: the permission was judged when the link was issued.
   */
  @Public()
  @Header('Cache-Control', 'private, no-store')
  @Get('report-exports/:id/file')
  async file(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('tenant') tenantId: unknown,
    @Query('expires') expires: unknown,
    @Query('signature') signature: unknown,
  ): Promise<StreamableFile> {
    const invalid = (): DomainError => new DomainError('SIGNATURE_INVALID', 401);
    if (typeof tenantId !== 'string' || typeof expires !== 'string' || typeof signature !== 'string' || !UUID.test(tenantId) || !SIGNATURE.test(signature) || !/^[0-9]{1,12}$/.test(expires)) throw invalid();
    const key = objectKey(tenantId, 'report_export', id);
    const { object, bytes } = await this.files.redeemDownload({ method: 'GET', key, expires: Number(expires), signature }).catch((error: unknown) => {
      throw error instanceof DomainError ? error : invalid();
    });
    const format = (Object.entries(MEDIA_TYPE).find(([, type]) => type === object.contentType)?.[0] ?? 'CSV') as ExportFormat;
    return new StreamableFile(bytes, { type: object.contentType, disposition: `attachment; filename="report-export-${id}.${EXTENSION[format]}"`, length: bytes.length });
  }
}
