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
  /** The e-mail address, telephone number or device reference the channel needs. For an answer in a conversation (ST-OMNI-005) it is the handle of the thread at the provider, which is also given as `threadId`: the address of a person is never stored. */
  to: string;
  /** The thread of the conversation at the provider, when the message is an answer in one: where the provider can answer without an address. */
  threadId?: string;
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
  /** A push is made for one tenant and one priority (the urgency header and the receipt of a web push depend on them). */
  tenantId?: string;
  priority?: string;
  /** Files that go with an e-mail (ENT-4d: the issued copy of a report form). An adapter of a channel that cannot carry a file answers a PERMANENT `ATTACHMENT_UNSUPPORTED` failure instead of dropping it; the SHA-256 is of the bytes, and is also in the text of the message. */
  attachments?: ChannelAttachment[];
}

export interface ChannelAttachment {
  fileName: string;
  mediaType: string;
  content: Uint8Array;
  sha256: string;
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

/** A message that a person sent to the tenant, as the provider wrote it, reduced to what the omnichannel center reads (ST-OMNI-004). */
export interface ParsedInboundMessage {
  /** The provider's own id of the event: the dedupe key of the inbox. */
  eventKey: string;
  eventType: string;
  /** The `external_account_id` of the channel account the message is for: the only way a tenant is found (the payload's own tenant is never trusted). */
  externalAccountId: string;
  /** The provider's id of the message: a message that comes twice is one. */
  providerMessageId: string;
  /** The thread the message belongs to at the provider: the conversation is found by it and the channel account. */
  externalThreadId: string;
  /** Who wrote it: the identity on the channel (a phone number, an address, a Zalo or WhatsApp id) and the name the provider gives, if it does. */
  sender: { externalId: string; displayName: string | undefined };
  text: string;
  occurredAt: Date;
}

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
  /** When the channel is closed for sending at the moment (the hours of a text message), the instant it opens again; undefined when it is open. The send is put back for then without being taken up. */
  closedUntil?(now: Date): Date | undefined;
  send(request: ChannelSendRequest): Promise<ChannelSendResult>;
  lookup(idempotencyKey: string): Promise<ChannelLookupResult>;
  /** Reads a callback body; undefined when it is not one the adapter understands. */
  parseCallback(rawBody: Buffer): ParsedChannelCallback | undefined;
  /** Reads the body of a message that came in; undefined when it is not one. A body is a receipt or a message, never both. */
  parseInbound?(rawBody: Buffer): ParsedInboundMessage | undefined;
}
