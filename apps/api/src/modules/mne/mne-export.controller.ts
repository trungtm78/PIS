import { createHash, randomUUID } from 'node:crypto';
import { Body, Controller, Get, Header, HttpCode, Inject, Optional, Param, ParseUUIDPipe, Post, Query, StreamableFile } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { AuditWriter, MNE_PACKAGE_RESOURCE, MNE_REPORT_RESOURCE, MNE_UNIT_COLUMNS, MneExportStore, MneReportStore, TenantDatabase, WORKER_MEMBERSHIP_ID, scopePredicate } from '@machvon/db';
import type { MnePackageRow, MneReportRow, ScopeBuilder } from '@machvon/db';
import {
  DomainError,
  MNE_EXPORT_TARGETS,
  NOOP_METRICS,
  assertExportable,
  assertLinkable,
  checkedFormats,
  csvOf,
  exportWatermark,
  filedLate,
  mneExportDocument,
  objectKey,
  parseObjectKey,
  versionConflict,
  vietnamDateOf,
  xlsxOf,
} from '@machvon/kernel';
import type { EffectiveAccess, MetricsSink, MneExportFormat, MneExportTarget } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { Public } from '../../public.decorator';
import { pdfOf } from '../dis/export-pdf';
import { FileService } from '../files';
import { packageDiffOf, reportDiffOf } from './mne-views';
import { MNE_METRICS } from './tokens';

export const MNE_EXPORT_METRIC = 'mne_export_package_total';
const MEDIA_TYPE: Readonly<Record<string, string>> = {
  CSV: 'text/csv',
  XLSX: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  PDF: 'application/pdf',
};
const EXTENSION: Readonly<Record<string, string>> = { CSV: 'csv', XLSX: 'xlsx', PDF: 'pdf' };
/** The kernel caps a signed link at five minutes; a new one is issued each time the report is read, and the right to export is judged each time. */
export const MNE_LINK_TTL_SECONDS = 300;
const SIGNATURE = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The units a permission reaches, compiled over the unit columns of the report queries. */
const unitScope =
  (access: EffectiveAccess, permission: string, now: Date): ScopeBuilder =>
  (first) =>
    scopePredicate(access, permission, now, MNE_UNIT_COLUMNS, first);

const sourceText = (report: MneReportRow, key: string): string => {
  const field = report.schema.fields.find((candidate) => candidate.key === key);
  if (field?.source === null || field === undefined) return '';
  const source = field.source;
  const detail = source.kind === 'SNAPSHOT_METRIC' ? source.metric : source.kind === 'PROJECT_COUNT' ? (source.stage ?? '') : source.kind === 'WARNING_COUNT' ? (source.severity ?? '') : String(source.planYear);
  return detail === '' ? source.kind : `${source.kind}: ${detail}`;
};

/**
 * The files of an issued monitoring report and the receipt of their filing by hand (ST-MNE-004, MNE 3.1 F3, BR-MNE-05, CXN-05). `generateMneExportPackage` makes one file per format asked for (XLSX, PDF, CSV; the
 * XML of the national system has no specification yet and is refused), puts it in the object store of the tenant after the antivirus has passed it, and keeps one package per (report, target, format, content):
 * the same content asked for again is the same package. It labels the way to the target with the adapter status of its connector and calls nothing. `recordMneSubmissionReceipt` writes down the receipt reference
 * and the day of the filing; the report is then SUBMITTED_EXTERNAL, late or not by the day against its due date. The files are offered by a short-lived signed link that the report read issues to who may export.
 */
@Controller()
export class MneExportController {
  private readonly reports = new MneReportStore();
  private readonly packages = new MneExportStore();
  private readonly audit: AuditWriter;
  private readonly metrics: MetricsSink;

  constructor(
    @Inject(TenantDatabase) private readonly database: TenantDatabase,
    @Optional() @Inject(FileService) private readonly files?: FileService,
    @Optional() @Inject(MNE_METRICS) metrics?: MetricsSink,
  ) {
    this.audit = new AuditWriter(database);
    this.metrics = metrics ?? NOOP_METRICS;
  }

  @Post('mne-reports/:id/export-packages')
  @HttpCode(200)
  @OperationId('generateMneExportPackage')
  @Command({ operation: 'generateMneExportPackage', versioned: true })
  async generate(
    @Scope() scope: CommandScope,
    @CurrentAccess() access: EffectiveAccess,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: Schemas['MneExportRequest'],
  ): Promise<CommandResult & { packages: Array<Record<string, unknown>> }> {
    const files = this.files;
    if (files === undefined) throw new DomainError('PROVIDER_UNAVAILABLE', 503, 'document_file_store');
    const now = new Date();
    const target = body.target_system as MneExportTarget;
    if (!MNE_EXPORT_TARGETS.includes(target)) throw new DomainError('VALIDATION_FAILED', 422, 'target_system');
    const report = await this.reports.lock(scope.tx, id.toLowerCase());
    await this.reports.assertUnitInScope(scope.tx, report.scopeUnitId, unitScope(access, PERMISSIONS.generateMneExportPackage, now));
    if (report.version !== (scope.expectedVersion ?? 0)) throw versionConflict(report.version);
    assertExportable(report);
    const formats = checkedFormats(body.formats, report.formExportFormats);
    const adapterStatus = await this.packages.adapterStatusOf(scope.tx, target);
    const document = mneExportDocument({
      formCode: report.formCode,
      formRevision: report.formRevision,
      formTitle: report.formTitle,
      periodLabel: report.periodLabel,
      unitCode: report.unitCode,
      unitName: report.unitName,
      dueDate: report.dueDate,
      asOfDate: typeof report.payload.meta.as_of_date === 'string' ? report.payload.meta.as_of_date : null,
      payloadSha256: report.payloadSha256,
      documentId: report.docDocumentId,
      watermark: exportWatermark({ legalConfirmationRef: report.formLegalConfirmationRef, watermarkText: report.watermarkText }),
      cells: report.schema.fields.map((field) => {
        const value = field.source === null ? report.payload.narrative[field.key] : report.payload.values[field.key];
        return { label: field.label, kind: field.kind, value: typeof value === 'string' || typeof value === 'number' ? value : null, source: sourceText(report, field.key) };
      }),
    });
    // The files carry the day the report was issued, not the day they were made: the same content is the same file.
    const stamp = new Date(report.issuedAt ?? now.toISOString());
    const made: Array<{ row: MnePackageRow; created: boolean }> = [];
    for (const format of formats) {
      const bytes = await this.bytesOf(document, format, stamp);
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      const existing = await this.packages.findByHash(scope.tx, report.id, target, format, sha256);
      if (existing !== undefined) {
        made.push({ row: existing, created: false });
        continue;
      }
      const stored = await files.upload(scope.tenant, { purpose: 'report_export', declaredType: MEDIA_TYPE[format] as string, bytes });
      // Only a file the antivirus has passed is ever offered (SCAN_PENDING, FILE_NOT_CLEAN).
      assertLinkable(stored.scanStatus);
      const packageId = parseObjectKey(stored.key)?.id;
      if (packageId === undefined) throw new Error('the object store returned a key that is not a tenant key');
      made.push(await this.packages.ensure(scope.tx, { id: packageId, reportId: report.id, targetSystem: target, format, objectKey: stored.key, fileSha256: sha256, fileSizeBytes: bytes.length, adapterStatus, actor: scope.tenant.membershipId }));
    }
    const version = await this.reports.markExported(scope.tx, report.id, scope.tenant.membershipId);
    for (const { row } of made.filter((entry) => entry.created)) {
      await scope.audit({
        action: 'mne.package_generated',
        resourceType: MNE_PACKAGE_RESOURCE,
        resourceId: row.id,
        diff: { ...packageDiffOf(row), report_id: report.id, form_code: report.formCode, period_label: report.periodLabel, size_bytes: row.fileSizeBytes },
      });
    }
    // The request is a record whether or not it made a file: what was asked, and how many files are new.
    await scope.audit({ action: 'mne.export_requested', resourceType: MNE_REPORT_RESOURCE, resourceId: report.id, diff: { ...reportDiffOf(report), target_system: target, formats, created: made.filter((entry) => entry.created).length, existing: made.filter((entry) => !entry.created).length } });
    if (report.status === 'ISSUED') await scope.audit({ action: 'mne.report.exported', resourceType: MNE_REPORT_RESOURCE, resourceId: report.id, diff: { ...reportDiffOf({ ...report, status: 'EXPORTED' }), from_status: 'ISSUED', target_system: target } });
    scope.afterCommit(() => made.filter((entry) => entry.created).forEach((entry) => this.metrics.increment(MNE_EXPORT_METRIC, { format: entry.row.format, adapter_status: entry.row.adapterStatus })));
    return { ...commandResult(scope, 'EXPORTED', version, report.id), packages: made.map((entry) => ({ ...packageDiffOf(entry.row), id: entry.row.id, created: entry.created })) };
  }

  @Post('mne-export-packages/:id/submission-receipt')
  @HttpCode(200)
  @OperationId('recordMneSubmissionReceipt')
  @Command({ operation: 'recordMneSubmissionReceipt', versioned: true })
  async receipt(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['MneReceipt']): Promise<CommandResult> {
    const now = new Date();
    const found = await this.packages.find(scope.tx, id.toLowerCase());
    if (found === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const report = await this.reports.lock(scope.tx, found.reportId);
    await this.reports.assertUnitInScope(scope.tx, report.scopeUnitId, unitScope(access, PERMISSIONS.recordMneSubmissionReceipt, now));
    assertExportable(report);
    const done = await this.packages.recordReceipt(scope.tx, {
      id: found.id,
      expectedVersion: scope.expectedVersion ?? 0,
      reference: body.receipt_reference,
      submittedAt: body.submitted_at,
      receiptDocumentId: body.receipt_document_id,
      actor: scope.tenant.membershipId,
      now,
    });
    const late = filedLate(report.dueDate, done.row.submittedAt ?? now.toISOString());
    await this.reports.markFiled(scope.tx, report.id, late, scope.tenant.membershipId);
    await scope.audit({
      action: 'mne.package_filed',
      resourceType: MNE_PACKAGE_RESOURCE,
      resourceId: done.row.id,
      diff: { ...packageDiffOf(done.row), report_id: report.id, form_code: report.formCode, period_label: report.periodLabel, from_status: done.previousStatus, is_late: late, due_date: report.dueDate, filed_on: vietnamDateOf(new Date(done.row.submittedAt ?? now.toISOString())) },
    });
    return commandResult(scope, done.row.status, done.row.version, done.row.id);
  }

  /**
   * The signed link of the download: it serves the bytes while the signature is good and the time has not run out, and nothing else (a forged, altered, expired or foreign link all answer the same 401
   * SIGNATURE_INVALID). It names no person: the right to export was judged when the link was issued. The first time a package is served it is DOWNLOADED, in the trail.
   */
  @Public()
  @Header('Cache-Control', 'private, no-store')
  @Get('mne-export-packages/:id/file')
  async file(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('tenant') tenantId: unknown,
    @Query('expires') expires: unknown,
    @Query('signature') signature: unknown,
  ): Promise<StreamableFile> {
    const invalid = (): DomainError => new DomainError('SIGNATURE_INVALID', 401);
    const files = this.files;
    if (files === undefined) throw new DomainError('PROVIDER_UNAVAILABLE', 503, 'document_file_store');
    if (typeof tenantId !== 'string' || typeof expires !== 'string' || typeof signature !== 'string' || !UUID.test(tenantId) || !SIGNATURE.test(signature) || !/^[0-9]{1,12}$/.test(expires)) throw invalid();
    const key = objectKey(tenantId, 'report_export', id);
    const { object, bytes } = await files.redeemDownload({ method: 'GET', key, expires: Number(expires), signature }).catch((error: unknown) => {
      throw error instanceof DomainError ? error : invalid();
    });
    const format = Object.entries(MEDIA_TYPE).find(([, type]) => type === object.contentType)?.[0] ?? 'CSV';
    await this.noteDownload(tenantId, id);
    return new StreamableFile(bytes, { type: object.contentType, disposition: `attachment; filename="mne-package-${id}.${EXTENSION[format] as string}"`, length: bytes.length });
  }

  private async noteDownload(tenantId: string, id: string): Promise<void> {
    const worker = { tenantId, membershipId: WORKER_MEMBERSHIP_ID, scopeVersion: 0 };
    try {
      await this.database.withTenant(worker, async (tx) => {
        const before = await this.packages.find(tx, id);
        if (before === undefined || before.status !== 'GENERATED') return;
        const { row, changed } = await this.packages.markDownloaded(tx, id, new Date(), WORKER_MEMBERSHIP_ID);
        // Two people who download at once are one first download: only the call that moved the package says so.
        if (!changed) return;
        await this.audit.recordInTx(tx, WORKER_MEMBERSHIP_ID, {
          action: 'mne.package_downloaded',
          resourceType: MNE_PACKAGE_RESOURCE,
          resourceId: id,
          diff: { ...packageDiffOf(row), report_id: row.reportId },
          correlationId: randomUUID(),
          requestId: randomUUID(),
        });
      });
    } catch {
      // The record of a download is never worth refusing the file for a person who holds a good link.
    }
  }

  private async bytesOf(document: ReturnType<typeof mneExportDocument>, format: MneExportFormat, stamp: Date): Promise<Uint8Array> {
    if (format === 'CSV') return new Uint8Array(Buffer.from(csvOf(document), 'utf8'));
    if (format === 'XLSX') return xlsxOf(document);
    // The cells hold the words of the report: they are written out in full, over as many lines and pages as they need.
    return pdfOf(document, { stamp, wrap: true });
  }
}
