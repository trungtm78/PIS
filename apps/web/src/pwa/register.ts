import { SKIP_WAITING_MESSAGE } from './cache-policy';
import { pwaStore } from './pwa-state';

export const SERVICE_WORKER_URL = '/sw.js';
/** How often an open application asks the server whether there is a newer worker (a browser also asks on every navigation). */
export const UPDATE_CHECK_MS = 60 * 60_000;

/**
 * A worker is registered in a production build only, and only where the browser can run one: a secure context (HTTPS, or localhost) and the API.
 * A development build never registers one: a worker in front of the development server would serve stale modules and hide every change.
 */
export function serviceWorkerWanted(environment: { PROD: boolean }, secureContext: boolean, container: ServiceWorkerContainer | undefined): boolean {
  return environment.PROD && secureContext && container !== undefined;
}

export interface RegisterOptions {
  container: ServiceWorkerContainer;
  /** Called when a new worker is installed and waiting; `apply` takes it over. */
  onUpdateReady(apply: () => void): void;
  /** Reloads the page once the new worker has taken over (only after the person applied the update). */
  reload(): void;
  /** Asks again for a newer worker; the default is an interval and the page becoming visible. */
  schedule?(check: () => void): void;
}

/**
 * Registers the worker and watches for a newer one. A new worker installs in the background and waits: the page offers the update and the person takes
 * it when they are ready, because the reload that follows loses what is typed. Nothing reloads by itself.
 */
export async function registerServiceWorker(options: RegisterOptions): Promise<ServiceWorkerRegistration> {
  const { container } = options;
  // `none`: the script of the worker itself is never answered from the HTTP cache, so a new build is found at the next check.
  const registration = await container.register(SERVICE_WORKER_URL, { scope: '/', updateViaCache: 'none' });
  let applying = false;

  const announce = (worker: ServiceWorker | null): void => {
    // The first install has no controller yet: nothing is being replaced, so nothing is offered.
    if (worker === null || container.controller === null) return;
    options.onUpdateReady(() => {
      applying = true;
      worker.postMessage({ type: SKIP_WAITING_MESSAGE });
    });
  };

  if (registration.waiting !== null) announce(registration.waiting);
  registration.addEventListener('updatefound', () => {
    const installing = registration.installing;
    installing?.addEventListener('statechange', () => {
      if (installing.state === 'installed') announce(registration.waiting ?? installing);
    });
  });
  container.addEventListener('controllerchange', () => {
    if (applying) {
      applying = false;
      options.reload();
    }
  });

  const check = (): void => {
    void registration.update().catch(() => undefined);
  };
  if (options.schedule !== undefined) options.schedule(check);
  else {
    setInterval(check, UPDATE_CHECK_MS);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') check();
    });
  }
  return registration;
}

/** Registers the worker of this build in the page, wired to the shared state; a failure is swallowed (the application works without a worker). */
export function startServiceWorker(): void {
  const container = typeof navigator === 'undefined' ? undefined : navigator.serviceWorker;
  if (!serviceWorkerWanted(import.meta.env, typeof window !== 'undefined' && window.isSecureContext, container) || container === undefined) return;
  void registerServiceWorker({
    container,
    onUpdateReady: (apply) => pwaStore.updateReady(apply),
    reload: () => window.location.reload(),
  }).catch(() => undefined);
}
