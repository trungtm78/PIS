/**
 * The cache policy of the service worker, as pure functions (R7 of the eng review, YCK.01): the worker keeps the application shell and the static
 * assets of the build and nothing else. An API response, an answer that carries a person's data, a request that carries a credential, a request to
 * another origin, anything that is not a plain GET is never stored, never answered from a cache and never touched by the worker.
 */

/** Every cache this application creates starts with this prefix, so a purge and an update never touch a cache that belongs to something else. */
export const CACHE_PREFIX = 'mv-';
/** The shell: `index.html` and what the first screen needs, written at install from the list the build made. */
export const SHELL_CACHE_PREFIX = `${CACHE_PREFIX}shell-`;
/** The static assets met while using the application (screen chunks, fonts, icons); hashed by the build, so a stored file never goes stale. */
export const STATIC_CACHE_PREFIX = `${CACHE_PREFIX}static-`;

export const shellCacheName = (buildId: string): string => `${SHELL_CACHE_PREFIX}${buildId}`;
export const staticCacheName = (buildId: string): string => `${STATIC_CACHE_PREFIX}${buildId}`;

/** The most files kept in the static cache; the oldest go first. */
export const STATIC_CACHE_LIMIT = 300;

/** The path of the page that every navigation of the single-page application is answered with. */
export const SHELL_DOCUMENT = '/index.html';

/** Where the build puts what may be kept. Nothing the API answers is ever under one of them. */
export const STATIC_PATH_PREFIXES: readonly string[] = ['/assets/', '/fonts/', '/icons/'];
/** Files at the root that are static too. */
export const STATIC_ROOT_FILES: readonly string[] = ['/manifest.webmanifest', '/favicon.ico', '/favicon.svg'];
/** Paths that are the API or the sign-in, whatever the method: a navigation to one of them is never answered with the shell. */
export const NEVER_CACHE_PREFIXES: readonly string[] = ['/api/', '/v1/', '/resources/', '/me/', '/auth', '/oidc', '/.well-known/', '/sw.js'];

const STATIC_EXTENSION = /\.(?:js|mjs|css|woff2?|ttf|otf|svg|png|jpg|jpeg|webp|avif|gif|ico|webmanifest|map)$/i;
const STATIC_CONTENT_TYPE = /^(?:text\/(?:javascript|css)|application\/(?:javascript|x-javascript|manifest\+json)|font\/|application\/font-|application\/vnd\.ms-fontobject|image\/)/i;

export type Strategy = 'network-only' | 'shell-navigation' | 'static-asset';

/** What the worker knows of a request, from the `fetch` event. */
export interface RequestFacts {
  url: string;
  method: string;
  /** `Request.mode`: `navigate` for a page load. */
  mode?: string;
  /** True when the request carries an `Authorization` header: it is a call made on behalf of a person. */
  hasAuthorization?: boolean;
  /** The origin the worker is served from. */
  origin: string;
}

const startsWithAny = (path: string, prefixes: readonly string[]): boolean => prefixes.some((prefix) => path === prefix.replace(/\/$/, '') || path.startsWith(prefix));

export function isNeverCachedPath(path: string): boolean {
  return startsWithAny(path.toLowerCase(), NEVER_CACHE_PREFIXES);
}

export function isStaticPath(path: string): boolean {
  if (isNeverCachedPath(path)) return false;
  if (STATIC_ROOT_FILES.includes(path)) return true;
  return STATIC_PATH_PREFIXES.some((prefix) => path.startsWith(prefix)) && STATIC_EXTENSION.test(path);
}

/**
 * How the worker handles a request. Only a GET to its own origin, with no credential, is ever served by it: a page load is answered by the network
 * and, when there is none, by the stored shell (never by stored data); a file under the static prefixes is answered by the cache first. Everything
 * else is `network-only`: the worker does not call `respondWith` and the browser does what it would have done without a worker.
 */
export function classifyRequest(facts: RequestFacts): Strategy {
  if (facts.method.toUpperCase() !== 'GET') return 'network-only';
  if (facts.hasAuthorization === true) return 'network-only';
  let url: URL;
  try {
    url = new URL(facts.url);
  } catch {
    return 'network-only';
  }
  if (url.origin !== facts.origin) return 'network-only';
  if (isNeverCachedPath(url.pathname)) return 'network-only';
  if (facts.mode === 'navigate') return isStaticPath(url.pathname) ? 'network-only' : 'shell-navigation';
  return isStaticPath(url.pathname) ? 'static-asset' : 'network-only';
}

/** What the worker knows of an answer it may store. */
export interface ResponseFacts {
  status: number;
  /** `Response.type`: only `basic` (same origin) is stored; `opaque` hides what is inside. */
  type: string;
  cacheControl?: string | null;
  contentType?: string | null;
  /** True when the answer sets a cookie or varies by credential. */
  setsCookie?: boolean;
}

/**
 * Whether an answer to a static request may be stored: a complete, same-origin answer that is a file of a static kind and that its server did not
 * forbid keeping. A page of HTML is not one: a server that answers a missing file with the shell would otherwise put the shell where the file belongs.
 */
export function shouldStoreStatic(response: ResponseFacts): boolean {
  if (response.status !== 200 || response.type !== 'basic') return false;
  if (response.setsCookie === true) return false;
  if (/no-store|private/i.test(response.cacheControl ?? '')) return false;
  return STATIC_CONTENT_TYPE.test(response.contentType ?? '');
}

/** The caches to delete when a worker activates: ours (by prefix) that are not the two of this build. */
export function staleCacheNames(existing: readonly string[], buildId: string): string[] {
  const current = new Set([shellCacheName(buildId), staticCacheName(buildId)]);
  return existing.filter((name) => name.startsWith(CACHE_PREFIX) && !current.has(name));
}

/** The caches a purge deletes: every one of the origin. Nothing but this application is served from its origin, and a purge that missed one would leave a file behind. */
export function purgeCacheNames(existing: readonly string[]): string[] {
  return [...existing];
}

/** The message the page sends the worker to make it drop everything it holds (logout, session expiry). */
export const PURGE_MESSAGE = 'mv:purge';
/** The message the page sends a waiting worker to make it take over (the person accepted the update). */
export const SKIP_WAITING_MESSAGE = 'mv:skip-waiting';

export type WorkerMessage = typeof PURGE_MESSAGE | typeof SKIP_WAITING_MESSAGE;

/** A message of the page, or undefined when it is not one of the two. */
export function workerMessageOf(data: unknown): WorkerMessage | undefined {
  if (typeof data !== 'object' || data === null) return undefined;
  const type = (data as { type?: unknown }).type;
  return type === PURGE_MESSAGE || type === SKIP_WAITING_MESSAGE ? type : undefined;
}
