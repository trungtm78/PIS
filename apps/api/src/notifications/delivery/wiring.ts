import { DeliveryEngine } from '@machvon/db';
import type { AuditWriter, InboxHandlerRegistry } from '@machvon/db';
import { TEAMS_OUTBOX_VARIABLE, isProductionEnvironment } from '@machvon/kernel';
import type { MetricsSink } from '@machvon/kernel';
import { dedupeKeyOf } from '../dedupe';
import { channelCallbackHandler } from './callback-handler';
import { PushChannelAdapter } from '../push/push-adapter';
import { MockPushProvider } from '../push/ports';
import { webPushDevelopmentAdapter, webPushProductionAdapters } from '../push/web-push-wiring';
import { ChannelAdapterRegistry, inMemoryEmailAdapter } from './channel-adapters';
import { smtpAdapterFromEnv } from './smtp-adapter';
import { SmsHoursAdapter } from './sms-adapter';
import { FileTeamsCardSink, TeamsOutboxChannelAdapter } from './teams-adapter';
import { teamsWebhookAdapterFromEnv } from './teams-webhook-adapter';
import type { WebhookPayloadStore } from './webhook-support';

/**
 * The adapters of the process. No real e-mail, SMS or Zalo provider exists yet (D06), so the honest default is none: every channel is MISSING and its sends are
 * suppressed with that reason. Outside production the in-memory e-mail adapter (MOCK) stands in so the whole path can be run and seen; it is never registered
 * where `MACHVON_ENVIRONMENT` is production, dr or not named.
 */
export function defaultChannelAdapters(environment: string | undefined, variables: Readonly<Record<string, string | undefined>> = process.env): ChannelAdapterRegistry {
  // The Teams channel (WF-1) hands its cards to an outbox directory a relay of the operator reads: it exists only where the directory is named, and where real data lives it is PROPOSED (never sends) until the relay is contracted.
  const teamsDirectory = variables[TEAMS_OUTBOX_VARIABLE];
  // A webhook of Teams (ENT-4c) posts the card itself and takes the channel when it is configured; the outbox stays for an operator who runs a relay.
  const webhook = teamsWebhookAdapterFromEnv(variables, environment);
  const teams = webhook !== undefined ? [webhook] : teamsDirectory === undefined || teamsDirectory === '' ? [] : [new TeamsOutboxChannelAdapter(new FileTeamsCardSink(teamsDirectory), isProductionEnvironment(environment) ? 'PROPOSED' : 'MOCK')];
  // The e-mail channel (ENT-4c): a real SMTP relay when one is configured; where real data lives it is PROPOSED (never sends) until the operator attests that the relay was verified. Without one, outside production, the in-memory stand-in.
  const smtp = smtpAdapterFromEnv(variables, environment);
  const email = smtp === undefined ? [] : [smtp];
  return new ChannelAdapterRegistry(
    isProductionEnvironment(environment)
<<<<<<< HEAD
      ? [...teams, ...webPushProductionAdapters(variables)]
=======
      ? [...teams, ...email]
>>>>>>> lane/ent4c
      : [
          ...teams,
          ...(smtp === undefined ? [inMemoryEmailAdapter()] : email),
          // PUSH_FCM serves Android and the web: a token that is a web subscription (the installed manager application, YCK.01) goes to the web provider, which is the
          // stand-in until the VAPID keys are configured; every other token to the native one.
          webPushDevelopmentAdapter(variables),
          new PushChannelAdapter('mock-apns', 'PUSH_APNS', new MockPushProvider()),
          new SmsHoursAdapter(),
        ],
    environment,
  );
}

export function createDeliveryEngine(audit: Pick<AuditWriter, 'recordInTx'>, metrics?: MetricsSink): DeliveryEngine {
  return new DeliveryEngine({ dedupeKeyOf, audit, ...(metrics === undefined ? {} : { metrics }) });
}

/** Registers the inbox adapter of every provider that has a channel adapter (receipts and messages that come in); a provider without one has its events wait as RECEIVED, never failed. */
export function registerChannelCallbacks(registry: InboxHandlerRegistry, adapters: ChannelAdapterRegistry, payloads: WebhookPayloadStore, engine: DeliveryEngine, audit: Pick<AuditWriter, 'recordInTx'>): string[] {
  const providers = adapters.providers();
  for (const provider of providers) registry.register(provider, channelCallbackHandler(provider, { adapters, payloads, engine, audit }));
  return providers;
}
