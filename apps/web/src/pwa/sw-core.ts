import {
  PURGE_MESSAGE,
  SHELL_DOCUMENT,
  SKIP_WAITING_MESSAGE,
  STATIC_CACHE_LIMIT,
  classifyRequest,
  isNeverCachedPath,
  purgeCacheNames,
  shellCacheName,
  shouldStoreStatic,
  staleCacheNames,
  staticCacheName,
  workerMessageOf,
} from './cache-policy';
import { isReceipt, notificationFromPush, receiptFromPush } from './push-payload';
import type { PushWords } from './push-payload';

/** What the build gives the worker. */
export interface ServiceWorkerOptions {
  /** A hash of the files of the shell: it changes whenever one of them does, so the bytes of the worker change and the browser installs the new one. */
  buildId: string;
  /** The files of the shell (`/index.html`, the entry script and style, the fonts); each is fetched at install. */
  precache: readonly string[];
  words: PushWords;
  /** The icon of a notification. */
  icon?: string;
  /** The base address of the API (`VITE_API_BASE_URL`, empty for the same origin): where the worker posts the receipt of a push. */
  apiBase?: string;
}

interface ExtendableEventLike {
  waitUntil(promise: Promise<unknown>): void;
}
export interface FetchEventLike extends ExtendableEventLike {
  request: Request;
  respondWith(response: Promise<Response> | Response): void;
}
/** What a device tells the server about a push: shown on the screen, or tapped by the person. */
export type PushReceiptEvent = 'SHOWN' | 'CLICKED';

export interface PushEventLike extends ExtendableEventLike {
  data: { text(): string } | null;
}
export interface NotificationClickEventLike extends ExtendableEventLike {
  notification: { close(): void; data?: unknown };
}
export interface MessageEventLike extends ExtendableEventLike {
  data: unknown;
}
interface WindowClientLike {
  url: string;
  focus(): Promise<unknown>;
  navigate?(url: string): Promise<unknown>;
}

/** The part of `ServiceWorkerGlobalScope` the worker uses, so that it can be run against a fake in a test. */
export interface ServiceWorkerScopeLike {
  addEventListener(type: string, listener: (event: never) => void): void;
  skipWaiting(): Promise<void>;
  clients: {
    claim(): Promise<void>;
    matchAll(options: { type: 'window'; includeUncontrolled: boolean }): Promise<readonly WindowClientLike[]>;
    openWindow(url: string): Promise<unknown>;
  };
  registration: { showNotification(title: string, options: NotificationOptions): Promise<void> };
  location: { origin: string };
  caches: CacheStorage;
  fetch(request: Request): Promise<Response>;
}

/** Deletes the oldest entries of a cache beyond the limit (the keys come back in the order they were stored). */
export async function trimCache(cache: Cache, limit: number): Promise<void> {
  const keys = await cache.keys();
  for (const key of keys.slice(0, Math.max(0, keys.length - limit))) await cache.delete(key);
}

/** Deletes every cache of the origin and says how many there were. */
export async function purgeAll(storage: CacheStorage): Promise<number> {
  const names = purgeCacheNames(await storage.keys());
  await Promise.all(names.map((name) => storage.delete(name)));
  return names.length;
}

type Listener<E> = (event: E) => void;
const asListener = <E>(listener: Listener<E>): ((event: never) => void) => listener as unknown as (event: never) => void;

/**
 * Installs the handlers of the worker on a scope:
 *  - install: the shell is fetched and stored; one file that cannot be fetched fails the install, and the worker that was running stays (a safe update).
 *    The new worker does not take over by itself: it waits until the person accepts the update (`mv:skip-waiting`) or every tab of the old one is closed.
 *  - activate: the caches of earlier builds are deleted.
 *  - fetch: see `classifyRequest`; the API, anything with a credential and anything that is not a GET to this origin is left to the browser.
 *  - message `mv:purge`: every cache is deleted (logout, session expired).
 *  - push: the notification is built by `notificationFromPush`: a generic title, a fixed sentence and a link, never what the server may have put besides.
 *  - notificationclick: the tab is focused and sent to the link, or one is opened.
 */
export function installServiceWorker(scope: ServiceWorkerScopeLike, options: ServiceWorkerOptions): void {
  const receiptUrl = (): string => new URL(`${(options.apiBase ?? '').replace(/\/+$/, '')}/push/receipts`, scope.location.origin).href;
  /**
   * Tells the server that the push was shown or tapped. The worker has no session, so the token the push carried is the authority; nothing else is sent (no title,
   * no link). It never blocks the notification: a lost answer is simply a missing receipt, and the ladder of the alert goes on to the next channel.
   */
  const acknowledge = async (receipt: string | undefined, event: PushReceiptEvent): Promise<boolean> => {
    if (receipt === undefined) return false;
    try {
      const response = await scope.fetch(
        new Request(receiptUrl(), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ receipt, event }), credentials: 'omit', keepalive: true }),
      );
      return response.ok;
    } catch {
      return false;
    }
  };
  const shellName = shellCacheName(options.buildId);
  const staticName = staticCacheName(options.buildId);

  scope.addEventListener(
    'install',
    asListener((event: ExtendableEventLike) => {
      event.waitUntil(
        (async () => {
          const cache = await scope.caches.open(shellName);
          // `reload` skips the HTTP cache, so the shell stored is the one of this build and not an older copy.
          await Promise.all(
            options.precache.map(async (path) => {
              const response = await scope.fetch(new Request(new URL(path, scope.location.origin).href, { cache: 'reload' }));
              if (!response.ok) throw new Error(`precache failed: ${path}`);
              // A host that redirects `/index.html` to `/` gives a redirected response, which a browser refuses to use for a page load: it is stored as a plain one.
              await cache.put(path, response.redirected ? new Response(await response.arrayBuffer(), { status: response.status, statusText: response.statusText, headers: response.headers }) : response);
            }),
          );
        })(),
      );
    }),
  );

  scope.addEventListener(
    'activate',
    asListener((event: ExtendableEventLike) => {
      event.waitUntil(
        (async () => {
          await Promise.all(staleCacheNames(await scope.caches.keys(), options.buildId).map((name) => scope.caches.delete(name)));
          await scope.clients.claim();
        })(),
      );
    }),
  );

  scope.addEventListener(
    'fetch',
    asListener((event: FetchEventLike) => {
      const request = event.request;
      const strategy = classifyRequest({
        url: request.url,
        method: request.method,
        mode: request.mode,
        hasAuthorization: request.headers.has('authorization'),
        origin: scope.location.origin,
      });
      if (strategy === 'network-only') return;
      if (strategy === 'shell-navigation') {
        event.respondWith(
          scope.fetch(request).catch(async () => {
            // No network: the shell, never a stored page of data. The screens say they are offline themselves.
            const shell = await (await scope.caches.open(shellName)).match(SHELL_DOCUMENT);
            return shell ?? Response.error();
          }),
        );
        return;
      }
      event.respondWith(
        (async () => {
          const staticCache = await scope.caches.open(staticName);
          const shellCache = await scope.caches.open(shellName);
          const stored = (await staticCache.match(request)) ?? (await shellCache.match(request));
          if (stored !== undefined) return stored;
          const response = await scope.fetch(request);
          if (shouldStoreStatic({ status: response.status, type: response.type, cacheControl: response.headers.get('cache-control'), contentType: response.headers.get('content-type'), setsCookie: response.headers.has('set-cookie') })) {
            await staticCache.put(request, response.clone());
            await trimCache(staticCache, STATIC_CACHE_LIMIT);
          }
          return response;
        })(),
      );
    }),
  );

  scope.addEventListener(
    'message',
    asListener((event: MessageEventLike) => {
      const message = workerMessageOf(event.data);
      if (message === PURGE_MESSAGE) event.waitUntil(purgeAll(scope.caches));
      else if (message === SKIP_WAITING_MESSAGE) event.waitUntil(scope.skipWaiting());
    }),
  );

  scope.addEventListener(
    'push',
    asListener((event: PushEventLike) => {
      const raw = event.data?.text();
      const shown = notificationFromPush(raw, options.words);
      const receipt = receiptFromPush(raw);
      event.waitUntil(
        (async () => {
          await scope.registration.showNotification(shown.title, {
            body: shown.body,
            ...(options.icon === undefined ? {} : { icon: options.icon, badge: options.icon }),
            tag: 'mv-push',
            data: { url: shown.url, ...(receipt === undefined ? {} : { rcpt: receipt }) },
          });
          await acknowledge(receipt, 'SHOWN');
        })(),
      );
    }),
  );

  scope.addEventListener(
    'notificationclick',
    asListener((event: NotificationClickEventLike) => {
      event.notification.close();
      const data = event.notification.data;
      const url = typeof data === 'object' && data !== null && typeof (data as { url?: unknown }).url === 'string' ? (data as { url: string }).url : '/m';
      // The link is checked again: a notification shown by an older worker or another page is not trusted either.
      const target = new URL(isNeverCachedPath(url) || !url.startsWith('/') ? '/m' : url, scope.location.origin).href;
      const receipt = typeof data === 'object' && data !== null && isReceipt((data as { rcpt?: unknown }).rcpt) ? (data as { rcpt: string }).rcpt : undefined;
      // The tap is told on its own: whether the window opens never depends on the answer.
      const told = acknowledge(receipt, 'CLICKED');
      event.waitUntil(
        (async () => {
          const windows = await scope.clients.matchAll({ type: 'window', includeUncontrolled: true });
          const open = windows.find((client) => new URL(client.url).origin === scope.location.origin);
          if (open !== undefined) {
            await open.focus();
            if (open.navigate !== undefined) await open.navigate(target);
          } else {
            await scope.clients.openWindow(target);
          }
          await told;
        })(),
      );
    }),
  );
}
