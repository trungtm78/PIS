import type { QueuedDiary } from './model';

const PREFIX = 'machvon.qms.offline.';

type Raw = Record<string, unknown>;

/** The browser storage, or none: it can be missing or throw (a private window, blocked site data), and the screen then keeps its queue for the visit only. */
export function deviceStorage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

/** The queue belongs to one membership of one tenant, so that another person on the same device never sees it. */
export const queueKey = (tenantId: string, membershipId: string): string => `${PREFIX}${tenantId}.${membershipId}`;

const isRecord = (value: unknown): value is Raw => typeof value === 'object' && value !== null && !Array.isArray(value);

function toQueued(raw: unknown): QueuedDiary | undefined {
  if (!isRecord(raw)) return undefined;
  const { clientOperationId, contractId, contractCode, recordDate, content, baseServerVersion, queuedAt, state, reason } = raw;
  if (typeof clientOperationId !== 'string' || typeof contractId !== 'string' || typeof recordDate !== 'string' || typeof queuedAt !== 'string' || !isRecord(content)) return undefined;
  if (state !== 'PENDING' && state !== 'REJECTED') return undefined;
  return {
    clientOperationId,
    contractId,
    contractCode: typeof contractCode === 'string' ? contractCode : '',
    recordDate,
    content,
    baseServerVersion: typeof baseServerVersion === 'number' && Number.isInteger(baseServerVersion) ? baseServerVersion : null,
    queuedAt,
    state,
    reason: typeof reason === 'string' ? (reason as QueuedDiary['reason']) : null,
  };
}

function parse(text: string | null): QueuedDiary[] {
  if (text === null) return [];
  try {
    const value: unknown = JSON.parse(text);
    return Array.isArray(value) ? value.flatMap((entry) => toQueued(entry) ?? []) : [];
  } catch {
    return [];
  }
}

export function readQueue(storage: Storage | undefined, tenantId: string, membershipId: string): QueuedDiary[] {
  try {
    return parse(storage?.getItem(queueKey(tenantId, membershipId)) ?? null);
  } catch {
    return [];
  }
}

/** Whether the device kept what it was asked to keep: a storage that is missing, full or refusing keeps nothing new, and what it held before stays as it was. */
export type Persisted = 'ok' | 'failed';

/** What the storage holds for this membership right now, or undefined when the storage is missing or refuses to be read: the base of every change, so that a tab never writes over what another tab kept. */
export function readStored(storage: Storage | undefined, tenantId: string, membershipId: string): QueuedDiary[] | undefined {
  if (storage === undefined) return undefined;
  try {
    return parse(storage.getItem(queueKey(tenantId, membershipId)));
  } catch {
    return undefined;
  }
}

export function writeQueue(storage: Storage | undefined, tenantId: string, membershipId: string, items: readonly QueuedDiary[]): Persisted {
  if (storage === undefined) return items.length === 0 ? 'ok' : 'failed';
  try {
    if (items.length === 0) storage.removeItem(queueKey(tenantId, membershipId));
    else storage.setItem(queueKey(tenantId, membershipId), JSON.stringify(items));
    return 'ok';
  } catch {
    return 'failed';
  }
}

/**
 * Removes everything the device kept for any tenant but this one (UAT-AC367: a switch of tenant leaves nothing of the previous tenant), and the contracts kept for another membership of this tenant; returns how many unsent
 * diaries went with it.
 */
export function wipeOtherTenants(storage: Storage | undefined, tenantId: string, membershipId: string): number {
  if (storage === undefined) return 0;
  let dropped = 0;
  try {
    const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index)).filter(
      (key): key is string => key !== null && key.startsWith(PREFIX) && (!key.startsWith(`${PREFIX}${tenantId}.`) || (key.endsWith('.contracts') && key !== contractsKey(tenantId, membershipId))),
    );
    for (const key of keys) {
      dropped += parse(storage.getItem(key)).length;
      storage.removeItem(key);
    }
  } catch {
    // Nothing more can be done on a storage that throws.
  }
  return dropped;
}

/**
 * Runs a change of the queue of this membership while no other tab of the device is making one, by the Web Locks of the browser under the key of the queue: what a tab reads, changes and writes back is then not
 * read by another tab in between. Where the browser has no Web Locks the change runs at once, unlocked, and the claims on the diaries and the server (which takes a diary once per operation id) are what is left to
 * keep two tabs from sending the same one twice.
 */
export async function withQueueLock<T>(tenantId: string, membershipId: string, run: () => T): Promise<T> {
  const locks: LockManager | undefined = globalThis.navigator?.locks;
  if (locks === undefined) return run();
  return locks.request(queueKey(tenantId, membershipId), run);
}

const CLAIM_MS = 60_000;
const claimKey = (tenantId: string, membershipId: string, clientOperationId: string): string => `${queueKey(tenantId, membershipId)}.claim.${clientOperationId}`;

/**
 * Takes a diary for sending by its operation id, so that two tabs of the same membership do not send it at once. A claim of another tab that is younger than a minute is respected (the diary is left to that tab, which removes
 * it when the server has taken it); an older one is a tab that went away and is taken over. Where the storage cannot keep the claim the send goes ahead, and the server, which takes a diary once per operation id, is the judge.
 */
export function claimDiary(storage: Storage | undefined, tenantId: string, membershipId: string, clientOperationId: string, tab: string, nowMs: number): boolean {
  if (storage === undefined) return true;
  try {
    const key = claimKey(tenantId, membershipId, clientOperationId);
    const held = (storage.getItem(key) ?? '').split('|');
    const heldAt = Number(held[1]);
    if (held[0] !== tab && held[0] !== '' && Number.isFinite(heldAt) && nowMs - heldAt < CLAIM_MS) return false;
    storage.setItem(key, `${tab}|${nowMs}`);
    return true;
  } catch {
    return true;
  }
}

export function releaseDiary(storage: Storage | undefined, tenantId: string, membershipId: string, clientOperationId: string): void {
  try {
    storage?.removeItem(claimKey(tenantId, membershipId, clientOperationId));
  } catch {
    // A claim that cannot be removed runs out by itself.
  }
}

/** The contract a diary is written for, as far as the form needs it: nothing else of the contract is kept on the device. */
export interface ContractOption {
  id: string;
  code: string;
  title: string | null;
}

const contractsKey = (tenantId: string, membershipId: string): string => `${queueKey(tenantId, membershipId)}.contracts`;

/** The contracts offered when they cannot be read from the server (no connection and nothing cached), kept the last time they were read. */
export function readContracts(storage: Storage | undefined, tenantId: string, membershipId: string): ContractOption[] {
  try {
    const value: unknown = JSON.parse(storage?.getItem(contractsKey(tenantId, membershipId)) ?? 'null');
    if (!Array.isArray(value)) return [];
    return value.flatMap((entry): ContractOption[] => {
      if (!isRecord(entry) || typeof entry.id !== 'string' || typeof entry.code !== 'string') return [];
      return [{ id: entry.id, code: entry.code, title: typeof entry.title === 'string' ? entry.title : null }];
    });
  } catch {
    return [];
  }
}

export function writeContracts(storage: Storage | undefined, tenantId: string, membershipId: string, options: readonly ContractOption[]): void {
  try {
    if (options.length === 0) storage?.removeItem(contractsKey(tenantId, membershipId));
    else storage?.setItem(contractsKey(tenantId, membershipId), JSON.stringify(options.map(({ id, code, title }) => ({ id, code, title }))));
  } catch {
    // The list is only a copy for the next visit with no connection; where it cannot be kept the next visit reads it again.
  }
}
