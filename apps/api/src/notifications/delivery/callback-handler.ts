import { WORKER_MEMBERSHIP_ID } from '@machvon/db';
import type { DeliveryEngine, InboxHandler } from '@machvon/db';
import { DomainError } from '@machvon/kernel';
import type { ChannelAdapterRegistry } from './channel-adapters';
import type { WebhookPayloadStore } from './webhook-support';

export interface CallbackHandlerDeps {
  adapters: ChannelAdapterRegistry;
  payloads: WebhookPayloadStore;
  engine: DeliveryEngine;
}

/**
 * The adapter of the integration inbox for the delivery receipts of one provider (ST-NOT-002): it reads the stored body of the receipt, takes the status
 * out of it with the parser of the provider's adapter and applies it to the send through the monotonic reducer of KERNEL-1. It runs in the transaction
 * of the inbox processor, so what it wrote is undone when it fails, and a failure costs the event an attempt (a receipt for a message id that is not
 * known yet is tried again after 1, 5 and 30 minutes). The tenant is the one of the inbox row; the body is never trusted for it.
 */
export function channelCallbackHandler(provider: string, deps: CallbackHandlerDeps): InboxHandler {
  return async (delivery, tx) => {
    const adapter = deps.adapters.forProvider(provider);
    if (adapter === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const [row] = await tx.query<{ tenant_id: string; channel_account_id: string | null }>(
      'select tenant_id, channel_account_id from machvon.integration_event_inbox where id = $1::uuid',
      [delivery.id],
    );
    if (row === undefined || row.channel_account_id === null) throw new DomainError('CHANNEL_ACCOUNT_UNKNOWN', 404);
    const body = await deps.payloads.read({ tenantId: row.tenant_id, membershipId: WORKER_MEMBERSHIP_ID, scopeVersion: 0 }, delivery.payloadReference);
    // A body the retention job has already removed cannot be applied: the event stays failed for an operator to see.
    if (body === undefined) throw new DomainError('RESOURCE_NOT_FOUND', 404);
    const parsed = adapter.parseCallback(body);
    if (parsed === undefined) throw new DomainError('VALIDATION_FAILED', 422);
    await deps.engine.applyCallback(tx, {
      inboxId: delivery.id,
      channelAccountId: row.channel_account_id,
      providerMessageId: parsed.providerMessageId,
      status: parsed.status,
      occurredAt: parsed.occurredAt,
    });
  };
}
