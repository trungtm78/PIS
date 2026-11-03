import { Controller, Get, Inject, Optional } from '@nestjs/common';
import { HomeChannelHealthStore, TenantDatabase } from '@machvon/db';
import type { TenantContext } from '@machvon/kernel';
import { OperationId } from '../../operation-id.decorator';
import { CurrentTenant } from '../../tenant-context.decorator';
import { HOME_CLOCK } from './tokens';

/**
 * The degraded-state banner of the home screen (ST-KERNEL-073, AC-2): the notification channels of the tenant whose circuit breaker is open, each with the time of its latest successful delivery. An empty
 * list means every channel is healthy. The answer names channels only (no account, no recipient), so every reader of HOME may see it; it is read at every load, because a banner that is cached is a banner that
 * says the wrong thing.
 */
@Controller()
export class ChannelHealthController {
  private readonly health = new HomeChannelHealthStore();
  private readonly clock: () => Date;

  constructor(
    @Inject(TenantDatabase) private readonly database: TenantDatabase,
    @Optional() @Inject(HOME_CLOCK) clock?: () => Date,
  ) {
    this.clock = clock ?? ((): Date => new Date());
  }

  @Get('home/channel-health')
  @OperationId('getHomeChannelHealth')
  async channelHealth(@CurrentTenant() tenant: TenantContext): Promise<Record<string, unknown>> {
    const degraded = await this.database.withTenant(tenant, (tx) => this.health.degraded(tx));
    return {
      channels: degraded.map((entry) => ({ channel: entry.channel, state: entry.state, open_since: entry.openSince, last_delivered_at: entry.lastDeliveredAt })),
      as_of: this.clock().toISOString(),
    };
  }
}
