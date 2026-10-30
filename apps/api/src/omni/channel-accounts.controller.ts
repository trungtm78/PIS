import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { ChannelAccountStore, TenantDatabase } from '@machvon/db';
import type { ChannelAccountRecord } from '@machvon/db';
import { ACCOUNT_CHANNELS, ACCOUNT_STATUSES, DomainError, assertChanges, assertConnectable } from '@machvon/kernel';
import type { EffectiveAccess, TenantContext } from '@machvon/kernel';
import { Command, Scope } from '../command.decorator';
import { commandResult } from '../command-result';
import type { CommandResult } from '../command-result';
import type { CommandScope } from '../command-scope';
import type { Schemas } from '../contract-types';
import { CurrentAccess } from '../current-access.decorator';
import { holdsOnWholeTenant } from '../modules/adm/tenant-authority';
import { OperationId } from '../operation-id.decorator';
import { encodeCursor, parsePageRequest } from '../pagination';
import { CurrentTenant } from '../tenant-context.decorator';
import { VERIFICATION_REQUESTED_EVENT } from './channel-verification.consumer';

const MANAGE = PERMISSIONS.connectChannelAccount;
const READ = PERMISSIONS.get_resources_channel_account;
const ACCOUNT_RESOURCE = 'channel_account';

/** The accounts of the channels are the tenant's, not a unit's: who connects, verifies, changes or closes one holds the permission on the whole tenant, and so does who reads them. */
function assertHolds(access: EffectiveAccess, permission: string): void {
  if (!holdsOnWholeTenant(access, permission)) throw new DomainError('SCOPE_DENIED', 403);
}

function viewOf(row: ChannelAccountRecord): Schemas['ChannelAccount'] {
  return {
    id: row.id,
    channel: row.channel as Schemas['ChannelAccount']['channel'],
    external_account_id: row.externalAccountId,
    display_name: row.displayName,
    status: row.status,
    // The secrets are references into the vault and are not in an answer: the screen says that they are configured.
    credential_configured: true,
    webhook_configured: row.webhookConfigured,
    verified_at: row.verifiedAt,
    verify_requested_at: row.verifyRequestedAt,
    verification_error: row.verificationError,
    auto_reply_text: row.autoReplyText,
    calendar_code: row.calendarCode,
    daily_send_cap: row.dailySendCap,
    monthly_budget_vnd: row.monthlyBudgetVnd,
    created_at: row.createdAt,
    version: row.version,
  };
}

/**
 * The channel accounts (ST-OMNI-001, OMNI 3.7, BR-OMNI-02, BR-OMNI-04): an account is connected with references to its secrets, verified against the provider, changed and closed. Verification is asked for here (202) and
 * answered by `ChannelVerificationConsumer`, which calls the provider outside any transaction. Only an Active account sends, and only an Active account is a receiver of webhooks (the tenant of a webhook is the one of the
 * account it names, never the one in its payload). A secret is never in an answer, an audit row or an event.
 */
@Controller()
export class ChannelAccountsController {
  private readonly store = new ChannelAccountStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Get('resources/channel_account')
  @OperationId('get_resources_channel_account')
  async list(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Query('status') status?: unknown,
    @Query('channel') channel?: unknown,
    @Query('limit') limit?: unknown,
    @Query('cursor') cursor?: unknown,
  ): Promise<Schemas['ChannelAccountPage']> {
    assertHolds(access, READ);
    const request = parsePageRequest(limit, cursor);
    if (status !== undefined && (typeof status !== 'string' || !(ACCOUNT_STATUSES as readonly string[]).includes(status))) throw new DomainError('VALIDATION_FAILED', 422, 'status');
    if (channel !== undefined && (typeof channel !== 'string' || !(ACCOUNT_CHANNELS as readonly string[]).includes(channel))) throw new DomainError('VALIDATION_FAILED', 422, 'channel');
    const rows = await this.database.withTenant(tenant, (tx) => this.store.list(tx, { status: status as string | undefined, channel: channel as string | undefined }, { limit: request.limit + 1, after: request.after }));
    const shown = rows.slice(0, request.limit);
    const last = shown[shown.length - 1];
    return { items: shown.map(viewOf), next_cursor: rows.length > request.limit && last !== undefined ? encodeCursor({ code: last.sortKey, id: last.id }) : null, as_of: new Date().toISOString() };
  }

  @Get('resources/channel_account/:id')
  @OperationId('get_resources_channel_account_id')
  async get(@CurrentTenant() tenant: TenantContext, @CurrentAccess() access: EffectiveAccess, @Param('id', ParseUUIDPipe) id: string): Promise<Schemas['ChannelAccount']> {
    assertHolds(access, READ);
    const found = await this.database.withTenant(tenant, (tx) => this.store.find(tx, id.toLowerCase()));
    if (found === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return viewOf(found);
  }

  @Post('channel-accounts')
  @HttpCode(201)
  @OperationId('connectChannelAccount')
  @Command({ operation: 'connectChannelAccount' })
  async connect(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Body() body: Schemas['ChannelAccountConnect']): Promise<CommandResult> {
    assertHolds(access, MANAGE);
    const account = assertConnectable({
      channel: body.channel,
      externalAccountId: body.external_account_id,
      displayName: body.display_name,
      credentialSecretRef: body.credential_secret_ref,
      webhookSecretRef: body.webhook_secret_ref,
    });
    const created = await this.store.connect(scope.tx, account, scope.tenant.membershipId);
    await scope.audit({
      action: 'omni.channel_account_connected',
      resourceType: ACCOUNT_RESOURCE,
      resourceId: created.id,
      classification: 'CONFIDENTIAL',
      // The channel only: not the id the provider gave, and never a reference to a secret.
      diff: { channel: created.channel },
    });
    return commandResult(scope, 'PENDING_VERIFICATION', created.version, created.id);
  }

  @Post('channel-accounts/:channelAccountId/verify')
  @HttpCode(202)
  @OperationId('verifyChannelAccount')
  @Command({ operation: 'verifyChannelAccount', versioned: true })
  async verify(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('channelAccountId', ParseUUIDPipe) id: string, @Body() body: Schemas['ReasonOnly']): Promise<CommandResult> {
    assertHolds(access, MANAGE);
    const asked = await this.store.requestVerification(scope.tx, id.toLowerCase(), scope.expectedVersion ?? 0);
    await scope.audit({
      action: 'omni.channel_account_verification_requested',
      resourceType: ACCOUNT_RESOURCE,
      resourceId: asked.id,
      reason: body.reason,
      classification: 'CONFIDENTIAL',
      diff: { channel: asked.channel, from: asked.status },
    });
    await scope.emit({
      aggregateType: ACCOUNT_RESOURCE,
      aggregateId: asked.id,
      aggregateVersion: asked.version,
      type: VERIFICATION_REQUESTED_EVENT,
      schemaVersion: 1,
      payload: { tenant_id: scope.tenant.tenantId, channel_account_id: asked.id },
      eventKey: `${VERIFICATION_REQUESTED_EVENT}:${asked.id}:${asked.version}`,
    });
    return commandResult(scope, 'VERIFICATION_REQUESTED', asked.version, asked.id);
  }

  @Put('channel-accounts/:channelAccountId')
  @HttpCode(200)
  @OperationId('updateChannelAccount')
  @Command({ operation: 'updateChannelAccount', versioned: true })
  async update(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('channelAccountId', ParseUUIDPipe) id: string, @Body() body: Schemas['ChannelAccountUpdate']): Promise<CommandResult> {
    assertHolds(access, MANAGE);
    const changes = assertChanges(body);
    const updated = await this.store.update(scope.tx, id.toLowerCase(), scope.expectedVersion ?? 0, changes);
    await scope.audit({
      action: 'omni.channel_account_updated',
      resourceType: ACCOUNT_RESOURCE,
      resourceId: updated.id,
      reason: body.reason,
      classification: 'CONFIDENTIAL',
      // Which fields changed, not what the auto reply says.
      diff: { channel: updated.channel, fields: Object.keys(changes).sort() },
    });
    return commandResult(scope, updated.status.toUpperCase(), updated.version, updated.id);
  }

  @Post('channel-accounts/:channelAccountId/disable')
  @HttpCode(200)
  @OperationId('disableChannelAccount')
  @Command({ operation: 'disableChannelAccount', versioned: true })
  async disable(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('channelAccountId', ParseUUIDPipe) id: string, @Body() body: Schemas['ReasonOnly']): Promise<CommandResult> {
    assertHolds(access, MANAGE);
    const closed = await this.store.disable(scope.tx, id.toLowerCase(), scope.expectedVersion ?? 0);
    await scope.audit({
      action: 'omni.channel_account_disabled',
      resourceType: ACCOUNT_RESOURCE,
      resourceId: closed.id,
      reason: body.reason,
      classification: 'CONFIDENTIAL',
      diff: { channel: closed.channel },
    });
    await scope.emit({
      aggregateType: ACCOUNT_RESOURCE,
      aggregateId: closed.id,
      aggregateVersion: closed.version,
      type: 'omni.channel_account.disabled.v1',
      schemaVersion: 1,
      payload: { tenant_id: scope.tenant.tenantId, channel_account_id: closed.id, channel: closed.channel },
      eventKey: `omni.channel_account.disabled.v1:${closed.id}`,
    });
    return commandResult(scope, 'DISABLED', closed.version, closed.id);
  }
}
