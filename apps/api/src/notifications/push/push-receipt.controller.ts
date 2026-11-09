import { Body, Controller, HttpCode, Inject, Optional, Post, Req } from '@nestjs/common';
import { TenantDatabase, WORKER_MEMBERSHIP_ID } from '@machvon/db';
import type { DeliveryEngine } from '@machvon/db';
import { DomainError, NOOP_METRICS } from '@machvon/kernel';
import type { MetricsSink, TenantContext } from '@machvon/kernel';
import { OperationId } from '../../operation-id.decorator';
import { Public } from '../../public.decorator';
import { IdentityCommand } from '../../session/identity.guard';
import { DELIVERY_ENGINE, NOT_METRICS } from '../delivery/tokens';
import { TenantRateLimiter } from './web-push-config';
import { verifyReceipt } from './web-push-receipt';

/** Injection token of the keys that verify the receipt of a web push (`receiptKeysFromEnv`). */
export const WEBPUSH_RECEIPT_KEYS = Symbol('WEBPUSH_RECEIPT_KEYS');
export const PUSH_ACKNOWLEDGED_METRIC = 'push_acknowledged_total';

const OPERATION = 'acknowledgePush';
const EVENTS: readonly string[] = ['SHOWN', 'CLICKED'];
/** Acknowledgements per minute from one client address: a device sends two for a notification, so this is far above any use and far below a flood. */
const PER_ADDRESS_PER_MINUTE = 120;

interface AddressedRequest {
  ip?: string;
}

/**
 * acknowledgePush (YCK.01, NOT-30): the device says that it showed a push (`SHOWN`) or that the person tapped it (`CLICKED`). The caller is a service worker,
 * which has no session, so the authority is the receipt token the push carried: a capability bound to one tenant, one notification and one device, signed with
 * the key of the deployment and valid for 48 hours (web-push-receipt.ts). The tenant is the one the token names, never one the body claims. The acknowledgement moves
 * the push send of the notification through the same monotonic reducer as a provider callback, so it is idempotent: a repeat, an event that arrives late and a
 * SHOWN after a CLICKED change nothing and are answered the same. The answer never says more than that the receipt was taken: it names no record.
 */
@Controller('push/receipts')
export class PushReceiptController {
  private readonly limiter = new TenantRateLimiter(PER_ADDRESS_PER_MINUTE);
  private readonly metrics: MetricsSink;

  constructor(
    @Inject(TenantDatabase) private readonly database: TenantDatabase,
    @Inject(DELIVERY_ENGINE) private readonly engine: DeliveryEngine,
    @Inject(WEBPUSH_RECEIPT_KEYS) private readonly keys: readonly string[],
    @Optional() @Inject(NOT_METRICS) metrics?: MetricsSink,
  ) {
    this.metrics = metrics ?? NOOP_METRICS;
  }

  @Post()
  @HttpCode(200)
  @Public()
  @OperationId(OPERATION)
  @IdentityCommand(OPERATION)
  async acknowledge(@Req() request: AddressedRequest, @Body() body: { receipt?: unknown; event?: unknown }): Promise<{ acknowledged: boolean }> {
    const taken = this.limiter.take(request.ip ?? 'unknown');
    if (!taken.ok) throw new DomainError('RATE_LIMIT', 429);
    if (typeof body?.receipt !== 'string' || typeof body.event !== 'string' || !EVENTS.includes(body.event)) throw new DomainError('VALIDATION_FAILED', 422, 'receipt');
    const verified = verifyReceipt(this.keys, body.receipt, Math.floor(Date.now() / 1000));
    if (!verified.ok) {
      this.metrics.increment(PUSH_ACKNOWLEDGED_METRIC, { event: body.event, outcome: verified.reason.toLowerCase() });
      throw new DomainError('SIGNATURE_INVALID', 401);
    }
    const { tenantId, notificationId, deviceId } = verified.receipt;
    const worker: TenantContext = { tenantId, membershipId: WORKER_MEMBERSHIP_ID, scopeVersion: 0 };
    const outcome = await this.database.withTenant(worker, (tx) => this.engine.acknowledgePush(tx, { notificationId, deviceId, event: body.event as 'SHOWN' | 'CLICKED', at: new Date() }));
    this.metrics.increment(PUSH_ACKNOWLEDGED_METRIC, { event: body.event as string, outcome: outcome.toLowerCase() });
    if (outcome === 'NOT_FOUND') throw new DomainError('RESOURCE_NOT_FOUND', 404);
    return { acknowledged: true };
  }
}
