import { afterEach, describe, expect, it, vi } from 'vitest';
import type { QueuedDiary } from './model';
import { claimDiary, deviceStorage, queueKey, readContracts, readQueue, readStored, releaseDiary, wipeOtherTenants, writeContracts, writeQueue } from './store';

const ENTRY: QueuedDiary = {
  clientOperationId: '00000000-0000-4000-8000-0000000000e1',
  contractId: '00000000-0000-4000-8000-000000000002',
  contractCode: 'HD-A-002',
  recordDate: '2026-10-20',
  content: { summary: 'x' },
  baseServerVersion: 2,
  queuedAt: '2026-10-20T01:00:00.000Z',
  state: 'PENDING',
  reason: null,
};

afterEach(() => {
  vi.restoreAllMocks();
  globalThis.localStorage.clear();
});

describe('the queue on the device', () => {
  it('keeps the queue under the tenant and the membership and reads it back', () => {
    const storage = deviceStorage();
    writeQueue(storage, 'T1', 'M1', [ENTRY, { ...ENTRY, clientOperationId: 'b', baseServerVersion: null, state: 'REJECTED', reason: 'diaryState' }]);
    expect(storage?.getItem(queueKey('T1', 'M1'))).not.toBeNull();
    expect(readQueue(storage, 'T1', 'M1')).toEqual([ENTRY, { ...ENTRY, clientOperationId: 'b', baseServerVersion: null, state: 'REJECTED', reason: 'diaryState' }]);
    expect(readQueue(storage, 'T1', 'M2')).toEqual([]);
    expect(readQueue(storage, 'T2', 'M1')).toEqual([]);
  });

  it('reports that the device kept the queue, and that a full storage kept nothing new and left the older queue as it was', () => {
    const storage = deviceStorage() as Storage;
    expect(writeQueue(storage, 'T1', 'M1', [ENTRY])).toBe('ok');
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError');
    });
    expect(writeQueue(storage, 'T1', 'M1', [ENTRY, { ...ENTRY, clientOperationId: 'b' }])).toBe('failed');
    vi.restoreAllMocks();
    expect(readQueue(storage, 'T1', 'M1')).toEqual([ENTRY]);
  });

  it('removes the key when the queue is empty', () => {
    const storage = deviceStorage();
    writeQueue(storage, 'T1', 'M1', [ENTRY]);
    writeQueue(storage, 'T1', 'M1', []);
    expect(storage?.getItem(queueKey('T1', 'M1'))).toBeNull();
  });

  it('reads nothing from what is not a queue, and drops the entries that are not diaries', () => {
    const storage = deviceStorage() as Storage;
    storage.setItem(queueKey('T1', 'M1'), 'not json');
    expect(readQueue(storage, 'T1', 'M1')).toEqual([]);
    storage.setItem(queueKey('T1', 'M1'), '{"a":1}');
    expect(readQueue(storage, 'T1', 'M1')).toEqual([]);
    storage.setItem(
      queueKey('T1', 'M1'),
      JSON.stringify([null, { ...ENTRY, clientOperationId: 1 }, { ...ENTRY, state: 'DONE' }, { ...ENTRY, content: 'text' }, { ...ENTRY, contractCode: 5, baseServerVersion: 'x', reason: 7 }]),
    );
    expect(readQueue(storage, 'T1', 'M1')).toEqual([{ ...ENTRY, contractCode: '', baseServerVersion: null, reason: null }]);
  });

  it('works with no storage and with a storage that throws', () => {
    expect(readQueue(undefined, 'T1', 'M1')).toEqual([]);
    expect(writeQueue(undefined, 'T1', 'M1', [ENTRY])).toBe('failed');
    expect(writeQueue(undefined, 'T1', 'M1', [])).toBe('ok');
    expect(wipeOtherTenants(undefined, 'T1', 'M1')).toBe(0);
    const broken = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('full');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
      key: () => {
        throw new Error('blocked');
      },
      length: 1,
    } as unknown as Storage;
    expect(readQueue(broken, 'T1', 'M1')).toEqual([]);
    expect(writeQueue(broken, 'T1', 'M1', [ENTRY])).toBe('failed');
    expect(writeQueue(broken, 'T1', 'M1', [])).toBe('failed');
    expect(wipeOtherTenants(broken, 'T1', 'M1')).toBe(0);
  });

  it('finds no storage when the browser refuses it', () => {
    vi.spyOn(globalThis, 'localStorage', 'get').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(deviceStorage()).toBeUndefined();
  });

  it('reads what the storage holds right now, and nothing when it cannot be read', () => {
    const storage = deviceStorage() as Storage;
    expect(readStored(storage, 'T1', 'M1')).toEqual([]);
    writeQueue(storage, 'T1', 'M1', [ENTRY]);
    expect(readStored(storage, 'T1', 'M1')).toEqual([ENTRY]);
    expect(readStored(undefined, 'T1', 'M1')).toBeUndefined();
    const broken = {
      getItem: () => {
        throw new Error('blocked');
      },
    } as unknown as Storage;
    expect(readStored(broken, 'T1', 'M1')).toBeUndefined();
  });

  it('lets one tab claim a diary, respects the claim of another for a minute, and releases it', () => {
    const storage = deviceStorage() as Storage;
    expect(claimDiary(storage, 'T1', 'M1', 'op', 'tab-a', 1_000_000)).toBe(true);
    expect(claimDiary(storage, 'T1', 'M1', 'op', 'tab-a', 1_010_000)).toBe(true);
    expect(claimDiary(storage, 'T1', 'M1', 'op', 'tab-b', 1_020_000)).toBe(false);
    expect(claimDiary(storage, 'T1', 'M1', 'op', 'tab-b', 1_070_001)).toBe(true);
    releaseDiary(storage, 'T1', 'M1', 'op');
    expect(claimDiary(storage, 'T1', 'M1', 'op', 'tab-c', 1_070_002)).toBe(true);
    expect(claimDiary(undefined, 'T1', 'M1', 'op', 'tab-a', 1)).toBe(true);
    expect(() => releaseDiary(undefined, 'T1', 'M1', 'op')).not.toThrow();
    const broken = {
      getItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    } as unknown as Storage;
    expect(claimDiary(broken, 'T1', 'M1', 'op', 'tab-a', 1)).toBe(true);
    expect(() => releaseDiary(broken, 'T1', 'M1', 'op')).not.toThrow();
  });

  it('keeps only the id, the code and the name of the contracts, reads them back, and reads nothing from what is not a list', () => {
    const storage = deviceStorage() as Storage;
    writeContracts(storage, 'T1', 'M1', [{ id: 'c1', code: 'HD-1', title: 'Cầu', extra: 'not kept' } as { id: string; code: string; title: string | null }, { id: 'c2', code: 'HD-2', title: null }]);
    expect(JSON.parse(storage.getItem(`${queueKey('T1', 'M1')}.contracts`) as string)).toEqual([
      { id: 'c1', code: 'HD-1', title: 'Cầu' },
      { id: 'c2', code: 'HD-2', title: null },
    ]);
    expect(readContracts(storage, 'T1', 'M1')).toEqual([
      { id: 'c1', code: 'HD-1', title: 'Cầu' },
      { id: 'c2', code: 'HD-2', title: null },
    ]);
    expect(readContracts(storage, 'T1', 'M2')).toEqual([]);
    storage.setItem(`${queueKey('T1', 'M1')}.contracts`, JSON.stringify([null, { id: 1 }, { id: 'c3', code: 'HD-3', title: 7 }]));
    expect(readContracts(storage, 'T1', 'M1')).toEqual([{ id: 'c3', code: 'HD-3', title: null }]);
    storage.setItem(`${queueKey('T1', 'M1')}.contracts`, '{"a":1}');
    expect(readContracts(storage, 'T1', 'M1')).toEqual([]);
    storage.setItem(`${queueKey('T1', 'M1')}.contracts`, 'not json');
    expect(readContracts(storage, 'T1', 'M1')).toEqual([]);
    writeContracts(storage, 'T1', 'M1', []);
    expect(storage.getItem(`${queueKey('T1', 'M1')}.contracts`)).toBeNull();
    expect(readContracts(undefined, 'T1', 'M1')).toEqual([]);
    const broken = {
      setItem: () => {
        throw new Error('full');
      },
    } as unknown as Storage;
    expect(() => writeContracts(broken, 'T1', 'M1', [{ id: 'c1', code: 'HD-1', title: null }])).not.toThrow();
  });

  it('wipes the contracts kept for another tenant or for another membership, and keeps those of this membership', () => {
    const storage = deviceStorage() as Storage;
    writeContracts(storage, 'T1', 'M1', [{ id: 'c1', code: 'HD-1', title: null }]);
    writeContracts(storage, 'T1', 'M2', [{ id: 'c2', code: 'HD-2', title: null }]);
    writeContracts(storage, 'T2', 'M1', [{ id: 'c3', code: 'HD-3', title: null }]);
    writeQueue(storage, 'T1', 'M2', [ENTRY]);
    expect(wipeOtherTenants(storage, 'T1', 'M1')).toBe(0);
    expect(readContracts(storage, 'T1', 'M1')).toHaveLength(1);
    expect(readContracts(storage, 'T1', 'M2')).toEqual([]);
    expect(readContracts(storage, 'T2', 'M1')).toEqual([]);
    expect(readQueue(storage, 'T1', 'M2')).toHaveLength(1);
  });

  it('wipes what the device kept for the other tenants and nothing else, and counts the diaries that went', () => {
    const storage = deviceStorage() as Storage;
    writeQueue(storage, 'T1', 'M1', [ENTRY]);
    writeQueue(storage, 'T2', 'M1', [ENTRY, ENTRY]);
    writeQueue(storage, 'T3', 'M9', [ENTRY]);
    storage.setItem('something.else', 'kept');
    expect(wipeOtherTenants(storage, 'T1', 'M1')).toBe(3);
    expect(readQueue(storage, 'T1', 'M1')).toHaveLength(1);
    expect(storage.getItem(queueKey('T2', 'M1'))).toBeNull();
    expect(storage.getItem('something.else')).toBe('kept');
    expect(wipeOtherTenants(storage, 'T1', 'M1')).toBe(0);
  });
});
