import { PushChannelAdapter } from './push-adapter';
import { MockPushProvider } from './ports';
import type { PushProviderAnswer, PushProviderPort } from './ports';
import { WebAwarePushProvider, webPushProviderFromEnv } from './web-push';
import type { Environment } from './web-push-config';

/** The provider name of the web-push channel where real data lives. */
export const WEB_PUSH_PROVIDER = 'web-push';

/** Injection token of the web-push runtime of the process (the provider, its mode and the state of the channel). */
export const WEB_PUSH_RUNTIME = Symbol('WEB_PUSH_RUNTIME');
export type WebPushRuntime = ReturnType<typeof webPushProviderFromEnv>;

const runtimes = new WeakMap<object, WebPushRuntime>();

/**
 * The web-push runtime of an environment object: made once, so the channel adapter and the operations that send a test message share one sender (the stand-in records
 * both) and one limit per tenant. Callers that pass their own object get their own runtime.
 */
export function webPushRuntime(variables: Environment): WebPushRuntime {
  let runtime = runtimes.get(variables);
  if (runtime === undefined) {
    runtime = webPushProviderFromEnv(variables);
    runtimes.set(variables, runtime);
  }
  return runtime;
}

/**
 * The token of a native device where no native provider exists (FCM and APNs are not built): refused for good, but not revoked. A refusal that revoked would
 * delete the registration of an Android phone for a reason that is ours; the device stays registered for the day a native provider is.
 */
export class NoNativePushProvider implements PushProviderPort {
  async send(): Promise<PushProviderAnswer> {
    return { ok: false, code: 'NATIVE_PROVIDER_MISSING' };
  }
}

/** Outside production: the web provider is the real one when the keys are set (state `PENDING_SPIKE`, usable for the spike itself), else the stand-in; native tokens go to the stand-in. */
export function webPushDevelopmentAdapter(variables: Environment): PushChannelAdapter {
  return new PushChannelAdapter('mock-fcm', 'PUSH_FCM', new WebAwarePushProvider(new MockPushProvider(), webPushRuntime(variables).provider));
}

/**
 * In production: the web channel only when the operator has run the spike and said so (`MACHVON_WEBPUSH_SPIKE_VERIFIED=true`) with real keys. `MOCK` and
 * `PENDING_SPIKE` register nothing there, so a notification is never reported as sent by a channel nobody has seen deliver.
 */
export function webPushProductionAdapters(variables: Environment): PushChannelAdapter[] {
  const { provider, state } = webPushRuntime(variables);
  if (state !== 'VERIFIED') return [];
  return [new PushChannelAdapter(WEB_PUSH_PROVIDER, 'PUSH_FCM', new WebAwarePushProvider(new NoNativePushProvider(), provider), 'VERIFIED')];
}
