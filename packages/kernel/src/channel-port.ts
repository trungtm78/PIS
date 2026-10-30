import type { AdapterStatus } from './connector.ts';
import type { ProviderSignatureScheme } from './provider-signature.ts';
import type { DeliveryStatus } from './delivery.ts';
import type { PushTarget } from './push-port.ts';

/**
 * The port between the delivery engine and one provider of one channel (ST-NOT-002, NOT 9). The engine owns the schedule, the retries, the
 * fallback and the status; an adapter only makes the call and says what happened, in the words below. The honest status of an adapter
 * (`AdapterStatus`) is a fact about the contract with the provider, not a setting.
 */

/** What an adapter is asked to send. The address is the recipient's own and lives in memory for the call only: it is never stored or logged. */
export interface ChannelSendRequest {
  /** `{notification_id}:{channel}:{attempt_no}`: a provider that supports idempotency keys sends once however often it is asked. */
  idempotencyKey: string;
  /** The e-mail address, telephone number or device reference the channel needs. */
  to: string;
  subject?: string;
  text: string;
  /** The external account id of the channel account (the sender identity at the provider). */
  accountId: string;
  /** A push goes to the devices of the recipient, each with the token read from the vault for this call (ST-NOT-007); `to` is not used then. */
  targets?: PushTarget[];
  /** The only link a push carries: opaque, naming the notification and nothing of what it is about. */
  deepLink?: string;
  /** A data message with no text, to make the app read again what changed (entitlements, access); never shown. */
  silent?: { what: string };
}

export type ChannelSendResult =
  /** The provider took the message; `providerMessageId` is what its callbacks will name. */
  | { kind: 'ACCEPTED'; providerMessageId: string; deadTargets?: string[] }
  /** The request was refused or never left: nothing was sent. A RETRYABLE failure is tried again; a PERMANENT one is not. */
  | { kind: 'FAILED'; failureClass: 'RETRYABLE' | 'PERMANENT'; errorCode: string; retryAfterSeconds?: number; deadTargets?: string[] }
  /** The request may have reached the provider but the answer was lost (a timeout after the request left): never sent again on its own. */
  | { kind: 'UNKNOWN'; errorCode: string };

/** What the provider says about a send it was asked about by its idempotency key. */
export type ChannelLookupResult =
  | { kind: 'FOUND'; status: Extract<DeliveryStatus, 'ACCEPTED' | 'DELIVERED' | 'READ' | 'FAILED'>; providerMessageId: string }
  /** The provider authoritatively has no such request: it can be sent again. */
  | { kind: 'NOT_FOUND' }
  /** The provider cannot tell (it keeps no idempotency keys, or it is down): the send stays Unknown. */
  | { kind: 'UNDETERMINED' };

/** A delivery receipt as the provider wrote it, reduced to what the engine reads. */
export interface ParsedChannelCallback {
  /** The provider's own id of the event: the dedupe key of the inbox. */
  eventKey: string;
  eventType: string;
  /** The `external_account_id` of the channel account the receipt is for: the only way a tenant is found (the payload's own tenant is never trusted). */
  externalAccountId: string;
  providerMessageId: string;
  status: DeliveryStatus;
  occurredAt: Date;
}

export interface ChannelAdapter {
  /** The name in `/webhooks/channels/{provider}`, in the inbox and in the status items. */
  readonly provider: string;
  /** The channel of `channel_account.channel` this adapter serves. */
  readonly channel: string;
  readonly status: AdapterStatus;
  /** A channel that costs money per message (SMS, ZNS, WhatsApp): its results are never guessed and its sends never repeated on a doubt. */
  readonly paid: boolean;
  /** How this provider signs its callbacks. */
  readonly signature: ProviderSignatureScheme;
  send(request: ChannelSendRequest): Promise<ChannelSendResult>;
  lookup(idempotencyKey: string): Promise<ChannelLookupResult>;
  /** Reads a callback body; undefined when it is not one the adapter understands. */
  parseCallback(rawBody: Buffer): ParsedChannelCallback | undefined;
}
