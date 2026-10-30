import { randomUUID } from 'node:crypto';
import { ConversationOutboundStore, ConversationStore, WORKER_MEMBERSHIP_ID } from '@machvon/db';
import type { AuditWriter, DeliveryEngine, InboxHandler } from '@machvon/db';
import { DomainError } from '@machvon/kernel';
import type { ChannelAdapterRegistry } from './channel-adapters';
import type { WebhookPayloadStore } from './webhook-support';

export interface CallbackHandlerDeps {
  adapters: ChannelAdapterRegistry;
  payloads: WebhookPayloadStore;
  engine: DeliveryEngine;
  audit: Pick<AuditWriter, 'recordInTx'>;
  conversations?: ConversationStore;
  outbound?: Pick<ConversationOutboundStore, 'applyReceipt'>;
}

/**
 * The adapter of the integration inbox for the events of one provider: the delivery receipts (of a notification, ST-NOT-002, or of a message an agent sent, ST-OMNI-005) and the messages that people write to the tenant (ST-OMNI-004). It reads the stored body of the event, and with the parser of the
 * provider's adapter either applies a receipt to the send through the monotonic reducer of KERNEL-1 or puts the message into its conversation. It runs in the transaction of the inbox processor, so what it wrote is undone when it fails, and a
 * failure costs the event an attempt (a receipt for a message id that is not known yet is tried again after 1, 5 and 30 minutes). The tenant is the one of the inbox row; the body is never trusted for it.
 */
export function channelCallbackHandler(provider: string, deps: CallbackHandlerDeps): InboxHandler {
  const conversations = deps.conversations ?? new ConversationStore();
  const outbound = deps.outbound ?? new ConversationOutboundStore();
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
    if (parsed !== undefined) {
      // A receipt for a message an agent sent in a conversation moves that message; one for anything else is a notification's.
      if ((await outbound.applyReceipt(tx, row.channel_account_id, parsed.providerMessageId, parsed.status)) !== 'UNKNOWN') return;
      await deps.engine.applyCallback(tx, {
        inboxId: delivery.id,
        channelAccountId: row.channel_account_id,
        providerMessageId: parsed.providerMessageId,
        status: parsed.status,
        occurredAt: parsed.occurredAt,
      });
      return;
    }
    const message = adapter.parseInbound?.(body);
    if (message === undefined) throw new DomainError('VALIDATION_FAILED', 422);
    const outcome = await conversations.receiveInbound(tx, {
      inboxId: delivery.id,
      channelAccountId: row.channel_account_id,
      providerMessageId: message.providerMessageId,
      externalThreadId: message.externalThreadId,
      sender: message.sender,
      text: message.text,
      occurredAt: message.occurredAt,
    });
    if (outcome.kind !== 'RECEIVED') return;
    const entry = (action: string, resourceType: string, resourceId: string, diff: Record<string, unknown>) =>
      deps.audit.recordInTx(tx, WORKER_MEMBERSHIP_ID, { action, resourceType, resourceId, diff, correlationId: randomUUID(), requestId: randomUUID() });
    if (outcome.created) await entry('conversation.opened', 'conversation', outcome.conversationId, { channel_account_id: row.channel_account_id, new_contact: outcome.newContact });
    else if (outcome.reopened) await entry('conversation.reopened', 'conversation', outcome.conversationId, { by: 'inbound_message' });
    // A consent a stop word ended is a decision of the person: it is told in the trail with the way it was taken.
    for (const consent of outcome.withdrawn) await entry('contact_consent.withdrawn', 'contact_consent', consent.id, { channel: consent.channel, purpose: consent.purpose, by: 'stop_keyword' });
  };
}
