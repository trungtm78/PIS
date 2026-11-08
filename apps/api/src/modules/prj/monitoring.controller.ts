import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { MonitoringStore, TenantDatabase } from '@machvon/db';
import type { MonitoringFeedbackRow, MonitoringFileReading, MonitoringFileRow } from '@machvon/db';
import { DomainError } from '@machvon/kernel';
import type { EffectiveAccess, MonitoringFeedbackMove, NoticeReading, TenantContext } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { CurrentTenant } from '../../tenant-context.decorator';
import { assertWholeTenant, oneOfQuery, pageOf, textOrNull, todayOf } from '../gov12-support';

const FILE = 'monitoring_file';
const FEEDBACK = 'monitoring_feedback';
const PACK = 'monitoring_pack_item';

const noticeView = (notice: NoticeReading): Record<string, unknown> => ({ state: notice.state, due_on: notice.dueOn, days_left: notice.daysLeft, days_late: notice.daysLate });

const fileView = (file: MonitoringFileRow, notice: NoticeReading): Record<string, unknown> => ({
  id: file.id,
  project_id: file.projectId,
  project_code: file.projectCode,
  project_name: file.projectName,
  status: file.status,
  trigger: file.triggerKind === null ? null : { kind: file.triggerKind, on: file.triggerOn, reason: file.triggerReason },
  // The days are those fixed on the file when the trigger was set, with the version of the rule: the formula, source and legal status of the number are on the screen of the rule.
  notice_days: file.noticeDays,
  notice_rule_version: file.noticeRuleVersion,
  notice: { ...noticeView(notice), sent_on: file.noticeSentOn, sent_by: file.noticeSentBy, note: file.noticeNote },
  closed_at: file.closedAt,
  version: file.version,
});

const feedbackView = (row: MonitoringFeedbackRow): Record<string, unknown> => ({
  id: row.id,
  file_id: row.fileId,
  reference: row.reference,
  received_on: row.receivedOn,
  channel: row.channel,
  topic: row.topic,
  from_label: row.fromLabel,
  summary: row.summary,
  status: row.status,
  response_days: row.responseDays,
  rule_version: row.ruleVersion,
  owner_id: row.ownerId,
  response_text: row.responseText,
  responded_on: row.respondedOn,
  responded_by: row.respondedBy,
  closed_by: row.closedBy,
  declined_reason: row.declinedReason,
  response: { state: row.response.state, due_on: row.response.dueOn, days_left: row.response.daysLeft, days_late: row.response.daysLate },
  version: row.version,
});

const readingView = (reading: MonitoringFileReading, feedback: MonitoringFeedbackRow[], today: string): Record<string, unknown> => ({
  as_of: today,
  ...fileView(reading.file, reading.notice),
  pack: {
    present: reading.pack.present,
    missing: reading.pack.missing,
    required_missing: reading.pack.requiredMissing,
    complete: reading.pack.complete,
    items: reading.items.map((item) => ({ id: item.id, item: item.item, document_id: item.documentId, document_kind: item.documentKind, title: item.title, sha256: item.sha256, added_at: item.addedAt })),
  },
  summary: { feedback_total: reading.summary.feedbackTotal, open: reading.summary.open, overdue: reading.summary.overdue, answered_on_time_pct: reading.summary.answeredOnTimePct },
  feedback: feedback.map(feedbackView),
});

/**
 * The community monitoring file of a project (G4-8), commands. The deadline of the notice runs from the day the duty began and is fixed with the days of the rule of that day; a feedback has its own clock from the day it was
 * received. Everything here is the whole tenant's: a monitoring file belongs to no unit. Every command is audited and carries an event with ids only.
 */
@Controller()
export class MonitoringController {
  private readonly store = new MonitoringStore();

  @Post('monitoring-files')
  @HttpCode(200)
  @OperationId('openMonitoringFile')
  @Command({ operation: 'openMonitoringFile' })
  async open(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['OpenMonitoringFile']): Promise<CommandResult> {
    assertWholeTenant(access, PERMISSIONS.openMonitoringFile);
    const { file, created } = await this.store.openFile(scope.tx, body.project_id.toLowerCase(), scope.tenant.membershipId);
    if (created) await this.record(scope, 'prj.monitoring_file_opened', FILE, file.id, file.version, 'prj.monitoring_file.opened.v1', { project_id: file.projectId });
    return commandResult(scope, created ? 'OPENED' : 'EXISTING', file.version, file.id);
  }

  @Post('monitoring-files/:id/trigger')
  @HttpCode(200)
  @OperationId('setMonitoringTrigger')
  @Command({ operation: 'setMonitoringTrigger', versioned: true })
  async trigger(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['SetMonitoringTrigger']): Promise<CommandResult> {
    assertWholeTenant(access, PERMISSIONS.setMonitoringTrigger);
    const file = await this.store.setTrigger(scope.tx, id.toLowerCase(), scope.expectedVersion ?? 0, { kind: body.kind, on: body.on, reason: textOrNull(body.reason) }, todayOf(new Date()));
    await this.record(scope, 'prj.monitoring_trigger_set', FILE, file.id, file.version, 'prj.monitoring_trigger.set.v1', { kind: file.triggerKind, trigger_on: file.triggerOn, notice_days: file.noticeDays, rule_version: file.noticeRuleVersion }, body.reason);
    return commandResult(scope, 'TRIGGER_SET', file.version, file.id);
  }

  @Post('monitoring-files/:id/pack-items')
  @HttpCode(200)
  @OperationId('addMonitoringPackItem')
  @Command({ operation: 'addMonitoringPackItem' })
  async addItem(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['AddMonitoringPackItem']): Promise<CommandResult> {
    assertWholeTenant(access, PERMISSIONS.addMonitoringPackItem);
    const item = await this.store.addItem(scope.tx, id.toLowerCase(), { item: body.item, documentId: body.document_id.toLowerCase(), documentKind: body.document_kind }, scope.tenant.membershipId);
    await this.record(scope, 'prj.monitoring_pack_item_added', PACK, item.id, 1, 'prj.monitoring_pack_item.added.v1', { file_id: id, item: item.item, document_id: item.documentId });
    return commandResult(scope, 'ADDED', 1, item.id);
  }

  @Post('monitoring-pack-items/:id/withdraw')
  @HttpCode(200)
  @OperationId('withdrawMonitoringPackItem')
  @Command({ operation: 'withdrawMonitoringPackItem' })
  async withdrawItem(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['Gov12Reason']): Promise<CommandResult> {
    assertWholeTenant(access, PERMISSIONS.withdrawMonitoringPackItem);
    const done = await this.store.withdrawItem(scope.tx, id.toLowerCase(), body.reason, scope.tenant.membershipId);
    await this.record(scope, 'prj.monitoring_pack_item_withdrawn', PACK, id, 1, 'prj.monitoring_pack_item.withdrawn.v1', { file_id: done.fileId, item: done.item }, body.reason);
    return commandResult(scope, 'WITHDRAWN', 1, id.toLowerCase());
  }

  @Post('monitoring-files/:id/notice')
  @HttpCode(200)
  @OperationId('sendMonitoringNotice')
  @Command({ operation: 'sendMonitoringNotice', versioned: true })
  async notice(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['SendMonitoringNotice']): Promise<CommandResult> {
    assertWholeTenant(access, PERMISSIONS.sendMonitoringNotice);
    const sent = await this.store.sendNotice(scope.tx, id.toLowerCase(), scope.expectedVersion ?? 0, { sentOn: body.sent_on, note: textOrNull(body.note) }, scope.tenant.membershipId, todayOf(new Date()));
    await this.record(scope, 'prj.monitoring_notice_sent', FILE, sent.file.id, sent.file.version, 'prj.monitoring_notice.sent.v1', { sent_on: body.sent_on, state: sent.notice.state, days_late: sent.notice.daysLate });
    return commandResult(scope, sent.notice.state, sent.file.version, sent.file.id);
  }

  @Post('monitoring-files/:id/close')
  @HttpCode(200)
  @OperationId('closeMonitoringFile')
  @Command({ operation: 'closeMonitoringFile', versioned: true })
  async close(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<CommandResult> {
    assertWholeTenant(access, PERMISSIONS.closeMonitoringFile);
    const file = await this.store.close(scope.tx, id.toLowerCase(), scope.expectedVersion ?? 0, scope.tenant.membershipId);
    await this.record(scope, 'prj.monitoring_file_closed', FILE, file.id, file.version, 'prj.monitoring_file.closed.v1', {});
    return commandResult(scope, 'CLOSED', file.version, file.id);
  }

  @Post('monitoring-files/:id/feedback')
  @HttpCode(200)
  @OperationId('logMonitoringFeedback')
  @Command({ operation: 'logMonitoringFeedback' })
  async log(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['LogMonitoringFeedback']): Promise<CommandResult> {
    assertWholeTenant(access, PERMISSIONS.logMonitoringFeedback);
    const { feedback, created } = await this.store.logFeedback(
      scope.tx,
      id.toLowerCase(),
      { reference: body.reference, receivedOn: body.received_on, channel: body.channel, topic: body.topic, fromLabel: textOrNull(body.from_label), summary: body.summary },
      scope.tenant.membershipId,
      todayOf(new Date()),
    );
    // The words of the community are not copied into the audit row or the event: they name the feedback by its id and its topic.
    if (created) await this.record(scope, 'prj.monitoring_feedback_received', FEEDBACK, feedback.id, feedback.version, 'prj.monitoring_feedback.received.v1', { file_id: id, topic: feedback.topic, channel: feedback.channel, due_on: feedback.response.dueOn });
    return commandResult(scope, created ? 'RECEIVED' : 'EXISTING', feedback.version, feedback.id);
  }

  @Post('monitoring-feedback/:id/move')
  @HttpCode(200)
  @OperationId('moveMonitoringFeedback')
  @Command({ operation: 'moveMonitoringFeedback', versioned: true })
  async move(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['MoveMonitoringFeedback']): Promise<CommandResult> {
    assertWholeTenant(access, PERMISSIONS.moveMonitoringFeedback);
    const done = await this.store.moveFeedback(scope.tx, id.toLowerCase(), scope.expectedVersion ?? 0, body.move as MonitoringFeedbackMove, scope.tenant.membershipId, { text: textOrNull(body.text) }, todayOf(new Date()));
    await this.record(scope, `prj.monitoring_feedback_${body.move.toLowerCase()}`, FEEDBACK, done.id, done.version, 'prj.monitoring_feedback.moved.v1', { move: body.move, status: done.status, response_state: done.response.state });
    return commandResult(scope, done.status, done.version, done.id);
  }

  private async record(scope: CommandScope, action: string, resourceType: string, id: string, version: number, event: string, facts: Record<string, unknown>, reason?: string): Promise<void> {
    await scope.audit({ action, resourceType, resourceId: id, diff: facts, ...(reason === undefined ? {} : { reason: reason.trim() }) });
    await scope.emit({ aggregateType: resourceType, aggregateId: id, aggregateVersion: version, type: event, schemaVersion: 1, payload: { tenant_id: scope.tenant.tenantId, id, actor_id: scope.tenant.membershipId, ...facts }, eventKey: `${resourceType}:${id}:${version}:${action}` });
  }
}

/** The community monitoring file, reads: the list with the notice state and the counts of overdue answers, one file with its pack and feedback, one feedback with its history. */
@Controller()
export class MonitoringReadsController {
  private readonly store = new MonitoringStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get('monitoring-files')
  @OperationId('listMonitoringFiles')
  async list(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Query('status') status?: unknown, @Query('limit') limit?: unknown, @Query('offset') offset?: unknown): Promise<Record<string, unknown>> {
    assertWholeTenant(access, PERMISSIONS.listMonitoringFiles);
    const filter = oneOfQuery(status, ['OPEN', 'CLOSED'] as const, 'status');
    const page = pageOf(limit, offset);
    const today = todayOf(new Date());
    const rows = await this.database.withTenant(tenant, (tx) => this.store.list(tx, { status: filter, limit: page.limit + 1, offset: page.offset }, today));
    return {
      as_of: today,
      items: rows.slice(0, page.limit).map((row) => ({
        ...fileView(row.file, row.notice),
        summary: { feedback_total: row.summary.feedbackTotal, open: row.summary.open, overdue: row.summary.overdue, answered_on_time_pct: row.summary.answeredOnTimePct },
      })),
      has_more: rows.length > page.limit,
    };
  }

  @Get('monitoring-files/:id')
  @OperationId('getMonitoringFile')
  async get(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    assertWholeTenant(access, PERMISSIONS.getMonitoringFile);
    const today = todayOf(new Date());
    const found = await this.database.withTenant(tenant, async (tx) => {
      const reading = await this.store.reading(tx, id.toLowerCase(), today);
      return reading === undefined ? undefined : { reading, feedback: await this.store.feedbackOf(tx, reading.file.id, today), policy: await this.store.policy(tx, today) };
    });
    if (found === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404, 'id');
    return { ...readingView(found.reading, found.feedback, today), rule: { version: found.policy.version, unverified: found.policy.unverified, notice_days_now: found.policy.policy.notice_days, response_days_now: found.policy.policy.response_days, reminder_days: found.policy.policy.reminder_days } };
  }

  @Get('monitoring-feedback/:id')
  @OperationId('getMonitoringFeedback')
  async feedback(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    assertWholeTenant(access, PERMISSIONS.getMonitoringFeedback);
    const today = todayOf(new Date());
    const found = await this.database.withTenant(tenant, async (tx) => {
      const row = await this.store.getFeedback(tx, id.toLowerCase(), today);
      return row === undefined ? undefined : { row, events: await this.store.events(tx, row.id) };
    });
    if (found === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404, 'id');
    return { as_of: today, ...feedbackView(found.row), history: found.events.map((event) => ({ id: event.id, move: event.move, from_status: event.fromStatus, to_status: event.toStatus, actor_id: event.actorId, reason: event.reason, at: event.at })) };
  }
}
