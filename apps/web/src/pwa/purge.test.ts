import { describe, expect, it, vi } from 'vitest';
import { PURGE_MESSAGE } from './cache-policy';
import { purgeClientState } from './purge';
import { DEVICE_STORAGE_KEY } from './push-client';

function world(overrides: { keysFail?: boolean; unsubscribeFails?: boolean; hasSubscription?: boolean; noController?: boolean } = {}) {
  const names = ['mv-shell-b2', 'mv-static-b2', 'other'];
  const deleted: string[] = [];
  const post = vi.fn();
  const unsubscribe = vi.fn(() => (overrides.unsubscribeFails === true ? Promise.reject(new Error('push service')) : Promise.resolve(true)));
  const registration = { pushManager: { getSubscription: () => Promise.resolve(overrides.hasSubscription === false ? null : { unsubscribe }) } } as unknown as ServiceWorkerRegistration;
  const removed: string[] = [];
  const memory = vi.fn();
  return {
    deleted,
    post,
    unsubscribe,
    removed,
    memory,
    deps: {
      cacheStorage: { keys: () => (overrides.keysFail === true ? Promise.reject(new Error('no cache api')) : Promise.resolve(names)), delete: (name: string) => (deleted.push(name), Promise.resolve(true)) },
      container: { ready: Promise.resolve(registration), controller: overrides.noController === true ? null : { postMessage: post } } as unknown as ServiceWorkerContainer,
      storage: { removeItem: (key: string) => void removed.push(key) },
      clearMemory: memory,
    },
  };
}

describe('purge on logout or session expiry (R7)', () => {
  it('deletes every cache, tells the worker to drop its own, ends the push subscription, forgets the device and clears the memory of the page', async () => {
    const w = world();
    const report = await purgeClientState(w.deps);
    expect(w.deleted.sort()).toEqual(['mv-shell-b2', 'mv-static-b2', 'other']);
    expect(w.post).toHaveBeenCalledWith({ type: PURGE_MESSAGE });
    expect(w.unsubscribe).toHaveBeenCalledTimes(1);
    expect(w.removed).toEqual([DEVICE_STORAGE_KEY]);
    expect(w.memory).toHaveBeenCalledTimes(1);
    expect(report).toEqual({ caches: true, worker: true, push: true, device: true });
  });

  it('forgets the device record at once, before it waits for the caches, the worker or the push service (a worker that never gets ready must not hold it)', async () => {
    vi.useFakeTimers();
    try {
      const w = world();
      const neverReady = { ...w.deps, container: { ready: new Promise(() => undefined), controller: null } as unknown as ServiceWorkerContainer };
      const pending = purgeClientState(neverReady);
      // Nothing has been awaited yet: the record is already gone while the other steps are still running.
      expect(w.removed).toEqual([DEVICE_STORAGE_KEY]);
      await vi.advanceTimersByTimeAsync(2000);
      expect(await pending).toEqual({ caches: true, worker: false, push: false, device: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it('goes on with the other steps when one fails', async () => {
    const w = world({ keysFail: true, unsubscribeFails: true });
    const report = await purgeClientState(w.deps);
    expect(report).toEqual({ caches: false, worker: true, push: false, device: true });
    // The worker was still told, the device record still removed, the memory still cleared.
    expect(w.post).toHaveBeenCalled();
    expect(w.removed).toEqual([DEVICE_STORAGE_KEY]);
    expect(w.memory).toHaveBeenCalled();
  });

  it('is complete where there is no cache API, no worker and no storage', async () => {
    const report = await purgeClientState({ cacheStorage: undefined, container: undefined, storage: undefined });
    expect(report).toEqual({ caches: true, worker: false, push: false, device: false });
  });

  it('reports no push when there was no subscription, and no worker message when no worker controls the page', async () => {
    const w = world({ hasSubscription: false, noController: true });
    const report = await purgeClientState(w.deps);
    expect(report.push).toBe(false);
    expect(report.worker).toBe(false);
    expect(w.post).not.toHaveBeenCalled();
    expect(w.deleted).toHaveLength(3);
  });

  it('survives a memory that cannot be cleared', async () => {
    const w = world();
    w.memory.mockImplementation(() => {
      throw new Error('boom');
    });
    const report = await purgeClientState(w.deps);
    expect(report.caches).toBe(true);
    expect(w.deleted).toHaveLength(3);
  });
});
