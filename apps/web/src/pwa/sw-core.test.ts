import { describe, expect, it, vi } from 'vitest';
import { PURGE_MESSAGE, SKIP_WAITING_MESSAGE, shellCacheName, staticCacheName } from './cache-policy';
import { installServiceWorker, purgeAll, trimCache } from './sw-core';
import type { FetchEventLike, MessageEventLike, NotificationClickEventLike, PushEventLike, ServiceWorkerScopeLike } from './sw-core';

const ORIGIN = 'https://pis.example.vn';
const ID = 'AbCdEfGhIjKlMnOpQrSt1234';
const WORDS = { appName: 'Hệ thống quản lý đầu tư công', body: 'Bạn có một thông báo mới. Mở để xem.' };
const keyOf = (request: Request | string): string => (typeof request === 'string' ? new URL(request, ORIGIN).href : request.url);

class FakeCache {
  readonly entries = new Map<string, Response>();
  put(request: Request | string, response: Response): Promise<void> {
    this.entries.set(keyOf(request), response);
    return Promise.resolve();
  }
  match(request: Request | string): Promise<Response | undefined> {
    return Promise.resolve(this.entries.get(keyOf(request))?.clone());
  }
  keys(): Promise<Request[]> {
    return Promise.resolve([...this.entries.keys()].map((url) => new Request(url)));
  }
  delete(request: Request | string): Promise<boolean> {
    return Promise.resolve(this.entries.delete(keyOf(request)));
  }
}

class FakeStorage {
  readonly caches = new Map<string, FakeCache>();
  open(name: string): Promise<FakeCache> {
    let cache = this.caches.get(name);
    if (cache === undefined) {
      cache = new FakeCache();
      this.caches.set(name, cache);
    }
    return Promise.resolve(cache);
  }
  keys(): Promise<string[]> {
    return Promise.resolve([...this.caches.keys()]);
  }
  delete(name: string): Promise<boolean> {
    return Promise.resolve(this.caches.delete(name));
  }
}

type Handler = (event: never) => void;

function setup(network: (request: Request) => Promise<Response>) {
  const handlers = new Map<string, Handler>();
  const storage = new FakeStorage();
  const fetched: string[] = [];
  const shown: Array<{ title: string; options: NotificationOptions }> = [];
  const windows: Array<{ url: string; focus: ReturnType<typeof vi.fn>; navigate: ReturnType<typeof vi.fn> }> = [];
  const opened: string[] = [];
  const scope: ServiceWorkerScopeLike = {
    addEventListener: (type, listener) => handlers.set(type, listener),
    skipWaiting: vi.fn(() => Promise.resolve()),
    clients: {
      claim: vi.fn(() => Promise.resolve()),
      matchAll: () => Promise.resolve(windows),
      openWindow: (url: string) => {
        opened.push(url);
        return Promise.resolve();
      },
    },
    registration: {
      showNotification: (title, options) => {
        shown.push({ title, options });
        return Promise.resolve();
      },
    },
    location: { origin: ORIGIN },
    caches: storage as unknown as CacheStorage,
    fetch: (request) => {
      fetched.push(request.url);
      return network(request);
    },
  };
  installServiceWorker(scope, { buildId: 'b2', precache: ['/index.html', '/assets/index-abc.js'], words: WORDS, icon: '/icons/icon-192.png' });
  const waits: Promise<unknown>[] = [];
  const dispatch = <E extends object>(type: string, event: E): E & { waits: Promise<unknown>[] } => {
    const full = { ...event, waitUntil: (promise: Promise<unknown>) => waits.push(promise) };
    (handlers.get(type) as (event: unknown) => void)(full);
    return Object.assign(full, { waits });
  };
  return { scope, storage, fetched, shown, windows, opened, dispatch, waits };
}

/** A response as a worker sees one from its own origin: `Response.type` is `basic` (a constructed response is `default`). */
const basic = (response: Response): Response => Object.defineProperty(response, 'type', { value: 'basic' });
const ok = (body: string, contentType: string, headers: Record<string, string> = {}): Response => basic(new Response(body, { status: 200, headers: { 'content-type': contentType, ...headers } }));

/** A fetch event; `respondWith` records what the worker answered, or stays unset when the worker left the request to the browser. */
function fetchEvent(url: string, init: { method?: string; mode?: RequestMode; headers?: Record<string, string> } = {}) {
  const request = new Request(url, { method: init.method ?? 'GET', headers: init.headers });
  Object.defineProperty(request, 'mode', { value: init.mode ?? 'cors' });
  const state: { answer?: Promise<Response> } = {};
  const event = { request, respondWith: (answer: Promise<Response> | Response) => (state.answer = Promise.resolve(answer)) } as unknown as FetchEventLike;
  return { event, state };
}

describe('the service worker (R7)', () => {
  it('stores the shell at install and fails the install when one file of it cannot be fetched', async () => {
    const good = setup((request) => Promise.resolve(ok(`body of ${request.url}`, 'text/html')));
    const event = good.dispatch('install', {});
    await Promise.all(event.waits);
    const shell = good.storage.caches.get(shellCacheName('b2'));
    expect([...(shell?.entries.keys() ?? [])].sort()).toEqual([`${ORIGIN}/assets/index-abc.js`, `${ORIGIN}/index.html`]);
    // Fetched past the HTTP cache, so the shell stored is the one of this build.
    expect(good.fetched).toHaveLength(2);

    const bad = setup((request) => Promise.resolve(request.url.endsWith('.js') ? new Response('gone', { status: 404 }) : ok('<html>', 'text/html')));
    await expect(Promise.all(bad.dispatch('install', {}).waits)).rejects.toThrow('precache failed');
  });

  it('stores a shell file that the host redirected as a plain response, which a page load may be answered with', async () => {
    const redirected = Object.defineProperty(ok('<html>shell</html>', 'text/html'), 'redirected', { value: true });
    const world = setup((request) => Promise.resolve(request.url.endsWith('/index.html') ? redirected : ok('x', 'text/javascript')));
    await Promise.all(world.dispatch('install', {}).waits);
    const stored = await world.storage.caches.get(shellCacheName('b2'))?.match('/index.html');
    expect(stored?.redirected).toBe(false);
    expect(await stored?.text()).toBe('<html>shell</html>');
  });

  it('does not take over by itself, and does when the person accepted the update', async () => {
    const world = setup(() => Promise.resolve(ok('x', 'text/html')));
    await Promise.all(world.dispatch('install', {}).waits);
    expect(world.scope.skipWaiting).not.toHaveBeenCalled();
    await Promise.all(world.dispatch('message', { data: { type: SKIP_WAITING_MESSAGE } } as Partial<MessageEventLike>).waits);
    expect(world.scope.skipWaiting).toHaveBeenCalledTimes(1);
  });

  it('deletes the caches of earlier builds when it activates, and keeps the two of this build and what is not its own', async () => {
    const world = setup(() => Promise.resolve(ok('x', 'text/html')));
    for (const name of [shellCacheName('b1'), staticCacheName('b1'), shellCacheName('b2'), staticCacheName('b2'), 'other-app']) await world.storage.open(name);
    await Promise.all(world.dispatch('activate', {}).waits);
    expect((await world.storage.keys()).sort()).toEqual([shellCacheName('b2'), staticCacheName('b2'), 'other-app'].sort());
    expect(world.scope.clients.claim).toHaveBeenCalled();
  });

  it('leaves the API, a credential, a write and another origin to the browser: no answer, nothing stored', async () => {
    const world = setup(() => Promise.resolve(ok('{"amount":"2500000000"}', 'application/json')));
    const cases: Array<[string, Parameters<typeof fetchEvent>[1]]> = [
      [`${ORIGIN}/v1/approval-tasks/1/decision`, {}],
      [`${ORIGIN}/api/resources/approval_task?mine=true`, {}],
      [`${ORIGIN}/resources/approval_task`, { headers: { authorization: 'Bearer t' } }],
      [`${ORIGIN}/assets/index-abc.js`, { method: 'POST' }],
      [`${ORIGIN}/assets/index-abc.js`, { headers: { authorization: 'Bearer t' } }],
      ['https://api.example.vn/assets/index-abc.js', {}],
      [`${ORIGIN}/v1/exports/1`, { mode: 'navigate' }],
    ];
    for (const [url, init] of cases) {
      const { event, state } = fetchEvent(url, init);
      world.dispatch('fetch', event);
      expect(state.answer, url).toBeUndefined();
    }
    expect(world.fetched).toEqual([]);
    expect(await world.storage.keys()).toEqual([]);
  });

  it('answers a file of the build from the cache after the first time, and stores only what the policy allows', async () => {
    let calls = 0;
    const world = setup(() => {
      calls += 1;
      return Promise.resolve(ok('console.log(1)', 'text/javascript'));
    });
    const run = async (url: string) => {
      const { event, state } = fetchEvent(url);
      world.dispatch('fetch', event);
      return (await state.answer)?.text();
    };
    expect(await run(`${ORIGIN}/assets/Screen-1.js`)).toBe('console.log(1)');
    expect(await run(`${ORIGIN}/assets/Screen-1.js`)).toBe('console.log(1)');
    expect(calls).toBe(1);
    expect([...(world.storage.caches.get(staticCacheName('b2'))?.entries.keys() ?? [])]).toEqual([`${ORIGIN}/assets/Screen-1.js`]);
  });

  it('does not store the shell answered for a missing file, a no-store answer or an answer of another type', async () => {
    const answers = new Map<string, Response>([
      ['/assets/missing.js', ok('<!doctype html>', 'text/html')],
      ['/assets/secret.js', ok('x', 'text/javascript', { 'cache-control': 'no-store' })],
      ['/assets/data.js', ok('{}', 'application/json')],
      ['/assets/gone.js', basic(new Response('nope', { status: 404, headers: { 'content-type': 'text/javascript' } }))],
    ]);
    const world = setup((request) => Promise.resolve(answers.get(new URL(request.url).pathname) as Response));
    for (const path of answers.keys()) {
      const { event, state } = fetchEvent(`${ORIGIN}${path}`);
      world.dispatch('fetch', event);
      await state.answer;
    }
    expect([...(world.storage.caches.get(staticCacheName('b2'))?.entries.keys() ?? [])]).toEqual([]);
  });

  it('answers a page load with the network and, with no network, with the stored shell and never with stored data', async () => {
    let online = true;
    const world = setup((request) => (online ? Promise.resolve(ok(`network ${new URL(request.url).pathname}`, 'text/html')) : Promise.reject(new TypeError('offline'))));
    await Promise.all(world.dispatch('install', {}).waits);
    const load = async (path: string) => {
      const { event, state } = fetchEvent(`${ORIGIN}${path}`, { mode: 'navigate' });
      world.dispatch('fetch', event);
      return state.answer;
    };
    expect(await (await load('/m/approvals'))?.text()).toBe('network /m/approvals');
    online = false;
    // The shell, which is the page and nothing of a person: the same for every path.
    expect(await (await load('/m/approvals'))?.text()).toBe('network /index.html');
    expect(await (await load('/m/dashboard'))?.text()).toBe('network /index.html');
    // Nothing the person saw while online was kept: the stored pages are the shell files of the install.
    const kept = [...(world.storage.caches.get(shellCacheName('b2'))?.entries.keys() ?? [])];
    expect(kept.some((url) => url.includes('/m/'))).toBe(false);
  });

  it('deletes every cache when the page asks for a purge', async () => {
    const world = setup(() => Promise.resolve(ok('x', 'text/javascript')));
    for (const name of [shellCacheName('b2'), staticCacheName('b2'), 'other-app']) await (await world.storage.open(name)).put('/x', ok('x', 'text/plain'));
    await Promise.all(world.dispatch('message', { data: { type: PURGE_MESSAGE } } as Partial<MessageEventLike>).waits);
    expect(await world.storage.keys()).toEqual([]);
  });

  it('ignores a message that is not one of its two', async () => {
    const world = setup(() => Promise.resolve(ok('x', 'text/plain')));
    await world.storage.open(shellCacheName('b2'));
    await Promise.all(world.dispatch('message', { data: { type: 'anything' } } as Partial<MessageEventLike>).waits);
    expect(await world.storage.keys()).toHaveLength(1);
    expect(world.scope.skipWaiting).not.toHaveBeenCalled();
  });

  it('shows a push as the generic title, the fixed sentence and the link, with nothing else of the data', async () => {
    const world = setup(() => Promise.resolve(ok('x', 'text/plain')));
    const data = JSON.stringify({ v: 1, title: 'Duyệt 2.500.000.000 đồng của Nguyễn Văn A', body: 'Chi tiết hợp đồng HD-2027-001', url: `/r/${ID}`, amount: 2500000000 });
    await Promise.all(world.dispatch('push', { data: { text: () => data } } as Partial<PushEventLike>).waits);
    expect(world.shown).toHaveLength(1);
    const { title, options } = world.shown[0] as (typeof world.shown)[number];
    expect(title).toBe(WORDS.appName);
    expect(options.body).toBe(WORDS.body);
    expect(options.data).toEqual({ url: `/r/${ID}` });
    expect(JSON.stringify(world.shown)).not.toMatch(/2\.?500|Nguyễn|HD-2027|amount/);
  });

  it('shows a push that has no data as the product name and the start page', async () => {
    const world = setup(() => Promise.resolve(ok('x', 'text/plain')));
    await Promise.all(world.dispatch('push', { data: null } as Partial<PushEventLike>).waits);
    expect(world.shown[0]?.title).toBe(WORDS.appName);
    expect(world.shown[0]?.options.data).toEqual({ url: '/m' });
  });

  it('takes the tap on a notification to the link: the open tab is focused and sent there, or a tab is opened', async () => {
    const world = setup(() => Promise.resolve(ok('x', 'text/plain')));
    const close = vi.fn();
    await Promise.all(world.dispatch('notificationclick', { notification: { close, data: { url: `/r/${ID}` } } } as Partial<NotificationClickEventLike>).waits);
    expect(close).toHaveBeenCalled();
    expect(world.opened).toEqual([`${ORIGIN}/r/${ID}`]);

    const focus = vi.fn(() => Promise.resolve());
    const navigate = vi.fn(() => Promise.resolve());
    world.windows.push({ url: `${ORIGIN}/m`, focus, navigate });
    await Promise.all(world.dispatch('notificationclick', { notification: { close, data: { url: '/m/approvals' } } } as Partial<NotificationClickEventLike>).waits);
    expect(focus).toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith(`${ORIGIN}/m/approvals`);
  });

  it('checks the link of a notification again: a link of the API or another origin opens the start page', async () => {
    for (const url of ['/v1/exports/1', 'https://evil.example/x', 'javascript:alert(1)', undefined]) {
      const world = setup(() => Promise.resolve(ok('x', 'text/plain')));
      await Promise.all(world.dispatch('notificationclick', { notification: { close: vi.fn(), data: url === undefined ? {} : { url } } } as Partial<NotificationClickEventLike>).waits);
      expect(world.opened, String(url)).toEqual([`${ORIGIN}/m`]);
    }
  });

  it('trims the static cache to its limit, oldest first, and purges everything with the count', async () => {
    const storage = new FakeStorage();
    const cache = await storage.open('mv-static-b2');
    for (const n of [1, 2, 3, 4]) await cache.put(`/assets/${n}.js`, ok('x', 'text/javascript'));
    await trimCache(cache as unknown as Cache, 2);
    expect([...cache.entries.keys()]).toEqual([`${ORIGIN}/assets/3.js`, `${ORIGIN}/assets/4.js`]);
    await storage.open('another');
    expect(await purgeAll(storage as unknown as CacheStorage)).toBe(2);
    expect(await storage.keys()).toEqual([]);
  });
});
