import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { BidWorkflowReads, ReportStore, TenantDatabase } from '@machvon/db';
import { DomainError } from '@machvon/kernel';
import type { EffectiveAccess, TenantContext } from '@machvon/kernel';
import { ReportMailStore, scheduleRequestOf } from '@machvon/edition-enterprise/src/server.ts';
import type { MailScheduleRow, MailingRow } from '@machvon/edition-enterprise/src/server.ts';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { CurrentTenant } from '../../tenant-context.decorator';
import { holdsOnWholeTenant } from '../../modules/adm/tenant-authority';
import { layoutReadable } from '../../modules/reports/form-registry';

export const MAIL_MANAGE = 'rpt.mail.manage';
export const MAIL_READ = 'rpt.mail.read';
/** The right the issued copies are read under: a recipient needs it, since the message carries the file. */
export const REPORT_READ = 'rpt.read';
const RESOURCE = 'report_mail_schedule';
const MAX_LIST = 200;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const people = new BidWorkflowReads();

function limitOf(value: unknown): number {
  if (value === undefined) return 50;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > MAX_LIST) throw new DomainError('VALIDATION_FAILED', 422, 'limit');
  return n;
}

function text(value: unknown, field: string, max = 100): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value === '' || value.length > max) throw new DomainError('VALIDATION_FAILED', 422, field);
  return value;
}

function uuidOf(value: unknown, field: string): string | undefined {
  const v = text(value, field, 36);
  if (v !== undefined && !UUID.test(v)) throw new DomainError('VALIDATION_FAILED', 422, field);
  return v;
}

const scheduleDto = (row: MailScheduleRow, names: Map<string, string>): Record<string, unknown> => ({
  id: row.id,
  layout_code: row.layoutCode,
  cron: row.cron,
  timezone: row.timezone,
  format: row.format,
  recipient_ids: row.recipients,
  recipient_count: row.recipients.length,
  note: row.note,
  status: row.status,
  last_run_at: row.lastRunAt,
  retired_at: row.retiredAt,
  retire_reason: row.retireReason,
  created_by: row.createdBy,
  created_by_name: names.get(row.createdBy) ?? null,
  created_at: row.createdAt,
  version: row.version,
});

const mailingDto = (row: MailingRow): Record<string, unknown> => ({
  id: row.id,
  schedule_id: row.scheduleId,
  issue_id: row.issueId,
  recipient_id: row.recipientId,
  channel: 'EMAIL',
  file_format: row.fileFormat,
  file_name: row.fileName,
  file_sha256: row.fileSha256,
  status: row.status,
  attempts: row.attempts,
  error_code: row.errorCode,
  sent_at: row.sentAt,
  last_attempt_at: row.lastAttemptAt,
  created_at: row.createdAt,
});

/** The reads of the e-mail schedules of issued report forms and of their log (ENT-4d, RML-01). Over the whole tenant, as the issued copies are; a form the reader may not read is not listed. */
@Controller()
export class ReportMailReadsController {
  private readonly store = new ReportMailStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get('report-engine/mail-schedules')
  @OperationId('listReportMailSchedules')
  async schedules(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Query() query: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!holdsOnWholeTenant(access, MAIL_READ)) throw new DomainError('SCOPE_DENIED', 403);
    const now = new Date();
    const status = text(query.status, 'status', 10);
    if (status !== undefined && status !== 'ACTIVE' && status !== 'RETIRED') throw new DomainError('VALIDATION_FAILED', 422, 'status');
    const limit = limitOf(query.limit);
    return this.database.withTenant(tenant, async (tx) => {
      const rows = (await this.store.listSchedules(tx, { status, layoutCode: text(query.layout_code, 'layout_code', 80) }, limit + 1)).filter((row) => layoutReadable(access, row.layoutCode));
      const shown = rows.slice(0, limit);
      const names = await people.names(tx, shown.map((row) => row.createdBy));
      return { items: shown.map((row) => scheduleDto(row, names)), truncated: rows.length > limit, may_manage: holdsOnWholeTenant(access, MAIL_MANAGE), as_of: now.toISOString() };
    });
  }

  @Get('report-engine/mailings')
  @OperationId('listReportMailings')
  async mailings(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Query() query: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!holdsOnWholeTenant(access, MAIL_READ)) throw new DomainError('SCOPE_DENIED', 403);
    const now = new Date();
    const status = text(query.status, 'status', 10);
    if (status !== undefined && !['SENDING', 'SENT', 'FAILED', 'REFUSED', 'UNKNOWN', 'SKIPPED'].includes(status)) throw new DomainError('VALIDATION_FAILED', 422, 'status');
    const limit = limitOf(query.limit);
    return this.database.withTenant(tenant, async (tx) => {
      const rows = await this.store.list(tx, { scheduleId: uuidOf(query.schedule_id, 'schedule_id'), issueId: uuidOf(query.issue_id, 'issue_id'), recipientId: uuidOf(query.recipient_id, 'recipient_id'), status }, limit + 1);
      // A row of a form the reader may not read is not shown: its file name, hash and copy id would tell what the form holds.
      const readable = new Map<string, boolean>();
      for (const id of new Set(rows.map((row) => row.scheduleId))) {
        const schedule = await this.store.findSchedule(tx, id);
        readable.set(id, schedule !== undefined && layoutReadable(access, schedule.layoutCode));
      }
      const shown = rows.filter((row) => readable.get(row.scheduleId) === true).slice(0, limit);
      return { items: shown.map(mailingDto), truncated: rows.length > limit, as_of: now.toISOString() };
    });
  }
}

/**
 * The commands of the e-mail schedules: make one (the form must exist and be one the maker may read; recipients are active members of the tenant), retire one for good with a reason. A schedule never changes after it
 * is made: to change it, retire it and make another. Every command is audited (ADM-11) and announced in the outbox with ids and codes, never the report or an address.
 */
@Controller()
export class ReportMailCommandController {
  private readonly store = new ReportMailStore();
  private readonly reports = new ReportStore();

  @Post('report-engine/mail-schedules')
  @HttpCode(200)
  @OperationId('createReportMailSchedule')
  @Command({ operation: 'createReportMailSchedule' })
  async create(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Record<string, unknown>): Promise<CommandResult> {
    if (!holdsOnWholeTenant(access, MAIL_MANAGE)) throw new DomainError('SCOPE_DENIED', 403);
    const request = scheduleRequestOf(body);
    // The PDF of an issued copy comes with the PDF engine of ENT-4b; until it is wired a schedule for PDF would only log skipped copies, and a skipped copy is final.
    if (request.format === 'PDF') throw new DomainError('VALIDATION_FAILED', 422, 'format');
    if (!layoutReadable(access, request.layoutCode)) throw new DomainError('SCOPE_DENIED', 403);
    if ((await this.reports.findLayout(scope.tx, request.layoutCode)) === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404, 'layout_code');
    const now = new Date();
    const row = await this.store.createSchedule(scope.tx, request, scope.tenant.membershipId);
    await scope.audit({
      action: 'report.mail_schedule_created',
      resourceType: RESOURCE,
      resourceId: row.id,
      classification: 'INTERNAL',
      diff: { layout_code: row.layoutCode, cron: row.cron, format: row.format, recipient_count: row.recipients.length },
    });
    await scope.emit({
      aggregateType: RESOURCE,
      aggregateId: row.id,
      aggregateVersion: row.version,
      type: 'rpt.mail_schedule.created.v1',
      schemaVersion: 1,
      payload: { tenant_id: scope.tenant.tenantId, schedule_id: row.id, layout_code: row.layoutCode, format: row.format, recipient_count: row.recipients.length, actor_id: scope.tenant.membershipId, occurred_at: now.toISOString() },
      eventKey: `${RESOURCE}:${row.id}:created`,
    });
    return commandResult(scope, 'CREATED', row.version, row.id);
  }

  @Post('report-engine/mail-schedules/:id/retire')
  @HttpCode(200)
  @OperationId('retireReportMailSchedule')
  @Command({ operation: 'retireReportMailSchedule', versioned: true })
  async retire(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Record<string, unknown>): Promise<CommandResult> {
    if (!holdsOnWholeTenant(access, MAIL_MANAGE)) throw new DomainError('SCOPE_DENIED', 403);
    const reason = body.reason;
    if (typeof reason !== 'string' || reason.trim().length < 10 || reason.length > 2000) throw new DomainError('VALIDATION_FAILED', 422, 'reason');
    const now = new Date();
    const row = await this.store.retire(scope.tx, id, scope.expectedVersion ?? 0, reason.trim(), scope.tenant.membershipId, now);
    await scope.audit({
      action: 'report.mail_schedule_retired',
      resourceType: RESOURCE,
      resourceId: row.id,
      classification: 'INTERNAL',
      reason: row.retireReason ?? reason.trim(),
      diff: { layout_code: row.layoutCode, status: row.status },
    });
    await scope.emit({
      aggregateType: RESOURCE,
      aggregateId: row.id,
      aggregateVersion: row.version,
      type: 'rpt.mail_schedule.retired.v1',
      schemaVersion: 1,
      payload: { tenant_id: scope.tenant.tenantId, schedule_id: row.id, actor_id: scope.tenant.membershipId, occurred_at: now.toISOString() },
      eventKey: `${RESOURCE}:${row.id}:retired`,
    });
    return commandResult(scope, 'RETIRED', row.version, row.id);
  }
}
