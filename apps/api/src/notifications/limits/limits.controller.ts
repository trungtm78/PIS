import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Put, Query } from '@nestjs/common';
import { PERMISSIONS } from '@machvon/contracts';
import { ChannelAccountStore, DeliveryOverviewStore, TenantDatabase } from '@machvon/db';
import { DomainError, assertLimits } from '@machvon/kernel';
import type { EffectiveAccess, TenantContext } from '@machvon/kernel';
import { Command, Scope } from '../../command.decorator';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { CurrentAccess } from '../../current-access.decorator';
import { holdsOnWholeTenant } from '../../modules/adm/tenant-authority';
import { OperationId } from '../../operation-id.decorator';
import { CurrentTenant } from '../../tenant-context.decorator';

const MANAGE = PERMISSIONS.setChannelLimits;
const READ = PERMISSIONS.getDeliveryOverview;
const DAY_MS = 86_400_000;
/** The period of the overview: a day to ninety days, the last seven by default. */
const MAX_PERIOD_DAYS = 90;

function assertHolds(access: EffectiveAccess, permission: string): void {
  if (!holdsOnWholeTenant(access, permission)) throw new DomainError('SCOPE_DENIED', 403);
}

function instant(value: unknown, field: string): Date | undefined {
  if (value === undefined) return undefined;
  const date = typeof value === 'string' ? new Date(value) : undefined;
  if (date === undefined || Number.isNaN(date.getTime())) throw new DomainError('VALIDATION_FAILED', 422, field);
  return date;
}

/**
 * The cap and the budget of the channel accounts, and the overview of the delivery (ST-NOT-010, NOT-04, NOT-15, BR-NOT-13, BR-NOT-14). The limits are of the tenant's, not a unit's: who sets or reads them holds the
 * permission on the whole tenant. A limit never holds back a CRITICAL message; the overview shows the rate by the formula of the spec, with the unknown apart.
 */
@Controller()
export class ChannelLimitsController {
  private readonly accounts = new ChannelAccountStore();
  private readonly overview = new DeliveryOverviewStore();

  constructor(@Inject(TenantDatabase) private readonly database: TenantDatabase) {}

  @Put('channel-accounts/:channelAccountId/limits')
  @HttpCode(200)
  @OperationId('setChannelLimits')
  @Command({ operation: 'setChannelLimits', versioned: true })
  async setLimits(@Scope() scope: CommandScope, @CurrentAccess() access: EffectiveAccess, @Param('channelAccountId', ParseUUIDPipe) id: string, @Body() body: Schemas['ChannelLimits']): Promise<CommandResult> {
    assertHolds(access, MANAGE);
    const limits = assertLimits(body);
    const updated = await this.accounts.setLimits(scope.tx, id.toLowerCase(), scope.expectedVersion ?? 0, limits);
    await scope.audit({
      action: 'notification.channel_limits_set',
      resourceType: 'channel_account',
      resourceId: updated.id,
      reason: body.reason,
      classification: 'CONFIDENTIAL',
      // The channel and the limits: they are figures of the tenant's own budget, not a secret and not a reference to one.
      diff: { channel: updated.channel, daily_send_cap: updated.dailySendCap, monthly_budget_vnd: updated.monthlyBudgetVnd },
    });
    return commandResult(scope, updated.status.toUpperCase(), updated.version, updated.id);
  }

  @Get('delivery-overview')
  @OperationId('getDeliveryOverview')
  async read(
    @CurrentTenant() tenant: TenantContext,
    @CurrentAccess() access: EffectiveAccess,
    @Query('from') fromText?: unknown,
    @Query('to') toText?: unknown,
  ): Promise<Schemas['DeliveryOverview']> {
    assertHolds(access, READ);
    const asOf = new Date();
    const to = instant(toText, 'to') ?? asOf;
    const from = instant(fromText, 'from') ?? new Date(to.getTime() - 7 * DAY_MS);
    if (from.getTime() >= to.getTime() || to.getTime() - from.getTime() > MAX_PERIOD_DAYS * DAY_MS) throw new DomainError('VALIDATION_FAILED', 422, 'from');
    const { channels, accounts } = await this.database.withTenant(tenant, async (tx) => ({ channels: await this.overview.channels(tx, from, to), accounts: await this.overview.accounts(tx, asOf) }));
    return {
      from: from.toISOString(),
      to: to.toISOString(),
      as_of: asOf.toISOString(),
      channels: channels.map((channel) => ({
        channel: channel.channel,
        delivered: channel.delivered,
        read: channel.read,
        ended: channel.ended,
        suppressed: channel.suppressed,
        unknown: channel.unknown,
        failed: channel.failed,
        denominator: channel.denominator,
        delivered_rate: channel.deliveredRate ?? null,
      })),
      accounts: accounts.map((account) => ({
        channel_account_id: account.channelAccountId,
        channel: account.channel,
        display_name: account.displayName,
        status: account.status,
        daily_send_cap: account.dailySendCap,
        sent_today: account.sentToday,
        monthly_budget_vnd: account.monthlyBudgetVnd,
        spent_month_vnd: account.spentMonthVnd,
        held_by_limit: account.heldByLimit,
        version: account.version,
      })),
    };
  }
}
