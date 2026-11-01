import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { isDefinitiveRefusal, isSessionExpired } from '../../../api/attempt-registry';
import { useApiClient } from '../../../api/ApiClientContext';
import { useSession } from '../../../session/SessionContext';
import { toContractLine } from '../../ctr/model';
import type { ContractLine } from '../../ctr/model';
import { useSaveDiary } from '../diary/hooks';
import { canWrite, describeProblem } from '../diary/model';
import { isPending, toSaveBody } from './model';
import type { QueuedDiary } from './model';
import { claimDiary, deviceStorage, queueKey, readContracts, readQueue, readStored, releaseDiary, wipeOtherTenants, withQueueLock, writeContracts, writeQueue } from './store';
import type { ContractOption, Persisted } from './store';

/** The contracts in the scope of the caller, for the contract a diary is written for; nothing is read unless the caller may read contracts. */
export function useContractOptions(enabled: boolean) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<ContractLine[]>({
    queryKey: ['qms-diaries', tenant?.id, tenant?.membershipId, 'offline-contracts'],
    queryFn: async () => (await client.readAll('get_resources_contract')).flatMap((raw) => toContractLine(raw) ?? []),
    enabled: enabled && tenant !== undefined,
    retry: false,
  });
}

const NO_OPTIONS: readonly ContractOption[] = [];

const without =
  (clientOperationId: string) =>
  (queue: QueuedDiary[]): QueuedDiary[] =>
    queue.filter((entry) => entry.clientOperationId !== clientOperationId);

/**
 * The contracts a diary can be written for, as the form needs them (id, code and name). They are kept on the device each time they are read, and offered from there when they cannot be read (no connection and nothing in the
 * cache of the visit), so that a diary can still be written with no connection. Nothing is offered unless the caller may read contracts.
 */
export function useOfflineContracts(enabled: boolean): readonly ContractOption[] {
  const { tenant } = useSession();
  const tenantId = tenant?.id ?? '';
  const membershipId = tenant?.membershipId ?? '';
  const read = useContractOptions(enabled);
  const fresh = useMemo(() => read.data?.map(({ id, code, title }) => ({ id, code, title })), [read.data]);
  const kept = useMemo(() => readContracts(deviceStorage(), tenantId, membershipId), [tenantId, membershipId]);
  useEffect(() => {
    if (fresh !== undefined) writeContracts(deviceStorage(), tenantId, membershipId, fresh);
  }, [fresh, tenantId, membershipId]);
  return !enabled ? NO_OPTIONS : (fresh ?? kept);
}

/** Whether the device says it has a connection; the server is the judge of whether a send arrives. */
export function useOnline(): boolean {
  const [online, setOnline] = useState(() => globalThis.navigator?.onLine !== false);
  useEffect(() => {
    const on = (): void => setOnline(true);
    const off = (): void => setOnline(false);
    globalThis.addEventListener('online', on);
    globalThis.addEventListener('offline', off);
    return () => {
      globalThis.removeEventListener('online', on);
      globalThis.removeEventListener('offline', off);
    };
  }, []);
  return online;
}

/** What the last send did, for the words under the queue. */
export interface SendOutcome {
  sent: number;
  /** Diaries the server kept as a copy beside the diary of the day, to be settled by a person (nothing is overwritten). */
  conflicts: number;
  rejected: number;
}

export interface OfflineQueue {
  items: QueuedDiary[];
  sending: boolean;
  outcome: SendOutcome | undefined;
  /** How many unsent diaries of another tenant were removed from this device when the screen opened. */
  wiped: number;
  /** Puts the diary in the queue only if the device kept it: on 'failed' nothing was queued and the caller still holds the diary. */
  enqueue(item: QueuedDiary): Promise<Persisted>;
  /** The device could not keep the last change of the queue (a removal or a send), so a reload may bring back what is already gone. */
  unsaved: boolean;
  remove(clientOperationId: string): void;
  flush(): Promise<void>;
  online: boolean;
  /** Whether a send may leave the device now: there is a connection and the session may write diaries. Until then the queue is kept as it is. */
  canSend: boolean;
}

/**
 * The diaries written on this device and not yet taken by the server, kept in the storage of the device under the tenant and the membership. A send takes them in the order they were written, each under its own operation id:
 * one the server takes (or already has) leaves the queue; one it kept as a conflict copy leaves the queue and is shown in the conflicts; one it refused for a reason a person has to act on stays, marked; and a lost
 * answer or a failure of the server stops the send and leaves the rest for the next one. A switch of tenant opens the screen over, and what the device kept for the other tenants goes (UAT-AC367).
 */
export function useOfflineQueue(): OfflineQueue {
  const { tenant, permissions, mode, status, tenantToken } = useSession();
  const tenantId = tenant?.id ?? '';
  const membershipId = tenant?.membershipId ?? '';
  const queryClient = useQueryClient();
  const save = useSaveDiary();
  const [items, setItems] = useState<QueuedDiary[]>(() => readQueue(deviceStorage(), tenantId, membershipId));
  const [sending, setSending] = useState(false);
  const [outcome, setOutcome] = useState<SendOutcome | undefined>(undefined);
  const [wiped, setWiped] = useState(0);
  const [unsaved, setUnsaved] = useState(false);
  const current = useRef(items);
  const busy = useRef(false);
  // This tab, for the claims it makes on the diaries it sends.
  const tab = useRef(globalThis.crypto.randomUUID());
  // A send belongs to the scope (tenant and membership) and the visit of the screen it started in: leaving either ends it, whatever is still in flight.
  const generation = useRef(0);
  const online = useOnline();
  const canSend = online && status !== 'signedOut' && canWrite(permissions, mode);
  // The session the device is sending under: when it is made again (the person signs in again), what waited for it is sent.
  const session = `${status ?? ''}:${tenantToken?.expiresAt ?? ''}`;

  useEffect(
    () => () => {
      generation.current += 1;
      busy.current = false;
    },
    [tenantId, membershipId],
  );

  useEffect(() => {
    setWiped(wipeOtherTenants(deviceStorage(), tenantId, membershipId));
  }, [tenantId, membershipId]);

  // What this tab shows follows what the device keeps: another tab of the same membership may have queued, sent or removed a diary.
  const follow = useCallback((): void => {
    const stored = readStored(deviceStorage(), tenantId, membershipId);
    if (stored === undefined) return;
    current.current = stored;
    setItems(stored);
  }, [tenantId, membershipId]);
  useEffect(() => {
    const changed = (event: StorageEvent): void => {
      if (event.key === null || event.key === queueKey(tenantId, membershipId)) follow();
    };
    globalThis.addEventListener('storage', changed);
    return () => globalThis.removeEventListener('storage', changed);
  }, [follow, tenantId, membershipId]);

  // Every change is made on what the device keeps right now, one diary at a time, and never by writing this tab's own copy over it: a tab that was open before another one queued a diary would otherwise take that diary away.
  // The reading, the change and the writing back are one step under the lock of the queue, so that no other tab reads in between.
  const commit = useCallback(
    (apply: (queue: QueuedDiary[]) => QueuedDiary[]): { next: QueuedDiary[]; stored: Persisted } => {
      const next = apply(readStored(deviceStorage(), tenantId, membershipId) ?? current.current);
      return { next, stored: writeQueue(deviceStorage(), tenantId, membershipId, next) };
    },
    [tenantId, membershipId],
  );

  // A change made by a send that has ended with its scope while it waited for the lock is not made at all.
  const update = useCallback(
    async (apply: (queue: QueuedDiary[]) => QueuedDiary[], live: () => boolean = () => true): Promise<void> => {
      const made = await withQueueLock(tenantId, membershipId, () => (live() ? commit(apply) : undefined));
      if (made === undefined) return;
      current.current = made.next;
      setItems(made.next);
      setUnsaved(made.stored === 'failed');
    },
    [commit, tenantId, membershipId],
  );

  const enqueue = useCallback(
    async (item: QueuedDiary): Promise<Persisted> => {
      const made = await withQueueLock(tenantId, membershipId, () => commit((queue) => (queue.some((entry) => entry.clientOperationId === item.clientOperationId) ? queue : [...queue, item])));
      if (made.stored === 'ok') {
        current.current = made.next;
        setItems(made.next);
      }
      return made.stored;
    },
    [commit, tenantId, membershipId],
  );
  const remove = useCallback((clientOperationId: string): void => void update(without(clientOperationId)), [update]);

  const allowed = useRef(canSend);
  useEffect(() => {
    allowed.current = canSend;
  });

  const flush = useCallback(async (): Promise<void> => {
    if (!canSend || busy.current || !current.current.some(isPending)) return;
    busy.current = true;
    const mine = generation.current;
    const live = (): boolean => mine === generation.current;
    setSending(true);
    const result: SendOutcome = { sent: 0, conflicts: 0, rejected: 0 };
    const send = async (item: QueuedDiary): Promise<'next' | 'stop'> => {
      try {
        await save.mutateAsync(toSaveBody(item));
        if (!live()) return 'stop';
        result.sent += 1;
        await update(without(item.clientOperationId), live);
      } catch (error) {
        // A lost answer or a failure of the server: the diary stays as it is, with the operation id it was written under, and the send stops here. So does a session that has run out: it is no refusal of the diary, and the
        // diaries wait, all of them pending, until the session is made again.
        if (!live() || isSessionExpired(error) || !isDefinitiveRefusal(error)) return 'stop';
        const problem = describeProblem(error);
        if (problem === 'syncConflict') {
          result.conflicts += 1;
          await update(without(item.clientOperationId), live);
        } else {
          result.rejected += 1;
          await update((queue) => queue.map((candidate) => (candidate.clientOperationId === item.clientOperationId ? { ...candidate, state: 'REJECTED', reason: problem } : candidate)), live);
        }
      }
      return 'next';
    };
    // The diaries this send is done with (sent, settled, refused) or that another tab has taken for sending: a read of the device that still shows one of them does not bring it back into this send.
    const handled = new Set<string>();
    const claimed = async (item: QueuedDiary): Promise<'next' | 'stop'> => {
      // Whether the diary is still there to be sent is read again here, under the lock, with the claim: another tab may have removed or sent it since this send took its list.
      const taken = await withQueueLock(tenantId, membershipId, () => {
        const held = (readStored(deviceStorage(), tenantId, membershipId) ?? current.current).find((entry) => entry.clientOperationId === item.clientOperationId);
        return held !== undefined && isPending(held) && claimDiary(deviceStorage(), tenantId, membershipId, item.clientOperationId, tab.current, Date.now());
      });
      if (!taken) {
        handled.add(item.clientOperationId);
        return live() ? 'next' : 'stop';
      }
      try {
        if (!live()) return 'stop';
        const outcome = await send(item);
        handled.add(item.clientOperationId);
        return outcome;
      } finally {
        releaseDiary(deviceStorage(), tenantId, membershipId, item.clientOperationId);
      }
    };
    let stopped = false;
    try {
      // A diary queued while this send runs is taken by the next pass, so that none waits for another trigger; a failure, the end of the scope, or the loss of the right to send stops the passes.
      while (!stopped) {
        follow();
        const batch = current.current.filter((item) => isPending(item) && !handled.has(item.clientOperationId));
        if (batch.length === 0) break;
        for (const item of batch) {
          if (!live() || !allowed.current || (await claimed(item)) === 'stop') {
            stopped = true;
            break;
          }
        }
      }
    } finally {
      if (live()) {
        busy.current = false;
        setSending(false);
        setOutcome(result);
        await queryClient.invalidateQueries({ predicate: (query) => query.queryKey[0] === 'qms-diaries' });
      }
    }
  }, [canSend, queryClient, save, update, follow, tenantId, membershipId]);

  // The device may send (it is back on the network, or the session may write again, or the screen opened able to): what waits is sent.
  const latest = useRef(flush);
  useEffect(() => {
    latest.current = flush;
  });
  useEffect(() => {
    if (canSend) void latest.current();
  }, [canSend, session]);

  return { items, sending, outcome, wiped, enqueue, remove, flush, online, canSend, unsaved };
}
