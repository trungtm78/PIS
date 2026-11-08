import { randomBytes } from 'node:crypto';
import { Body, Controller, Get, Header, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { ControlDatabase, PortalPublicReads, TenantDatabase, WhistlePublicReads, WhistleStore } from '@machvon/db';
import type { WhistleRow } from '@machvon/db';
import { ACCESS_CODE_LENGTH, DomainError, WHISTLE_STATUSES, accessCodeFrom, addDays, hashAccessCode, isAccessCode, normalizeAccessCode, whistleClock } from '@machvon/kernel';
import type { EffectiveAccess, TenantContext, WhistleMove, WhistleStatus } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { OperationId } from '../../operation-id.decorator';
import { Public } from '../../public.decorator';
import { IdentityCommand } from '../../session/identity.guard';
import { CurrentTenant } from '../../tenant-context.decorator';
import { assertValidBody } from '../../request-validation';
import { clientKeyOf, consumeRate, ANONYMOUS_RATE_PER_MINUTE } from '../public-client';
import { assertWholeTenant, oneOfQuery, pageOf, todayOf } from '../gov12-support';

const RESOURCE = 'whistle_report';

const view = (row: WhistleRow): Record<string, unknown> => ({
  id: row.id,
  category: row.category,
  status: row.status,
  received_on: row.receivedOn,
  subject_unit_id: row.subjectUnitId,
  handler_id: row.handlerId,
  acknowledged_on: row.acknowledgedOn,
  closed_on: row.closedOn,
  clock: { acknowledge_due_on: row.clock.acknowledgeDueOn, acknowledge_state: row.clock.acknowledgeState, resolve_due_on: row.clock.resolveDueOn, resolve_state: row.clock.resolveState },
  version: row.version,
});

/**
 * The anonymous report channel, handlers' side (G4-12). A report reaches only the people who hold the right on the whole tenant, and never the people of the unit it is about: once a handler names the unit, they get 404 as if it
 * did not exist. The text of a report is CONFIDENTIAL in the audit trail and in no event: events carry the id, the category and the move, never the words. A handler's answer goes to the reporter's thread.
 */
@Controller()
export class WhistleController {
  private readonly store = new WhistleStore();

  @Post('whistle-reports/:id/move')
  @HttpCode(200)
  @OperationId('moveWhistleReport')
  @Command({ operation: 'moveWhistleReport', versioned: true })
  async move(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['MoveWhistleReport']): Promise<CommandResult> {
    assertWholeTenant(access, PERMISSIONS.moveWhistleReport);
    const done = await this.store.move(scope.tx, id.toLowerCase(), scope.expectedVersion ?? 0, body.move as WhistleMove, scope.tenant.membershipId, body.note ?? null, todayOf(new Date()));
    await scope.audit({ action: `aud.whistle_report_${body.move.toLowerCase()}`, resourceType: RESOURCE, resourceId: done.id, classification: 'CONFIDENTIAL', diff: { status: done.status, category: done.category }, ...(body.note === undefined ? {} : { reason: body.note.trim() }) });
    await scope.emit({ aggregateType: RESOURCE, aggregateId: done.id, aggregateVersion: done.version, type: 'aud.whistle_report.moved.v1', schemaVersion: 1, payload: { tenant_id: scope.tenant.tenantId, report_id: done.id, move: body.move, status: done.status, actor_id: scope.tenant.membershipId }, eventKey: `${RESOURCE}:${done.id}:${done.version}` });
    return commandResult(scope, done.status, done.version, done.id);
  }

  @Post('whistle-reports/:id/subject')
  @HttpCode(200)
  @OperationId('assignWhistleSubject')
  @Command({ operation: 'assignWhistleSubject', versioned: true })
  async subject(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['AssignWhistleSubject']): Promise<CommandResult> {
    assertWholeTenant(access, PERMISSIONS.assignWhistleSubject);
    const done = await this.store.assignSubject(scope.tx, id.toLowerCase(), scope.expectedVersion ?? 0, body.unit_id === null ? null : body.unit_id.toLowerCase(), scope.tenant.membershipId, todayOf(new Date()));
    await scope.audit({ action: 'aud.whistle_report_subject_assigned', resourceType: RESOURCE, resourceId: done.id, classification: 'CONFIDENTIAL', diff: { subject_unit_id: done.subjectUnitId } });
    await scope.emit({ aggregateType: RESOURCE, aggregateId: done.id, aggregateVersion: done.version, type: 'aud.whistle_report.subject_assigned.v1', schemaVersion: 1, payload: { tenant_id: scope.tenant.tenantId, report_id: done.id, actor_id: scope.tenant.membershipId }, eventKey: `${RESOURCE}:${done.id}:${done.version}` });
    return commandResult(scope, done.status, done.version, done.id);
  }

  @Post('whistle-reports/:id/reply')
  @HttpCode(200)
  @OperationId('replyToWhistleReporter')
  @Command({ operation: 'replyToWhistleReporter' })
  async reply(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string, @Body() body: Schemas['ReplyToReporter']): Promise<CommandResult> {
    assertWholeTenant(access, PERMISSIONS.replyToWhistleReporter);
    const message = await this.store.reply(scope.tx, id.toLowerCase(), scope.tenant.membershipId, body.body, todayOf(new Date()));
    await scope.audit({ action: 'aud.whistle_report_replied', resourceType: RESOURCE, resourceId: id.toLowerCase(), classification: 'CONFIDENTIAL', diff: { seq: message.seq } });
    await scope.emit({ aggregateType: RESOURCE, aggregateId: id.toLowerCase(), aggregateVersion: message.seq, type: 'aud.whistle_report.replied.v1', schemaVersion: 1, payload: { tenant_id: scope.tenant.tenantId, report_id: id.toLowerCase(), seq: message.seq, actor_id: scope.tenant.membershipId }, eventKey: `${RESOURCE}:${id.toLowerCase()}:reply:${message.seq}` });
    return commandResult(scope, 'REPLIED', message.seq, id.toLowerCase());
  }
}

/** The anonymous channel, handlers' side, reads. */
@Controller()
export class WhistleReadsController {
  private readonly store = new WhistleStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get('whistle-reports/summary')
  @OperationId('getWhistleSummary')
  async summary(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess): Promise<Record<string, unknown>> {
    assertWholeTenant(access, PERMISSIONS.getWhistleSummary);
    const today = todayOf(new Date());
    // Counted in the database over what this handler may see (the reports about their own unit are not in the numbers), however many there are.
    const counts = await this.database.withTenant(tenant, (tx) => this.store.summaryFor(tx, tenant.membershipId, today));
    return { as_of: today, total: counts.total, open: counts.open, acknowledge_overdue: counts.acknowledgeOverdue, resolve_overdue: counts.resolveOverdue };
  }

  @Get('whistle-reports')
  @OperationId('listWhistleReports')
  async list(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Query('status') status?: unknown, @Query('limit') limit?: unknown, @Query('offset') offset?: unknown): Promise<Record<string, unknown>> {
    assertWholeTenant(access, PERMISSIONS.listWhistleReports);
    const filter = oneOfQuery<WhistleStatus>(status, WHISTLE_STATUSES, 'status');
    const page = pageOf(limit, offset);
    const today = todayOf(new Date());
    const rows = await this.database.withTenant(tenant, (tx) => this.store.listFor(tx, tenant.membershipId, { status: filter, limit: page.limit + 1, offset: page.offset }, today));
    return { as_of: today, items: rows.slice(0, page.limit).map(view), has_more: rows.length > page.limit };
  }

  @Get('whistle-reports/:id')
  @OperationId('getWhistleReport')
  async get(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Record<string, unknown>> {
    assertWholeTenant(access, PERMISSIONS.getWhistleReport);
    const today = todayOf(new Date());
    const found = await this.database.withTenant(tenant, async (tx) => {
      const row = await this.store.findFor(tx, id.toLowerCase(), tenant.membershipId, today);
      return row === undefined ? undefined : { row, thread: await this.store.thread(tx, row.id) };
    });
    // A handler of the unit the report is about, and a report that does not exist, are answered the same way.
    if (found === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404, 'id');
    return { as_of: today, ...view(found.row), body: found.row.body, public_note: found.row.publicNote, thread: found.thread.map((message) => ({ seq: message.seq, sender: message.sender, body: message.body, sent_on: message.sentOn, handler_id: message.handlerId })) };
  }
}

const SLUG = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;
const group = (code: string): string => code.match(/.{1,4}/g)?.join('-') ?? code;

/**
 * The anonymous channel, reporter's side (G4-12): no session, no tenant in the request, no identity. The report is stored with the hash of a random access code that is shown once; the reporter comes back with the code (in the
 * body of a POST, so it is never in an address or a log line of a proxy) to read the status and the answers and to add to the report. Nothing about the caller is stored: the rate limit works on a key of the address made with a
 * secret of this process, held in memory, never written. The days of the clocks are those of the settings of the portal, which copy the rule when they are saved.
 */
@Controller()
export class WhistlePublicController {
  private readonly portal = new PortalPublicReads();
  private readonly reads = new WhistlePublicReads();

  constructor(@Inject(ControlDatabase) private readonly control: ControlDatabase) {}

  private async open(slug: string, request: { ip?: string | undefined }): Promise<{ key: string; info: NonNullable<Awaited<ReturnType<PortalPublicReads['info']>>> }> {
    if (!SLUG.test(slug)) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const key = clientKeyOf(request, slug);
    consumeRate('portal-any', key, ANONYMOUS_RATE_PER_MINUTE, 60);
    const info = await this.control.withControl((tx) => this.portal.info(tx, slug));
    if (info === undefined || !info.whistleEnabled) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return { key, info };
  }

  @Public()
  @Post('public/portals/:slug/reports')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @OperationId('submitWhistleReport')
  @IdentityCommand('submitWhistleReport')
  async submit(@Param('slug') slug: string, @Req() request: { ip?: string | undefined }, @Body() body: Schemas['SubmitWhistleReport']): Promise<Record<string, unknown>> {
    assertValidBody('submitWhistleReport', body);
    const { key, info } = await this.open(slug, request);
    consumeRate('whistle-submit', key, info.whistle.policy.rate_per_hour, 3600);
    const code = accessCodeFrom(randomBytes(ACCESS_CODE_LENGTH));
    const today = todayOf(new Date());
    await this.control.withControl((tx) => this.reads.submit(tx, slug, { category: body.category, text: body.text, codeHash: hashAccessCode(code), receivedOn: today }, info.whistle.policy, info.whistle.ruleVersion));
    return {
      access_code: group(code),
      received_on: today,
      acknowledge_due_on: addDays(today, info.whistle.policy.acknowledge_days),
      resolve_due_on: addDays(today, info.whistle.policy.resolve_days),
      // The only copy of the code is in this answer: whoever loses it cannot read the answers, and nobody can give it back.
      shown_once: true,
    };
  }

  private async lookup(slug: string, request: { ip?: string | undefined }, typed: string): Promise<{ codeHash: string; status: NonNullable<Awaited<ReturnType<WhistlePublicReads['lookup']>>>; thread: Awaited<ReturnType<WhistlePublicReads['thread']>>; info: Awaited<ReturnType<PortalPublicReads['info']>> }> {
    const { key, info } = await this.open(slug, request);
    consumeRate('whistle-read', key, 20, 60);
    const code = normalizeAccessCode(typed);
    if (!isAccessCode(code)) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const codeHash = hashAccessCode(code);
    const found = await this.control.withControl(async (tx) => {
      const status = await this.reads.lookup(tx, slug, codeHash);
      return status === undefined ? undefined : { status, thread: await this.reads.thread(tx, slug, codeHash) };
    });
    if (found === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return { codeHash, ...found, info };
  }

  @Public()
  @Post('public/portals/:slug/reports/status')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @OperationId('getWhistleReportStatus')
  @IdentityCommand('getWhistleReportStatus')
  async status(@Param('slug') slug: string, @Req() request: { ip?: string | undefined }, @Body() body: Schemas['WhistleAccess']): Promise<Record<string, unknown>> {
    assertValidBody('getWhistleReportStatus', body);
    const { status, thread } = await this.lookup(slug, request, body.access_code);
    // The clocks are those the report was received under (its own days), the same as the handlers see, not the days of the settings today.
    const clock = whistleClock({ receivedOn: status.receivedOn, acknowledgedOn: status.acknowledgedOn, closedOn: status.closedOn }, todayOf(new Date()), { acknowledge_days: status.acknowledgeDays, resolve_days: status.resolveDays, rate_per_hour: 1 });
    return {
      as_of: todayOf(new Date()),
      category: status.category,
      status: status.status,
      received_on: status.receivedOn,
      acknowledged_on: status.acknowledgedOn,
      closed_on: status.closedOn,
      note: status.publicNote,
      acknowledge_due_on: clock.acknowledgeDueOn,
      resolve_due_on: clock.resolveDueOn,
      thread: thread.map((message) => ({ seq: message.seq, from: message.sender === 'HANDLER' ? 'HANDLER' : 'YOU', body: message.body, sent_on: message.sentOn })),
    };
  }

  @Public()
  @Post('public/portals/:slug/reports/reply')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @OperationId('replyWhistleReportAsReporter')
  @IdentityCommand('replyWhistleReportAsReporter')
  async reply(@Param('slug') slug: string, @Req() request: { ip?: string | undefined }, @Body() body: Schemas['ReplyAsReporter']): Promise<Record<string, unknown>> {
    assertValidBody('replyWhistleReportAsReporter', body);
    const { codeHash } = await this.lookup(slug, request, body.access_code);
    const seq = await this.control.withControl((tx) => this.reads.reply(tx, slug, codeHash, body.body, todayOf(new Date())));
    return { seq, received: true };
  }
}
