import { Body, Controller, Get, Header, HttpCode, Inject, Optional, Param, ParseUUIDPipe, Post, Query, StreamableFile } from '@nestjs/common';
import { BiDashboardStore, BiExportStore, BiMetricStore, TenantDatabase } from '@machvon/db';
import type { BiExportJobRow, BiScheduleRow } from '@machvon/db';
import { BI_EXPORT_LINK_SECONDS, BI_SCHEDULE_FORMATS, BI_SCHEDULE_MAX_RECIPIENTS, BI_SCHEDULE_TIMEZONE, DomainError, asUuid, knownTimeZone, objectKey, parseCron } from '@machvon/kernel';
import type { BiExportFormat, BiScheduleFormat, EffectiveAccess, TenantContext } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { encodeCursor, parsePageRequest } from '../../pagination';
import { Public } from '../../public.decorator';
import { CurrentTenant } from '../../tenant-context.decorator';
import { FileService } from '../files';
import { BiExportRunner, EXPORT_KIND, EXPORT_PERMISSION, holdsNow, parseExportSpec } from './export-runner';
import type { Outcome } from './export-runner';
import { BiQueryCache } from './query-cache';
import { BiQueryEngine, QUERY_PERMISSION } from './query-engine';
import { BI_CLOCK } from './tokens';

const JOB_RESOURCE = 'bi_export_job';
const SCHEDULE_RESOURCE = 'bi_export_schedule';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SIGNATURE = /^[0-9a-f]{64}$/;
const EXTENSION: Readonly<Record<BiExportFormat, string>> = { CSV: 'csv', XLSX: 'xlsx', PDF: 'pdf' };

export const jobView = (job: BiExportJobRow): Record<string, unknown> => ({
  id: job.id,
  requested_by: job.requestedBy,
  subject: { id: job.subjectUserId, name: job.subjectName },
  schedule_id: job.scheduleId,
  query_spec: job.querySpec,
  as_of_period: job.asOfPeriod,
  snapshot_id: job.datasetVersionId,
  scope_description: job.scopeDescription,
  format: job.format,
  row_count: job.rowCount,
  row_cap: job.rowCap,
  truncated: job.truncated,
  file_sha256: job.fileSha256,
  status: job.status,
  denied_reason: job.deniedReason,
  expires_at: job.expiresAt,
  created_at: job.createdAt,
  version: job.version,
});

export const scheduleView = (row: BiScheduleRow): Record<string, unknown> => ({
  id: row.id,
  dashboard_id: row.dashboardId,
  query_spec: row.querySpec,
  cron: row.cron,
  timezone: row.timezone,
  format: row.format,
  recipients: row.recipients,
  status: row.status,
  owner: { id: row.ownerUserId, name: row.ownerName },
  last_run_at: row.lastRunAt,
  created_at: row.createdAt,
  version: row.version,
});

/**
 * The exports of BI (ST-BI-008, BI 3 F7): a file of the figures of a metric over a frozen version, for the scope the person has now, with a header that says what the figures are. The right is judged when the export is asked
 * for, again when it runs, and again when the link to the file is given; a link lives five minutes and a file seven days. A larger answer than the cap is refused (422 `EXPORT_ROW_CAP_EXCEEDED`), never cut.
 */
@Controller()
export class BiExportController {
  private readonly jobs = new BiExportStore();
  private readonly engine = new BiQueryEngine(new BiQueryCache());
  private readonly runner: BiExportRunner;
  private readonly clock: () => Date;

  constructor(
    @Inject(TenantDatabase) private readonly database: TenantDatabase,
    @Inject(FileService) private readonly files: FileService,
    @Optional() @Inject(BI_CLOCK) clock?: () => Date,
  ) {
    this.runner = new BiExportRunner(this.engine, files);
    this.clock = clock ?? ((): Date => new Date());
  }

  @Post('bi/exports')
  @HttpCode(200)
  @OperationId('requestBiExport')
  @Command({ operation: 'requestBiExport' })
  async request(
    @Scope() scope: CommandScope,
    @CurrentAccess() access: EffectiveAccess,
    @Body() body: Schemas['BiExportRequest'],
  ): Promise<CommandResult & { row_count: number | null; expires_at: string | null }> {
    const actor = scope.tenant.membershipId;
    const spec = parseExportSpec(body.query_spec, body.as_of_period, body.snapshot_id);
    const outcome = await this.runner.run(scope.tx, scope.tenant, {
      subject: actor,
      access,
      requestedBy: actor,
      scheduleId: null,
      spec,
      format: body.format,
      now: this.clock(),
      lenient: false,
      querySpec: { ...(body.query_spec as Record<string, unknown>), as_of_period: body.as_of_period, ...(body.snapshot_id === undefined ? {} : { snapshot_id: body.snapshot_id }) },
    });
    // The file is stored outside the transaction: if the command does not commit (the audit, the answer kept for the key, the commit), the job is gone and the file must go with it.
    const stored = outcome.job.fileObjectKey;
    if (stored !== null) scope.afterRollback(async () => void (await this.files.remove(scope.tenant, stored)));
    await this.record(scope, outcome, true);
    if (outcome.kind === 'ENDED') {
      // A refusal that is a record: the job stays DENIED with the audit of it, and the answer is the refusal (the same key gets it again).
      scope.refuseAfterCommit(outcome.error);
      return { ...commandResult(scope, outcome.job.status, outcome.job.version, outcome.job.id), row_count: null, expires_at: null };
    }
    return { ...commandResult(scope, outcome.job.status, outcome.job.version, outcome.job.id), row_count: outcome.job.rowCount, expires_at: outcome.job.expiresAt };
  }

  /** What an export is told by, on the audit trail and as events. */
  private async record(scope: CommandScope, outcome: Outcome, requested: boolean): Promise<void> {
    const { job } = outcome;
    const detail = {
      metric_version_id: (job.querySpec as { metric_version_id?: unknown }).metric_version_id ?? null,
      as_of_period: job.asOfPeriod,
      snapshot_id: job.datasetVersionId,
      format: job.format,
      scope_hash: job.scopeHash,
    };
    await scope.audit({
      action: outcome.kind === 'READY' ? 'bi.export_request' : 'bi.export_denied',
      resourceType: JOB_RESOURCE,
      resourceId: job.id,
      classification: 'CONFIDENTIAL',
      diff: outcome.kind === 'READY' ? { ...detail, rows: job.rowCount, file_sha256: job.fileSha256 } : { ...detail, code: outcome.error.code },
    });
    const base = { aggregateType: JOB_RESOURCE, aggregateId: job.id, aggregateVersion: job.version, schemaVersion: 1 };
    const payload = {
      tenant_id: scope.tenant.tenantId,
      job_id: job.id,
      subject_user_id: job.subjectUserId,
      format: job.format,
      actor_id: scope.tenant.membershipId,
      occurred_at: new Date().toISOString(),
    };
    if (requested) await scope.emit({ ...base, type: 'bi.export.requested.v1', payload, eventKey: `${JOB_RESOURCE}:${job.id}:requested` });
    await scope.emit({
      ...base,
      type: outcome.kind === 'READY' ? 'bi.export.ready.v1' : 'bi.export.denied.v1',
      payload: outcome.kind === 'READY' ? payload : { ...payload, code: outcome.error.code },
      eventKey: `${JOB_RESOURCE}:${job.id}:${job.status}`,
    });
  }

  @Get('bi/exports')
  @OperationId('listBiExports')
  async list(
    @CurrentTenant() tenant: TenantContext,
    @Query('limit') limit?: unknown,
    @Query('cursor') cursor?: unknown,
  ): Promise<{ items: Array<Record<string, unknown>>; next_cursor: string | null }> {
    const request = parsePageRequest(limit, cursor);
    // The files of an export are the person's: they see the ones made for them.
    const page = await this.database.withTenant(tenant, (tx) =>
      this.jobs.listJobs(tx, tenant.membershipId, { limit: request.limit, after: request.after === undefined ? undefined : { at: request.after.code, id: request.after.id } }),
    );
    return { items: page.records.map(jobView), next_cursor: page.next === undefined ? null : encodeCursor({ code: page.next.at, id: page.next.id }) };
  }

  /**
   * One job, and the link to its file when the file is READY and the right is still the one it was made under: the person is judged again (the export and the query rights, and the scope they have now against the scope
   * of the file), so a person who lost the right, or whose scope changed, gets no link to data they may no longer read (403 `SCOPE_DENIED`). A job whose days are over is 422 `EXPORT_EXPIRED`.
   */
  @Get('bi/exports/:id')
  @OperationId('getBiExport')
  async get(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    const now = this.clock();
    const job = await this.database.withTenant(tenant, (tx) => this.jobs.findJob(tx, id.toLowerCase()));
    if (job === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    // A job of the tenant that is not the person's is theirs to know nothing of.
    if (job.subjectUserId !== tenant.membershipId && job.requestedBy !== tenant.membershipId) throw new DomainError('SCOPE_DENIED', 403);
    if (job.status === 'EXPIRED' || (job.status === 'READY' && job.expiresAt !== null && new Date(job.expiresAt) <= now)) throw new DomainError('EXPORT_EXPIRED', 422);
    if (job.status !== 'READY' || job.fileObjectKey === null) return jobView(job);
    const still = await this.database.withTenant(tenant, async (tx) => {
      if (job.subjectUserId !== tenant.membershipId || !holdsNow(access, EXPORT_PERMISSION, now) || !holdsNow(access, QUERY_PERMISSION, now)) return false;
      const spec = parseExportSpec(job.querySpec, job.asOfPeriod, job.datasetVersionId);
      // The file was made over the revision of the metric that was certified then: a newer revision that replaced it does not take the file away (it is read as a pinned revision).
      const reading = await this.engine.read(tx, tenant.membershipId, access, spec.metricId, job.datasetVersionId, now, true).catch((error: unknown) => {
        if (error instanceof DomainError) return undefined;
        throw error;
      });
      // The scope of the file is the one the person has now: their grants and the policies over the dataset (a policy that was replaced or tightened changes it).
      return reading?.value !== undefined && (await this.engine.exportScopeHash(tx, tenant.membershipId, access, reading.value.version.datasetId, now)) === job.scopeHash;
    });
    if (!still) throw new DomainError('SCOPE_DENIED', 403);
    const grant = await this.files.presignDownload(tenant, job.fileObjectKey, BI_EXPORT_LINK_SECONDS);
    const query = new URLSearchParams({ tenant: tenant.tenantId, expires: String(grant.expires), signature: grant.signature });
    return { ...jobView(job), download: { url: `/bi/exports/${job.id}/file?${query.toString()}`, expires_at: new Date(grant.expires * 1000).toISOString() } };
  }

  /** The signed link of the download: the bytes while the signature is good and the time has not run out, and nothing else (a forged, altered, expired or foreign link all answer 401 `SIGNATURE_INVALID`). */
  @Public()
  @Header('Cache-Control', 'private, no-store')
  @Get('bi/exports/:id/file')
  async file(@Param('id', ParseUUIDPipe) id: string, @Query('tenant') tenantId: unknown, @Query('expires') expires: unknown, @Query('signature') signature: unknown): Promise<StreamableFile> {
    const invalid = (): DomainError => new DomainError('SIGNATURE_INVALID', 401);
    if (typeof tenantId !== 'string' || typeof expires !== 'string' || typeof signature !== 'string' || !UUID.test(tenantId) || !SIGNATURE.test(signature) || !/^[0-9]{1,12}$/.test(expires))
      throw invalid();
    const key = objectKey(tenantId, EXPORT_KIND, id.toLowerCase());
    const { object, bytes } = await this.files.redeemDownload({ method: 'GET', key, expires: Number(expires), signature }).catch((error: unknown) => {
      throw error instanceof DomainError ? error : invalid();
    });
    const format = (object.contentType === 'application/pdf' ? 'PDF' : object.contentType === 'text/csv' ? 'CSV' : 'XLSX') as BiExportFormat;
    return new StreamableFile(bytes, { type: object.contentType, disposition: `attachment; filename="bi-export-${id}.${EXTENSION[format]}"`, length: bytes.length });
  }
}

/**
 * The schedules of the exports (ST-BI-008, BI 3 F7): a cron, a format and the people who receive it. Each run makes one job for each recipient, under the scope of that recipient as it is then; a recipient who lost the right
 * gets a DENIED job and no file. A recipient is a member of the tenant (422 `RECIPIENT_OUT_OF_TENANT`), the cron is one of five fields (409 `CRON_INVALID`).
 */
@Controller()
export class BiExportScheduleController {
  private readonly schedules = new BiExportStore();
  private readonly metrics = new BiMetricStore();
  private readonly dashboards = new BiDashboardStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Post('bi/export-schedules')
  @HttpCode(200)
  @OperationId('createBiExportSchedule')
  @Command({ operation: 'createBiExportSchedule' })
  async create(@Scope() scope: CommandScope, @Body() body: Schemas['BiScheduleCreate']): Promise<CommandResult> {
    const actor = scope.tenant.membershipId;
    const spec = parseExportSpec(body.query_spec, undefined, undefined);
    const format = body.format as BiScheduleFormat;
    if (!BI_SCHEDULE_FORMATS.includes(format)) throw new DomainError('VALIDATION_FAILED', 422, 'format');
    parseCron(body.cron);
    if (!knownTimeZone(BI_SCHEDULE_TIMEZONE)) throw new DomainError('VALIDATION_FAILED', 422, 'timezone');
    const recipients = [...new Set(body.recipients.map((id) => asUuid(id)))];
    if (recipients.some((id) => id === undefined) || recipients.length === 0 || recipients.length > BI_SCHEDULE_MAX_RECIPIENTS) throw new DomainError('VALIDATION_FAILED', 422, 'recipients');
    const known = new Set(await this.schedules.activeMembers(scope.tx, recipients as string[]));
    if ((recipients as string[]).some((id) => !known.has(id))) throw new DomainError('RECIPIENT_OUT_OF_TENANT', 422, 'recipients');
    const metric = await this.metrics.find(scope.tx, spec.metricId);
    if (metric === undefined) throw new DomainError('VALIDATION_FAILED', 422, 'query_spec.metric_version_id');
    if (metric.status !== 'CERTIFIED') throw new DomainError('METRIC_NOT_CERTIFIED', 422, 'query_spec.metric_version_id');
    const dashboardId = body.dashboard_id === undefined ? null : asUuid(body.dashboard_id);
    if (body.dashboard_id !== undefined && (dashboardId === undefined || (await this.dashboards.find(scope.tx, dashboardId as string, actor)) === undefined))
      throw new DomainError('VALIDATION_FAILED', 422, 'dashboard_id');
    const created = await this.schedules.createSchedule(scope.tx, {
      dashboardId: dashboardId ?? null,
      querySpec: body.query_spec as Record<string, unknown>,
      cron: body.cron.trim(),
      timezone: BI_SCHEDULE_TIMEZONE,
      format,
      recipients: recipients as string[],
      owner: actor,
    });
    await scope.audit({
      action: 'bi.export_schedule.create',
      resourceType: SCHEDULE_RESOURCE,
      resourceId: created.id,
      diff: { cron: created.cron, format: created.format, recipients: created.recipients.length, dashboard_id: created.dashboardId },
    });
    await scope.emit({
      aggregateType: SCHEDULE_RESOURCE,
      aggregateId: created.id,
      aggregateVersion: created.version,
      type: 'bi.export_schedule.created.v1',
      schemaVersion: 1,
      payload: {
        tenant_id: scope.tenant.tenantId,
        schedule_id: created.id,
        cron: created.cron,
        format: created.format,
        recipients: created.recipients.length,
        actor_id: actor,
        occurred_at: new Date().toISOString(),
      },
      eventKey: `${SCHEDULE_RESOURCE}:${created.id}:${created.version}`,
    });
    return commandResult(scope, created.status, created.version, created.id);
  }

  @Get('bi/export-schedules')
  @OperationId('listBiExportSchedules')
  async list(
    @CurrentTenant() tenant: TenantContext,
    @Query('limit') limit?: unknown,
    @Query('cursor') cursor?: unknown,
  ): Promise<{ items: Array<Record<string, unknown>>; next_cursor: string | null }> {
    const request = parsePageRequest(limit, cursor);
    // The schedules are the owner's.
    const page = await this.database.withTenant(tenant, (tx) =>
      this.schedules.listSchedules(tx, tenant.membershipId, { limit: request.limit, after: request.after === undefined ? undefined : { at: request.after.code, id: request.after.id } }),
    );
    return { items: page.records.map(scheduleView), next_cursor: page.next === undefined ? null : encodeCursor({ code: page.next.at, id: page.next.id }) };
  }
}
