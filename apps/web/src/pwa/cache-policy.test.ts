import { OPERATIONS } from '@machvon/contracts';
import { describe, expect, it } from 'vitest';
import {
  CACHE_PREFIX,
  PURGE_MESSAGE,
  SKIP_WAITING_MESSAGE,
  classifyRequest,
  isNeverCachedPath,
  isStaticPath,
  purgeCacheNames,
  shellCacheName,
  shouldStoreStatic,
  staleCacheNames,
  staticCacheName,
  workerMessageOf,
} from './cache-policy';

const ORIGIN = 'https://pis.example.vn';
const get = (path: string, extra: Partial<Parameters<typeof classifyRequest>[0]> = {}) => classifyRequest({ url: `${ORIGIN}${path}`, method: 'GET', origin: ORIGIN, ...extra });

describe('cache policy (R7): the worker keeps the shell and the static assets, nothing else', () => {
  it('serves the files of the build from the static cache', () => {
    expect(get('/assets/index-abc123.js')).toBe('static-asset');
    expect(get('/assets/ApprovalQueueScreen-9f2.css')).toBe('static-asset');
    expect(get('/fonts/be-vietnam-pro-latin-400.woff2')).toBe('static-asset');
    expect(get('/icons/icon-192.png')).toBe('static-asset');
    expect(get('/manifest.webmanifest')).toBe('static-asset');
  });

  it('answers a page load with the network, and the shell when there is none', () => {
    for (const path of ['/', '/m', '/m/approvals', '/home/home-09', '/r/abcdefghijklmnop']) expect(get(path, { mode: 'navigate' })).toBe('shell-navigation');
  });

  it('never touches anything that is not a plain GET to its own origin', () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']) expect(classifyRequest({ url: `${ORIGIN}/assets/a.js`, method, origin: ORIGIN })).toBe('network-only');
    expect(classifyRequest({ url: 'https://api.example.vn/assets/a.js', method: 'GET', origin: ORIGIN })).toBe('network-only');
    expect(classifyRequest({ url: 'https://cdn.example.vn/fonts/a.woff2', method: 'GET', origin: ORIGIN })).toBe('network-only');
    expect(classifyRequest({ url: 'not a url', method: 'GET', origin: ORIGIN })).toBe('network-only');
  });

  it('never touches a request that carries a credential', () => {
    expect(get('/assets/a.js', { hasAuthorization: true })).toBe('network-only');
    expect(get('/m', { mode: 'navigate', hasAuthorization: true })).toBe('network-only');
  });

  it('never touches the API, the sign-in or the worker itself, whatever the mode', () => {
    for (const path of ['/api/resources/approval_task', '/v1/approval-tasks/1/decision', '/resources/approval_task', '/me/devices', '/me/staff-scores', '/staff-score-periods/1/lines', '/staff-score-lines/1', '/staff-score-lines/compare', '/auth/callback', '/oidc/token', '/.well-known/openid-configuration', '/sw.js']) {
      expect(get(path)).toBe('network-only');
      expect(get(path, { mode: 'navigate' })).toBe('network-only');
      expect(isNeverCachedPath(path)).toBe(true);
    }
  });

  it('does not treat a data file under a static prefix as static', () => {
    expect(get('/assets/data.json')).toBe('network-only');
    expect(get('/fonts/readme.html')).toBe('network-only');
    expect(isStaticPath('/assets/')).toBe(false);
  });

  it('never classifies a path of the contract as static or as the shell for a request that is not a page load, with or without the version prefix', () => {
    const paths = Object.values(OPERATIONS).map((operation) => operation.path.replace(/\{[^}]+\}/g, 'abc'));
    expect(paths.length).toBeGreaterThan(100);
    for (const path of paths) {
      for (const prefix of ['', '/v1']) {
        const full = `${prefix}${path}`;
        expect(get(full), full).toBe('network-only');
        expect(get(`${full}.js`), `${full}.js`).toBe('network-only');
      }
    }
  });

  it('judges an answer: stored only when complete, same origin, static by kind and not forbidden', () => {
    const ok = { status: 200, type: 'basic', contentType: 'text/javascript', cacheControl: 'public, max-age=31536000' };
    expect(shouldStoreStatic(ok)).toBe(true);
    expect(shouldStoreStatic({ ...ok, contentType: 'font/woff2' })).toBe(true);
    expect(shouldStoreStatic({ ...ok, contentType: 'image/png' })).toBe(true);
    expect(shouldStoreStatic({ ...ok, status: 404 })).toBe(false);
    expect(shouldStoreStatic({ ...ok, status: 206 })).toBe(false);
    expect(shouldStoreStatic({ ...ok, type: 'opaque' })).toBe(false);
    expect(shouldStoreStatic({ ...ok, type: 'cors' })).toBe(false);
    expect(shouldStoreStatic({ ...ok, cacheControl: 'no-store' })).toBe(false);
    expect(shouldStoreStatic({ ...ok, cacheControl: 'private, max-age=60' })).toBe(false);
    expect(shouldStoreStatic({ ...ok, setsCookie: true })).toBe(false);
    // The shell answered for a missing file, and data answered under a static path, are not kept.
    expect(shouldStoreStatic({ ...ok, contentType: 'text/html; charset=utf-8' })).toBe(false);
    expect(shouldStoreStatic({ ...ok, contentType: 'application/json' })).toBe(false);
    expect(shouldStoreStatic({ ...ok, contentType: null })).toBe(false);
  });

  it('names the caches by build and deletes only the older ones of this application when a worker activates', () => {
    const current = [shellCacheName('b2'), staticCacheName('b2')];
    const existing = [...current, shellCacheName('b1'), staticCacheName('b1'), 'workbox-other', 'mv-legacy'];
    expect(staleCacheNames(existing, 'b2').sort()).toEqual([shellCacheName('b1'), staticCacheName('b1'), 'mv-legacy'].sort());
    expect(current.every((name) => name.startsWith(CACHE_PREFIX))).toBe(true);
  });

  it('purges every cache of the origin, whoever named it', () => {
    expect(purgeCacheNames([shellCacheName('b2'), 'workbox-other', 'x'])).toEqual([shellCacheName('b2'), 'workbox-other', 'x']);
    expect(purgeCacheNames([])).toEqual([]);
  });

  it('reads the two messages of the page and nothing else', () => {
    expect(workerMessageOf({ type: PURGE_MESSAGE })).toBe(PURGE_MESSAGE);
    expect(workerMessageOf({ type: SKIP_WAITING_MESSAGE })).toBe(SKIP_WAITING_MESSAGE);
    for (const other of [null, undefined, 'mv:purge', 3, {}, { type: 'delete-everything' }, { type: 'mv:purge-all' }]) expect(workerMessageOf(other)).toBeUndefined();
  });
});
