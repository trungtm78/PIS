import { Body, Controller, Get, Inject, Param, ParseUUIDPipe, Post, Query, Res } from '@nestjs/common';
import { MemberStore, TenantDatabase, UsageMeterStore, effectiveLimits } from '@machvon/db';
import { DomainError } from '@machvon/kernel';
import type { TenantContext } from '@machvon/kernel';
import { commandResult } from '../../command-result';
import type { CommandResult } from '../../command-result';
import { Command, Scope } from '../../command.decorator';
import type { CommandScope } from '../../command-scope';
import type { Schemas } from '../../contract-types';
import { OperationId } from '../../operation-id.decorator';
import { encodeCursor, parsePageRequest } from '../../pagination';
import { CurrentTenant } from '../../tenant-context.decorator';
import { eventView, usageSummary } from './usage-view';

const RESOURCE_TYPE = 'usage_meter_event';

type UsageSummary = Schemas['UsageSummary'];
type UsageEvent = Schemas['UsageEvent'];

/**
 * Usage metering on the tenant plane (ST-SAS-010, SAS-11). A system service writes events (`recordUsageEvent`, the internal plane: a service
 * account of the tenant holding `internal.usage.write`), a member with `subscription.read` reads what the month counted against the limits
 * (`getMyUsage`), and `usage_meter_event.read` lists the events themselves. An event is insert-only and the same `external_event_key` of a
 * meter is one event however often it is sent: the repeat answers 200 with the first event and adds nothing.
 */
@Controller()
export class UsageController {
  private readonly members = new MemberStore();

  constructor(
    @Inject(UsageMeterStore) private readonly usage: UsageMeterStore,
    @Inject(TenantDatabase) private readonly tenants: TenantDatabase,
  ) {}

  /** recordUsageEvent: 201 for the event that was recorded, 200 with the id of the first one for an event key that was recorded before. */
  @Post('internal/usage-events')
  @OperationId('recordUsageEvent')
  @Command({ operation: 'recordUsageEvent' })
  async record(@Scope() scope: CommandScope, @Body() body: Schemas['UsageEventRecord'], @Res({ passthrough: true }) response: { status(code: number): unknown }): Promise<CommandResult> {
    const recorded = await this.usage.record(scope.tx, {
      meter: body.meter,
      externalEventKey: body.external_event_key,
      quantity: body.quantity,
      unit: body.unit,
      occurredAt: new Date(body.occurred_at),
      sourceReference: body.source_reference,
      now: new Date(),
    });
    // Every command leaves an audit row; the repeat is told apart, because a sender that repeats its keys is worth knowing about.
    await scope.audit({
      action: recorded.replayed ? 'usage.event_deduplicated' : 'usage.event_recorded',
      resourceType: RESOURCE_TYPE,
      resourceId: recorded.eventId,
      diff: { meter: body.meter, counter: recorded.counter, ...(recorded.replayed ? {} : { quantity: body.quantity }) },
    });
    if (recorded.replayed) response.status(200);
    return commandResult(scope, recorded.replayed ? 'DEDUPLICATED' : 'RECORDED', 1, recorded.eventId);
  }

  /** getMyUsage: the counters of the month with their limits, and the seats. */
  @Get('me/usage')
  @OperationId('getMyUsage')
  async mine(@CurrentTenant() tenant: TenantContext): Promise<UsageSummary> {
    const now = new Date();
    return this.tenants.withTenant(tenant, async (tx) =>
      usageSummary({
        now,
        counters: await this.usage.countersAt(tx, now),
        limits: await effectiveLimits(tx, now),
        seats: await this.members.seatsInUse(tx),
        seatLimits: await this.members.seatLimits(tx),
      }),
    );
  }

  @Get('resources/usage_meter_event')
  @OperationId('get_resources_usage_meter_event')
  async list(@CurrentTenant() tenant: TenantContext, @Query('limit') limit?: unknown, @Query('cursor') cursor?: unknown): Promise<{ items: UsageEvent[]; next_cursor: string | null }> {
    const page = parsePageRequest(limit, cursor);
    const occurredAt = page.after === undefined ? undefined : new Date(page.after.code);
    if (occurredAt !== undefined && Number.isNaN(occurredAt.getTime())) throw new DomainError('VALIDATION_FAILED', 422, 'cursor');
    const rows = await this.tenants.withTenant(tenant, (tx) =>
      this.usage.listEvents(tx, { limit: page.limit + 1, after: page.after === undefined || occurredAt === undefined ? undefined : { occurredAt, id: page.after.id } }),
    );
    const items = rows.slice(0, page.limit);
    const last = items[items.length - 1];
    return { items: items.map(eventView), next_cursor: rows.length > page.limit && last !== undefined ? encodeCursor({ code: last.occurredAt.toISOString(), id: last.id }) : null };
  }

  @Get('resources/usage_meter_event/:id')
  @OperationId('get_resources_usage_meter_event_id')
  async get(@CurrentTenant() tenant: TenantContext, @Param('id', ParseUUIDPipe) id: string): Promise<UsageEvent> {
    const row = await this.tenants.withTenant(tenant, (tx) => this.usage.readEvent(tx, id));
    // An event of another tenant is indistinguishable from one that does not exist.
    if (row === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return eventView(row);
  }
}
