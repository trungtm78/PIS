import { Controller, Get, Inject, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { SubscriptionStore, TenantDatabase } from '@machvon/db';
import { DomainError } from '@machvon/kernel';
import type { TenantContext } from '@machvon/kernel';
import type { Schemas } from '../../contract-types';
import { OperationId } from '../../operation-id.decorator';
import { encodeCursor, parsePageRequest } from '../../pagination';
import { CurrentTenant } from '../../tenant-context.decorator';
import { subscriptionView } from './subscription-view';

/**
 * The subscriptions of the caller's own tenant (ST-SAS-008): whoever holds `subscription.read` (the owner and the billing viewer) lists them, the latest started
 * first, and reads one. The tenant plane has no privilege on the plan catalogue, so it sees the plan by its id; the control plane (SubscriptionController) shows the plans.
 */
@Controller('resources/subscription')
export class SubscriptionReadsController {
  constructor(
    @Inject(SubscriptionStore) private readonly store: SubscriptionStore,
    @Inject(TenantDatabase) private readonly tenants: TenantDatabase,
  ) {}

  @Get()
  @OperationId('get_resources_subscription')
  async list(@CurrentTenant() tenant: TenantContext, @Query('limit') limit?: unknown, @Query('cursor') cursor?: unknown): Promise<{ items: Array<Schemas['Subscription']>; next_cursor: string | null }> {
    const page = parsePageRequest(limit, cursor);
    const rows = await this.tenants.withTenant(tenant, (tx) => this.store.list(tx, { limit: page.limit + 1, after: page.after?.id }));
    const items = rows.slice(0, page.limit);
    const last = items[items.length - 1];
    return { items: items.map(subscriptionView), next_cursor: rows.length > page.limit && last !== undefined ? encodeCursor({ code: last.startedAt.toISOString(), id: last.id }) : null };
  }

  @Get(':id')
  @OperationId('get_resources_subscription_id')
  async get(@CurrentTenant() tenant: TenantContext, @Param('id', ParseUUIDPipe) id: string): Promise<Schemas['Subscription']> {
    const row = await this.tenants.withTenant(tenant, (tx) => this.store.find(tx, id));
    // A subscription of another tenant is indistinguishable from one that does not exist.
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return subscriptionView(row);
  }
}
