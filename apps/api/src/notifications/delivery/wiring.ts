import { DeliveryEngine } from '@machvon/db';
import type { AuditWriter, InboxHandlerRegistry } from '@machvon/db';
import { isProductionEnvironment } from '@machvon/kernel';
import type { MetricsSink } from '@machvon/kernel';
import { dedupeKeyOf } from '../dedupe';
import { channelCallbackHandler } from './callback-handler';
import { ChannelAdapterRegistry, inMemoryEmailAdapter } from './channel-adapters';
import type { WebhookPayloadStore } from './webhook-support';

/**
 * The adapters of the process. No real e-mail, SMS or Zalo provider exists yet (D06), so the honest default is none: every channel is MISSING and its sends are
 * suppressed with that reason. Outside production the in-memory e-mail adapter (MOCK) stands in so the whole path can be run and seen; it is never registered
 * where `MACHVON_ENVIRONMENT` is production, dr or not named.
 */
export function defaultChannelAdapters(environment: string | undefined): ChannelAdapterRegistry {
  return new ChannelAdapterRegistry(isProductionEnvironment(environment) ? [] : [inMemoryEmailAdapter()], environment);
}

export function createDeliveryEngine(audit: Pick<AuditWriter, 'recordInTx'>, metrics?: MetricsSink): DeliveryEngine {
  return new DeliveryEngine({ dedupeKeyOf, audit, ...(metrics === undefined ? {} : { metrics }) });
}

/** Registers the inbox adapter of every provider that has a channel adapter; a provider without one has its receipts wait as RECEIVED, never failed. */
export function registerChannelCallbacks(registry: InboxHandlerRegistry, adapters: ChannelAdapterRegistry, payloads: WebhookPayloadStore, engine: DeliveryEngine): string[] {
  const providers = adapters.providers();
  for (const provider of providers) registry.register(provider, channelCallbackHandler(provider, { adapters, payloads, engine }));
  return providers;
}
