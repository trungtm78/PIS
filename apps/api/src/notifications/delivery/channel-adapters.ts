import { randomUUID } from 'node:crypto';
import { TIMESTAMPED_HMAC_SHA256, activationBlock } from '@machvon/kernel';
import type { AdapterStatus, ChannelAdapter, ChannelLookupResult, ChannelSendRequest, ChannelSendResult, DeliveryStatus, ParsedChannelCallback, ProviderSignatureScheme } from '@machvon/kernel';

/** Injection token of the registry of the channel adapters of the process. */
export const CHANNEL_ADAPTERS = Symbol('CHANNEL_ADAPTERS');

/**
 * The adapters of the process, by channel and by provider. A channel without an adapter is MISSING: the engine does not pretend to send on it. An
 * adapter whose honest status does not allow it where it runs (MOCK in production, PROPOSED anywhere) is also not used (`usable`).
 */
export class ChannelAdapterRegistry {
  private readonly byChannel = new Map<string, ChannelAdapter>();
  private readonly byProvider = new Map<string, ChannelAdapter>();

  constructor(
    adapters: readonly ChannelAdapter[],
    /** The deployment environment (`MACHVON_ENVIRONMENT`); one that is not named counts as production. */
    private readonly environment: string | undefined,
  ) {
    for (const adapter of adapters) {
      if (this.byChannel.has(adapter.channel)) throw new Error(`channel ${adapter.channel} already has an adapter`);
      if (this.byProvider.has(adapter.provider)) throw new Error(`provider ${adapter.provider} already has an adapter`);
      this.byChannel.set(adapter.channel, adapter);
      this.byProvider.set(adapter.provider, adapter);
    }
  }

  /** The adapter that serves a channel, usable or not. */
  forChannel(channel: string): ChannelAdapter | undefined {
    return this.byChannel.get(channel);
  }

  forProvider(provider: string): ChannelAdapter | undefined {
    return this.byProvider.get(provider);
  }

  /** The adapter that may send now, or undefined (none registered, or its status does not allow it here). */
  usable(channel: string): ChannelAdapter | undefined {
    const adapter = this.byChannel.get(channel);
    return adapter !== undefined && activationBlock(adapter.status, this.environment) === undefined ? adapter : undefined;
  }

  /** The status of the adapter of a channel, MISSING when there is none. */
  statusOf(channel: string): AdapterStatus {
    return this.byChannel.get(channel)?.status ?? 'MISSING';
  }

  providers(): string[] {
    return [...this.byProvider.keys()].sort();
  }
}

/** What a scripted answer of the in-memory adapter does. */
export type ScriptedSend = ChannelSendResult | 'THROW';

export interface InMemoryAdapterOptions {
  provider: string;
  channel: string;
  /** The honest status; an in-memory adapter is MOCK. */
  status?: AdapterStatus;
  paid?: boolean;
  signature?: ProviderSignatureScheme;
}

export interface SentMessage {
  idempotencyKey: string;
  accountId: string;
  subject: string | undefined;
  /** The address is kept so a test can see where a message would have gone; this adapter exists for tests and the development stack only. */
  to: string;
  text: string;
}

/**
 * The in-memory adapter (status MOCK): it records what a real provider would have been asked, answers with the script a test gave it and, when there
 * is none, accepts. It keeps an idempotency table like a provider that supports idempotency keys, so a repeated key is one message. Never wired where
 * messages must really be delivered: the registry refuses a MOCK adapter in production.
 */
export class InMemoryChannelAdapter implements ChannelAdapter {
  readonly provider: string;
  readonly channel: string;
  readonly status: AdapterStatus;
  readonly paid: boolean;
  readonly signature: ProviderSignatureScheme;
  /** Every request made, in order, including repeats of an idempotency key. */
  readonly requests: SentMessage[] = [];
  private readonly script: ScriptedSend[] = [];
  private readonly accepted = new Map<string, string>();
  private readonly known = new Map<string, DeliveryStatus>();
  /** What `lookup` answers for a key the adapter has no record of; a test sets it. */
  lookupOfUnknown: ChannelLookupResult = { kind: 'NOT_FOUND' };

  constructor(options: InMemoryAdapterOptions) {
    this.provider = options.provider;
    this.channel = options.channel;
    this.status = options.status ?? 'MOCK';
    this.paid = options.paid ?? false;
    this.signature = options.signature ?? TIMESTAMPED_HMAC_SHA256;
  }

  /** The next answers, one per request, then the default (accept). */
  enqueue(...results: ScriptedSend[]): void {
    this.script.push(...results);
  }

  /** The messages the provider holds, once per idempotency key. */
  get messages(): ReadonlyMap<string, string> {
    return this.accepted;
  }

  /** The message ids that a delivery callback of this provider would name, by idempotency key. */
  messageIdOf(idempotencyKey: string): string | undefined {
    return this.accepted.get(idempotencyKey);
  }

  /** Plants what the provider would hold about a request whose answer was lost: the message exists, or it does not. */
  holds(idempotencyKey: string, status: DeliveryStatus = 'ACCEPTED'): string {
    // A provider's message ids are unique for good, so two adapters of one process never hand out the same one.
    const id = this.accepted.get(idempotencyKey) ?? `mem-${this.provider}-${randomUUID()}`;
    this.accepted.set(idempotencyKey, id);
    this.known.set(idempotencyKey, status);
    return id;
  }

  send(request: ChannelSendRequest): Promise<ChannelSendResult> {
    this.requests.push({ idempotencyKey: request.idempotencyKey, accountId: request.accountId, subject: request.subject, to: request.to, text: request.text });
    const scripted = this.script.shift();
    if (scripted === 'THROW') return Promise.reject(new Error('adapter failure'));
    if (scripted !== undefined) return Promise.resolve(scripted);
    return Promise.resolve({ kind: 'ACCEPTED', providerMessageId: this.holds(request.idempotencyKey) });
  }

  lookup(idempotencyKey: string): Promise<ChannelLookupResult> {
    const status = this.known.get(idempotencyKey);
    const id = this.accepted.get(idempotencyKey);
    if (status === undefined || id === undefined) return Promise.resolve(this.lookupOfUnknown);
    if (status === 'SENDING' || status === 'UNCERTAIN') return Promise.resolve({ kind: 'UNDETERMINED' });
    return Promise.resolve({ kind: 'FOUND', status, providerMessageId: id });
  }

  /** `{"id": event id, "account": external account id, "message": provider message id, "status": status, "type": event type, "at": ISO time}`. */
  parseCallback(rawBody: Buffer): ParsedChannelCallback | undefined {
    let body: unknown;
    try {
      body = JSON.parse(rawBody.toString('utf8'));
    } catch {
      return undefined;
    }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined;
    const record = body as Record<string, unknown>;
    const { id, account, message, status, type, at } = record;
    if (typeof id !== 'string' || typeof account !== 'string' || typeof message !== 'string' || typeof status !== 'string') return undefined;
    if (!(['ACCEPTED', 'DELIVERED', 'READ', 'FAILED'] as string[]).includes(status)) return undefined;
    const occurredAt = typeof at === 'string' && !Number.isNaN(Date.parse(at)) ? new Date(at) : new Date();
    return {
      eventKey: id,
      eventType: typeof type === 'string' ? type : 'delivery.status',
      externalAccountId: account,
      providerMessageId: message,
      status: status as DeliveryStatus,
      occurredAt,
    };
  }
}

/** The e-mail adapter of the development stack and the tests: a domestic SMTP relay that does not exist yet (ST-NOT-002 assumption), so MOCK. */
export const SMTP_RELAY_PROVIDER = 'smtp-relay';

export function inMemoryEmailAdapter(): InMemoryChannelAdapter {
  return new InMemoryChannelAdapter({ provider: SMTP_RELAY_PROVIDER, channel: 'EMAIL', status: 'MOCK', paid: false });
}
