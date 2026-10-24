import { Controller, Get, Inject, Param, ParseUUIDPipe } from '@nestjs/common';
import { ControlDatabase, MemberStore, UsageMeterStore, effectiveLimits } from '@machvon/db';
import { DomainError } from '@machvon/kernel';
import type { Schemas } from '../../contract-types';
import { OperationId } from '../../operation-id.decorator';
import { usageSummary } from './usage-view';

/** How many of the latest events the control plane sees beside the counters (the full list is the tenant's own read). */
export const RECENT_EVENTS = 20;

/**
 * The usage of one tenant for the Billing Operator and the System Admin (ST-SAS-010, SAS-11): the same counters, limits and seats the tenant sees,
 * and the latest events. The control plane reads the tenant tables inside a transaction that names the tenant (it reads no membership: the seats
 * come from a function that counts them), and writes none of them.
 */
@Controller('system/tenants')
export class UsageControlController {
  private readonly members = new MemberStore();

  constructor(
    @Inject(UsageMeterStore) private readonly usage: UsageMeterStore,
    @Inject(ControlDatabase) private readonly control: ControlDatabase,
  ) {}

  @Get(':tenantId/usage')
  @OperationId('getTenantUsage')
  async ofTenant(@Param('tenantId', ParseUUIDPipe) tenantId: string): Promise<Schemas['UsageSummary']> {
    const known = await this.control.withControl((tx) => tx.query<{ id: string }>('select id from machvon.tenant where id = $1::uuid', [tenantId]));
    if (known.length === 0) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const now = new Date();
    return this.control.withTenantOf(tenantId, async (tx) =>
      usageSummary({
        now,
        counters: await this.usage.countersAt(tx, now),
        limits: await effectiveLimits(tx, now),
        seats: await this.members.seatsInUse(tx),
        seatLimits: await this.members.seatLimits(tx),
        events: await this.usage.listEvents(tx, { limit: RECENT_EVENTS }),
      }),
    );
  }
}
