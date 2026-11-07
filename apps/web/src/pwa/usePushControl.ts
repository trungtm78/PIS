import { useCallback, useEffect, useState } from 'react';
import { useApiClient } from '../api/ApiClientContext';
import { useTranslation } from '../i18n';
import { enablePush, hasPushSubscription, pushSupport, revokeDevice, unsubscribePush } from './push-client';
import type { PushSupport } from './push-client';

/** Where the person stands with push notifications on this device. */
export type PushControlState = 'checking' | Exclude<PushSupport, 'supported'> | 'blocked' | 'off' | 'on' | 'working' | 'failed';

export interface PushControlDeps {
  support: PushSupport;
  vapidPublicKey: string;
  /** The registration of the worker, or undefined when there is none (a development build, or the browser has no worker). */
  registration(): Promise<ServiceWorkerRegistration | undefined>;
  permission(): NotificationPermission;
  requestPermission(): Promise<NotificationPermission>;
  storage: Storage | undefined;
}

const REGISTRATION_WAIT_MS = 2000;

/** The deps of the real browser. */
export function browserPushDeps(): PushControlDeps {
  const env = import.meta.env as { VITE_WEBPUSH_VAPID_PUBLIC_KEY?: string };
  const container = typeof navigator === 'undefined' ? undefined : navigator.serviceWorker;
  let storage: Storage | undefined;
  try {
    storage = window.localStorage;
  } catch {
    storage = undefined;
  }
  return {
    support: typeof window === 'undefined' ? 'unsupported' : pushSupport(env, window, container),
    vapidPublicKey: env.VITE_WEBPUSH_VAPID_PUBLIC_KEY ?? '',
    // `ready` never settles when no worker is registered; the wait is bounded so the page says so instead of waiting.
    registration: async () => (container === undefined ? undefined : await Promise.race([container.ready, new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), REGISTRATION_WAIT_MS))])),
    permission: () => Notification.permission,
    requestPermission: () => Notification.requestPermission(),
    storage,
  };
}

/** The state of push on this device and the two actions of the person. Asking for the permission is always a tap: the browser refuses it otherwise. */
export function usePushControl(deps: PushControlDeps) {
  const client = useApiClient();
  const { locale } = useTranslation();
  const [state, setState] = useState<PushControlState>(deps.support === 'supported' ? 'checking' : deps.support);

  useEffect(() => {
    if (deps.support !== 'supported') {
      setState(deps.support);
      return undefined;
    }
    let live = true;
    void (async () => {
      const registration = await deps.registration();
      const subscribed = await hasPushSubscription(registration);
      if (!live) return;
      setState(deps.permission() === 'denied' ? 'blocked' : subscribed ? 'on' : 'off');
    })();
    return () => {
      live = false;
    };
  }, [deps]);

  const enable = useCallback(async () => {
    setState('working');
    const registration = await deps.registration();
    if (registration === undefined) {
      setState('failed');
      return;
    }
    const result = await enablePush({ client, vapidPublicKey: deps.vapidPublicKey, locale, registration, requestPermission: deps.requestPermission, storage: deps.storage });
    setState(result.kind === 'enabled' ? 'on' : result.kind === 'denied' ? 'blocked' : 'failed');
  }, [client, deps, locale]);

  const disable = useCallback(async () => {
    setState('working');
    // The server first, while the session can still ask; then the subscription at the push service.
    await revokeDevice(client, deps.storage, 'The person turned off push notifications on this device.');
    await unsubscribePush(await deps.registration());
    setState('off');
  }, [client, deps]);

  return { state, enable, disable };
}
