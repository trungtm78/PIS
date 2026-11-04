import { randomUUID } from 'node:crypto';
import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { NotificationTemplateStore, TenantDatabase } from '@machvon/db';
import type { NotificationTemplateRecord, TenantTx } from '@machvon/db';
import { DomainError, PROVIDER_CHANNELS, assertTemplateAllowed, assertTemplateIdentity, isPush, sampleVariablesOf } from '@machvon/kernel';
import type { EffectiveAccess, TenantContext } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { holdsOnWholeTenant } from '../../modules/adm/tenant-authority';
import { OperationId } from '../../operation-id.decorator';
import { encodeCursor, parsePageRequest } from '../../pagination';
import { CurrentTenant } from '../../tenant-context.decorator';
import { CHANNEL_ADAPTERS } from '../delivery/channel-adapters';
import type { ChannelAdapterRegistry } from '../delivery/channel-adapters';
import { renderTemplate } from '../delivery/template-renderer';

const MANAGE = PERMISSIONS.createTemplateRevision;
const APPROVE = PERMISSIONS.decideTemplateRevision;
const READ = PERMISSIONS.get_resources_notification_template_version;
const TEMPLATE_RESOURCE = 'notification_template';
const STATUSES: readonly string[] = ['Draft', 'InReview', 'PendingProvider', 'Active', 'Rejected', 'Retired'];
const TEST_PREFIX = '[TEST] ';

/** The templates of the tenant decide what every message says: who writes, reviews and tests them holds the permission on the whole tenant. */
function assertHolds(access: EffectiveAccess, permission: string): void {
  if (!holdsOnWholeTenant(access, permission)) throw new DomainError('SCOPE_DENIED', 403);
}

function viewOf(row: NotificationTemplateRecord): Schemas['NotificationTemplateVersion'] {
  return {
    id: row.id,
    code: row.code,
    channel: row.channel as Schemas['NotificationTemplateVersion']['channel'],
    locale: row.locale,
    revision: row.revision,
    purpose: row.purpose,
    content_ast: row.contentAst as Record<string, unknown>,
    variable_schema: row.variableSchema as Record<string, unknown>,
    lockscreen_safe: row.lockscreenSafe,
    status: row.status,
    provider_status: row.providerStatus as Schemas['NotificationTemplateVersion']['provider_status'],
    created_by: row.createdBy,
    approved_by: row.approvedBy,
    supersedes_id: row.supersedesId,
    created_at: row.createdAt,
    version: row.version,
  };
}

/** The same judgement of a template at every step: when it is written, when it is sent to review, when the test is rendered. */
function judge(template: Pick<NotificationTemplateRecord, 'channel' | 'contentAst' | 'variableSchema' | 'lockscreenSafe'>): void {
  assertTemplateAllowed({ channel: template.channel, contentAst: template.contentAst, variableSchema: template.variableSchema, lockscreenSafe: template.lockscreenSafe });
}

/**
 * The templates of the messages (ST-NOT-005, NOT 3.4, BR-NOT-10, BR-NOT-11): a revision per code, channel and locale is written, sent to review, approved by another person, and tested with the people the tenant listed.
 * Nothing is stored or sent that breaks the rules of the channel: a phone or a provider carries no money and nothing confidential (422 `TEMPLATE_VARIABLE_CLASSIFIED`), and a push is safe on the lock screen.
 */
@Controller()
export class NotificationTemplatesController {
  private readonly store = new NotificationTemplateStore();

  constructor(
    @Inject(TenantDatabase) private readonly database: TenantDatabase,
    @Inject(CHANNEL_ADAPTERS) private readonly adapters: ChannelAdapterRegistry,
  ) {}

  @Get('resources/notification_template_version')
  @OperationId('get_resources_notification_template_version')
  async list(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Query('code') code?: unknown,
    @Query('channel') channel?: unknown,
    @Query('locale') locale?: unknown,
    @Query('status') status?: unknown,
    @Query('limit') limit?: unknown,
    @Query('cursor') cursor?: unknown,
  ): Promise<Schemas['NotificationTemplateVersionPage']> {
    // The templates are the tenant's, not a unit's or a project's: a grant on a part of the tenant does not read them.
    assertHolds(access, READ);
    const request = parsePageRequest(limit, cursor);
    if (status !== undefined && (typeof status !== 'string' || !STATUSES.includes(status))) throw new DomainError('VALIDATION_FAILED', 422, 'status');
    const text = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);
    const rows = await this.database.withTenant(tenant, (tx) =>
      this.store.list(tx, { code: text(code), channel: text(channel), locale: text(locale), status: status as string | undefined }, { limit: request.limit + 1, after: request.after }),
    );
    const shown = rows.slice(0, request.limit);
    const last = shown[shown.length - 1];
    return { items: shown.map(viewOf), next_cursor: rows.length > request.limit && last !== undefined ? encodeCursor({ code: last.sortKey, id: last.id }) : null, as_of: new Date().toISOString() };
  }

  @Get('resources/notification_template_version/:id')
  @OperationId('get_resources_notification_template_version_id')
  async get(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Schemas['NotificationTemplateVersion']> {
    assertHolds(access, READ);
    const found = await this.database.withTenant(tenant, (tx) => this.store.find(tx, id.toLowerCase()));
    if (found === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return viewOf(found);
  }

  @Post('notification-templates')
  @HttpCode(201)
  @OperationId('createTemplateRevision')
  @Command({ operation: 'createTemplateRevision' })
  async create(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['TemplateRevisionCreate']): Promise<CommandResult> {
    assertHolds(access, MANAGE);
    const lockscreenSafe = body.lockscreen_safe ?? false;
    assertTemplateIdentity({ code: body.code, locale: body.locale, purpose: body.purpose });
    judge({ channel: body.channel, contentAst: body.content_ast, variableSchema: body.variable_schema, lockscreenSafe });
    const created = await this.store.create(
      scope.tx,
      { code: body.code, channel: body.channel, locale: body.locale, purpose: body.purpose, contentAst: body.content_ast, variableSchema: body.variable_schema, lockscreenSafe, supersedesId: body.supersedes_id },
      scope.tenant.membershipId,
    );
    await scope.audit({
      action: 'notification.template_created',
      resourceType: TEMPLATE_RESOURCE,
      resourceId: created.id,
      classification: 'INTERNAL',
      diff: { code: created.code, channel: created.channel, locale: created.locale, revision: created.revision },
    });
    return commandResult(scope, 'DRAFT', created.version, created.id);
  }

  @Post('notification-templates/:templateId/submit')
  @HttpCode(202)
  @OperationId('submitTemplateRevision')
  @Command({ operation: 'submitTemplateRevision', versioned: true })
  async submit(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('templateId', ParseUUIDPipe) id: string, @Body() body: Schemas['ReasonOnly']): Promise<CommandResult> {
    assertHolds(access, MANAGE);
    const moved = await this.store.submit(scope.tx, id.toLowerCase(), scope.expectedVersion ?? 0, judge);
    await scope.audit({
      action: 'notification.template_submitted',
      resourceType: TEMPLATE_RESOURCE,
      resourceId: moved.id,
      reason: body.reason,
      classification: 'INTERNAL',
      diff: { code: moved.code, channel: moved.channel, locale: moved.locale, revision: moved.revision, to: moved.status },
    });
    return commandResult(scope, moved.status.toUpperCase(), moved.version, moved.id);
  }

  @Post('notification-templates/:templateId/decision')
  @HttpCode(200)
  @OperationId('decideTemplateRevision')
  @Command({ operation: 'decideTemplateRevision', versioned: true })
  async decide(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('templateId', ParseUUIDPipe) id: string, @Body() body: Schemas['Decision']): Promise<CommandResult> {
    assertHolds(access, APPROVE);
    const moved = await this.store.decide(scope.tx, id.toLowerCase(), scope.expectedVersion ?? 0, body.decision, scope.tenant.membershipId);
    await scope.audit({
      action: 'notification.template_decided',
      resourceType: TEMPLATE_RESOURCE,
      resourceId: moved.id,
      reason: body.reason,
      classification: 'INTERNAL',
      diff: { code: moved.code, channel: moved.channel, locale: moved.locale, revision: moved.revision, decision: body.decision, to: moved.status, evidence_count: body.evidence_ids.length },
    });
    return commandResult(scope, moved.status.toUpperCase(), moved.version, moved.id);
  }

  @Get('notification-test-recipients')
  @OperationId('listNotificationTestRecipients')
  async testRecipients(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess): Promise<Schemas['NotificationTestRecipients']> {
    assertHolds(access, MANAGE);
    return { membership_ids: await this.database.withTenant(tenant, (tx) => this.store.testRecipients(tx)) };
  }

  @Put('notification-test-recipients')
  @HttpCode(200)
  @OperationId('setNotificationTestRecipients')
  @Command({ operation: 'setNotificationTestRecipients' })
  async setTestRecipients(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['NotificationTestRecipients']): Promise<CommandResult> {
    assertHolds(access, MANAGE);
    const changed = await this.store.replaceTestRecipients(scope.tx, body.membership_ids, scope.tenant.membershipId);
    await scope.audit({
      action: 'notification.test_recipients_set',
      resourceType: 'notification_test_recipient',
      resourceId: scope.tenant.tenantId,
      classification: 'INTERNAL',
      diff: { added: changed.added.length, removed: changed.removed.length, total: body.membership_ids.length },
    });
    return commandResult(scope, 'SET', body.membership_ids.length, scope.tenant.tenantId);
  }

  @Post('notification-templates/:templateId/test-sends')
  @HttpCode(202)
  @OperationId('sendTestNotification')
  @Command({ operation: 'sendTestNotification' })
  async testSend(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('templateId', ParseUUIDPipe) id: string, @Body() body: Schemas['TestSendRequest']): Promise<CommandResult> {
    assertHolds(access, MANAGE);
    const template = await this.store.find(scope.tx, id.toLowerCase());
    if (template === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    // A revision that was refused or retired is not tested; a template of a provider is tested through the provider (R3).
    if (template.status === 'Rejected' || template.status === 'Retired' || template.status === 'PendingProvider' || PROVIDER_CHANNELS.has(template.channel) || template.channel === 'ZALO_OA') {
      throw new DomainError('TEMPLATE_INVALID', 422, 'status');
    }
    judge(template);
    const allowed = new Set(await this.store.testRecipients(scope.tx));
    const recipients = [...new Set(body.test_recipient_ids.map((recipient) => recipient.toLowerCase()))];
    if (recipients.some((recipient) => !allowed.has(recipient))) throw new DomainError('TEST_RECIPIENT_NOT_ALLOWED', 422, 'test_recipient_ids');
    // The list was true when it was written; a member who has since been suspended or whose membership ended is not written to.
    const eligible = await scope.tx.query<{ id: string }>(
      "select id from machvon.membership where id = any($1::uuid[]) and status = 'Active' and valid_from <= now() and (valid_until is null or valid_until > now())",
      [recipients],
    );
    if (eligible.length !== recipients.length) throw new DomainError('TEST_RECIPIENT_NOT_ALLOWED', 422, 'test_recipient_ids');
    const values = sampleVariablesOf(template.variableSchema, template.contentAst, body.sample_variables);
    const message = renderTemplate(template.contentAst, template.variableSchema, values);
    const text = `${TEST_PREFIX}${message.text}`;
    const subject = message.subject === undefined ? undefined : `${TEST_PREFIX}${message.subject}`;
    // The inbox and the push have nothing to send to yet (no inbox row for a test, no device before NOT-006): the test is rendered and judged, not delivered.
    let sent = 0;
    if (template.channel === 'EMAIL' || template.channel === 'SMS') {
      const adapter = this.adapters.usable(template.channel);
      if (adapter === undefined) throw new DomainError('PROVIDER_UNAVAILABLE', 503);
      const [account] = await scope.tx.query<{ external_account_id: string }>("select external_account_id from machvon.channel_account where channel = $1 and status = 'Active' order by id limit 1", [template.channel]);
      if (account === undefined) throw new DomainError('CHANNEL_ACCOUNT_UNKNOWN', 404);
      const addresses = await this.addressesOf(scope.tx, recipients, template.channel);
      for (const recipient of recipients) {
        const to = addresses.get(recipient);
        if (to === undefined) continue;
        sent += 1;
        // After the commit: a test that was refused leaves nothing behind, and a failure of the provider is not the failure of the command.
        scope.afterCommit(async () => {
          try {
            await adapter.send({ idempotencyKey: `test:${randomUUID()}`, accountId: account.external_account_id, to, text, ...(subject === undefined ? {} : { subject }) });
          } catch {
            // A test send is best effort; the audit row says it was asked for.
          }
        });
      }
    }
    await scope.audit({
      action: 'notification.test_sent',
      resourceType: TEMPLATE_RESOURCE,
      resourceId: template.id,
      classification: 'INTERNAL',
      // Counts only: no address, no recipient, no text. A test is not a notification, so nothing of it is counted in the metrics of the center.
      diff: { code: template.code, channel: template.channel, revision: template.revision, requested: recipients.length, sent, rendered_only: isPush(template.channel) || template.channel === 'IN_APP' },
    });
    return commandResult(scope, 'ACCEPTED', template.version, template.id);
  }

  /** The addresses the channel writes to, read in memory for the call: the directory masks personal data unless the transaction says the reader may see it. */
  private async addressesOf(tx: TenantTx, membershipIds: readonly string[], channel: string): Promise<Map<string, string>> {
    const column = channel === 'EMAIL' ? 'email' : 'phone';
    await tx.query("select set_config('app.can_read_pii', 'true', true)", []);
    const rows = await tx.query<{ membership_id: string; value: string | null }>(`select membership_id, ${column} as value from machvon.tenant_user_directory where membership_id = any($1::uuid[])`, [membershipIds]);
    return new Map(rows.flatMap((row) => (row.value === null ? [] : [[row.membership_id, row.value] as [string, string]])));
  }
}
