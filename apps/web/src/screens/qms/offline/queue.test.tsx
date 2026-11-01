import { act, cleanup, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { onlineManager } from '@tanstack/react-query';
import { TENANT, mount } from '../../ctr/test-support';
import { client, world } from '../diary/test-support';
import { useOfflineQueue } from './hooks';
import type { OfflineQueue } from './hooks';
import type { QueuedDiary } from './model';
import { queueKey } from './store';
import { ENGINEER, OWN_KEY, PENDING_ENTRY, heldLocks, setOnline, stored } from './test-support';

const D1 = { ...PENDING_ENTRY, clientOperationId: '00000000-0000-4000-8000-0000000000d1', recordDate: '2026-10-21' } as QueuedDiary;
const D2 = { ...PENDING_ENTRY, clientOperationId: '00000000-0000-4000-8000-0000000000d2', recordDate: '2026-10-22' } as QueuedDiary;
const ids = (queue: OfflineQueue): string[] => queue.items.map((item) => item.clientOperationId);
const storageEvent = (key: string | null): void => {
  act(() => {
    window.dispatchEvent(new StorageEvent('storage', { key }));
  });
};

/** One tab of the screen: a view of the queue of the device, kept by its own hook. */
function Tab({ name, tabs }: { name: string; tabs: Record<string, OfflineQueue> }) {
  tabs[name] = useOfflineQueue();
  return null;
}

function open(options: { entries?: QueuedDiary[]; single?: boolean; command?: (operation: string, input: unknown) => unknown } = {}) {
  if (options.entries !== undefined) globalThis.localStorage.setItem(OWN_KEY, JSON.stringify(options.entries));
  const tabs: Record<string, OfflineQueue> = {};
  const h = client(world(), options.command);
  mount(
    <>
      <Tab name="a" tabs={tabs} />
      {options.single === true ? null : <Tab name="b" tabs={tabs} />}
    </>,
    h,
    { permissions: ENGINEER },
  );
  return { tabs, h };
}

beforeEach(() => globalThis.localStorage.clear());
afterEach(() => {
  Reflect.deleteProperty(navigator, 'locks');
  cleanup();
  vi.restoreAllMocks();
  globalThis.localStorage.clear();
  onlineManager.setOnline(true);
});

/** The Web Locks of a browser, as far as the queue needs them: a request waits for the ones before it, so that the steps under one name never overlap. */
function serializingLocks(): void {
  let tail: Promise<unknown> = Promise.resolve();
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: {
      request: (_name: string, run: () => unknown) => {
        const done = tail.then(() => run());
        tail = done.catch(() => undefined);
        return done;
      },
    },
  });
}

/** The other tab acts while this one has read the queue and not yet written it back: `trigger` runs at the first read of the queue. */
function otherTabActsAfterTheRead(trigger: () => Promise<unknown>): Array<Promise<unknown>> {
  const original = Storage.prototype.getItem;
  const started: Array<Promise<unknown>> = [];
  let fired = false;
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, key: string) {
    const value = original.call(this, key);
    // The other tab reads the queue itself while it acts, so the flag is set before it is started, not after.
    if (key === OWN_KEY && !fired) {
      fired = true;
      started.push(trigger());
    }
    return value;
  });
  return started;
}

describe('the queue of the device seen by two tabs of the same membership', () => {
  it('keeps the diaries of both tabs, takes only the diary asked for, and lets each tab follow the others by the storage event', async () => {
    setOnline(false);
    const { tabs } = open();
    await act(async () => void (await tabs.a?.enqueue(D1)));
    expect(tabs.b?.items).toEqual([]);
    await act(async () => void (await tabs.b?.enqueue(D2)));
    expect(stored().map((entry) => entry.clientOperationId)).toEqual([D1.clientOperationId, D2.clientOperationId]);
    expect(ids(tabs.b as OfflineQueue)).toEqual([D1.clientOperationId, D2.clientOperationId]);
    expect(ids(tabs.a as OfflineQueue)).toEqual([D1.clientOperationId]);
    storageEvent(OWN_KEY);
    expect(ids(tabs.a as OfflineQueue)).toEqual([D1.clientOperationId, D2.clientOperationId]);
    await act(async () => tabs.a?.remove(D1.clientOperationId));
    expect(stored().map((entry) => entry.clientOperationId)).toEqual([D2.clientOperationId]);
    expect(ids(tabs.b as OfflineQueue)).toEqual([D1.clientOperationId, D2.clientOperationId]);
    storageEvent(OWN_KEY);
    expect(ids(tabs.b as OfflineQueue)).toEqual([D2.clientOperationId]);
  });

  it('queues a diary once however many times the same operation is queued, and ignores the storage events of other keys', async () => {
    setOnline(false);
    const { tabs } = open();
    await act(async () => void (await tabs.a?.enqueue(D1)));
    await act(async () => void (await tabs.b?.enqueue(D1)));
    expect(stored()).toHaveLength(1);
    globalThis.localStorage.setItem(OWN_KEY, JSON.stringify([D1, D2]));
    storageEvent(`${queueKey(TENANT.id, 'someone-else')}`);
    expect(ids(tabs.a as OfflineQueue)).toEqual([D1.clientOperationId]);
    storageEvent(null);
    expect(ids(tabs.a as OfflineQueue)).toEqual([D1.clientOperationId, D2.clientOperationId]);
  });

  it('keeps both diaries when two tabs queue at the same moment, because the reading, the change and the writing are one step under the lock of the queue', async () => {
    setOnline(false);
    serializingLocks();
    const { tabs } = open();
    let other: Promise<unknown> = Promise.resolve();
    const started = otherTabActsAfterTheRead(() => (other = tabs.b?.enqueue(D2) ?? Promise.resolve()));
    await act(async () => {
      expect(await tabs.a?.enqueue(D1)).toBe('ok');
      await Promise.all([...started, other]);
    });
    expect(stored().map((entry) => entry.clientOperationId)).toEqual([D1.clientOperationId, D2.clientOperationId]);
  });

  it('loses a diary in that same interleaving where the browser has no Web Locks, which is why the lock is used where there is one', async () => {
    setOnline(false);
    Reflect.deleteProperty(navigator, 'locks');
    const { tabs } = open();
    let other: Promise<unknown> = Promise.resolve();
    const started = otherTabActsAfterTheRead(() => (other = tabs.b?.enqueue(D2) ?? Promise.resolve()));
    await act(async () => {
      expect(await tabs.a?.enqueue(D1)).toBe('ok');
      await Promise.all([...started, other]);
    });
    expect(stored().map((entry) => entry.clientOperationId)).toEqual([D1.clientOperationId]);
  });

  it('does not send a diary that another tab removed after this send took its list, and sends the ones that are still there', async () => {
    const D3 = { ...PENDING_ENTRY, clientOperationId: '00000000-0000-4000-8000-0000000000d3', recordDate: '2026-10-23' } as QueuedDiary;
    let release: () => void = () => undefined;
    let calls = 0;
    const { tabs, h } = open({
      entries: [D1, D2, D3],
      single: true,
      command: () => {
        calls += 1;
        return calls === 1 ? new Promise((resolve) => (release = () => resolve({}))) : {};
      },
    });
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    globalThis.localStorage.setItem(OWN_KEY, JSON.stringify([D1, D3]));
    storageEvent(OWN_KEY);
    await act(async () => release());
    await waitFor(() => expect(stored()).toEqual([]));
    const sentIds = h.command.mock.calls.map(([, input]) => (input as { body: { client_operation_id: string } }).body.client_operation_id);
    expect(sentIds).toEqual([D1.clientOperationId, D3.clientOperationId]);
    expect(tabs.a?.items).toEqual([]);
  });

  it('sends nothing once the screen is left while the tab waits for the lock to claim a diary', async () => {
    const locks = heldLocks();
    const { h } = open({ entries: [D1], single: true });
    cleanup();
    await locks.grant();
    expect(h.command).not.toHaveBeenCalled();
    expect(stored()).toEqual([D1]);
    expect(Object.keys(globalThis.localStorage).filter((key) => key.includes('.claim.'))).toEqual([]);
  });

  it('changes nothing in the storage once the screen is left while the tab waits for the lock to take a sent diary out', async () => {
    const locks = heldLocks();
    const { h } = open({ entries: [D1], single: true });
    await locks.grant();
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    cleanup();
    await locks.grant();
    expect(stored()).toEqual([D1]);
  });

  it('leaves a diary that another tab has taken for sending to that tab, and takes over a claim that has run out', async () => {
    const claim = `${OWN_KEY}.claim.${D1.clientOperationId}`;
    globalThis.localStorage.setItem(claim, `another-tab|${Date.now()}`);
    const { tabs, h } = open({ entries: [D1] });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(h.command).not.toHaveBeenCalled();
    expect(ids(tabs.a as OfflineQueue)).toEqual([D1.clientOperationId]);
    expect(globalThis.localStorage.getItem(claim)).toContain('another-tab');
    cleanup();
    globalThis.localStorage.setItem(claim, `another-tab|${Date.now() - 120_000}`);
    const again = open({ entries: [D1] });
    await waitFor(() => expect(again.h.command).toHaveBeenCalled());
    await waitFor(() => expect(stored()).toEqual([]));
    expect(globalThis.localStorage.getItem(claim)).toBeNull();
  });

  it('does not send the same diary from two tabs that open together', async () => {
    const { h } = open({ entries: [D1] });
    await waitFor(() => expect(stored()).toEqual([]));
    expect(h.command.mock.calls.filter(([name]) => name === 'saveSiteDiaryDraft')).toHaveLength(1);
  });
});
