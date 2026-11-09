import { PURGE_MESSAGE, purgeCacheNames } from './cache-policy';
import { DEVICE_STORAGE_KEY, unsubscribePush } from './push-client';

/** What a purge did, step by step; a step that failed is `false` and the others still ran. */
export interface PurgeReport {
  caches: boolean;
  worker: boolean;
  push: boolean;
  device: boolean;
}

export interface PurgeDeps {
  /** `caches` of the page; undefined where the browser has none. */
  cacheStorage: Pick<CacheStorage, 'keys' | 'delete'> | undefined;
  /** The service worker container, to tell the worker to drop what it holds and to find the push subscription. */
  container: Pick<ServiceWorkerContainer, 'ready' | 'controller'> | undefined;
  storage: Pick<Storage, 'removeItem'> | undefined;
  /** What else holds data of the person in the page (the query cache): cleared too. */
  clearMemory?(): void;
}

/**
 * Everything the installed application keeps on this device that belongs to a person or could show their data, dropped at logout and when the session
 * expires (R7): every cache of the origin (by the page, and by the worker, which is told with `mv:purge`), the push subscription at the push service,
 * the record of the registered device, and what the page holds in memory. Each step is tried on its own, so one that fails never stops the others.
 * The device record at the server is revoked before this, while the session can still ask (`signOutWithPurge`), and by the server itself when the session ends.
 */
export async function purgeClientState(deps: PurgeDeps): Promise<PurgeReport> {
  const report: PurgeReport = { caches: false, worker: false, push: false, device: false };
  try {
    deps.clearMemory?.();
  } catch {
    // Memory that cannot be cleared must not stop the rest.
  }
  try {
    // First and synchronous: the record of the device is the one step that must never wait for the worker or the push service (a worker that never
    // becomes ready holds the last step for seconds), so a person who is signed out is never seen with a device record still on the phone.
    deps.storage?.removeItem(DEVICE_STORAGE_KEY);
    report.device = deps.storage !== undefined;
  } catch {
    report.device = false;
  }
  try {
    if (deps.cacheStorage !== undefined) {
      const names = purgeCacheNames(await deps.cacheStorage.keys());
      await Promise.all(names.map((name) => deps.cacheStorage?.delete(name)));
    }
    report.caches = true;
  } catch {
    report.caches = false;
  }
  try {
    // The worker holds the caches too, and is the one that is asked to drop them when the page cannot reach the cache API.
    deps.container?.controller?.postMessage({ type: PURGE_MESSAGE });
    report.worker = deps.container?.controller != null;
  } catch {
    report.worker = false;
  }
  try {
    const registration = deps.container === undefined ? undefined : await Promise.race([deps.container.ready, new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 1500))]);
    report.push = await unsubscribePush(registration);
  } catch {
    report.push = false;
  }
  return report;
}
