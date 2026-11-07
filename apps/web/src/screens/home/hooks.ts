import { useQuery } from '@tanstack/react-query';
import { useApiClient } from '../../api/ApiClientContext';
import { useSession } from '../../session/SessionContext';
import { NEW_SNAPSHOT_POLL_MS, toCommandCenter, waitingOf } from './model';
import type { CommandCenter, Freshness, Tile, WaitingCounts } from './model';

/** How long a reading of a snapshot stays in the cache with no one observing it. */
const PINNED_KEEP_MS = 5 * 60_000;

export const homeRoot = (tenantId: string | undefined) => ['home', tenantId] as const;

/** The key of a reading of the command center: the member, the snapshot (empty is the latest) and the unit. */
export const centerKey = (tenantId: string | undefined, membershipId: string | undefined, snapshotId: string, unitId: string) => [...homeRoot(tenantId), 'center', membershipId, snapshotId, unitId] as const;

export interface CenterQuery {
  /** The snapshot the figures are pinned to; empty reads the latest one that is frozen. */
  snapshotId: string;
  /** Narrows to the units under this one; empty reads the whole scope of the reader. */
  unitId: string;
}

/** The command center over a snapshot and a unit: what is asked is part of the key, so a change of unit never shows the figures of another. */
export function useCommandCenter(query: CenterQuery, seed?: CommandCenter) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<CommandCenter>({
    queryKey: centerKey(tenant?.id, tenant?.membershipId, query.snapshotId, query.unitId),
    queryFn: async () => {
      const center = toCommandCenter(await client.read('getCommandCenter', { query: { ...(query.snapshotId === '' ? {} : { snapshot_id: query.snapshotId }), ...(query.unitId === '' ? {} : { unit_id: query.unitId }) } }));
      if (center === undefined) throw new Error('the command center could not be read');
      return center;
    },
    // The answer that pins a snapshot is written under the key of that snapshot before anything observes it: it must outlive the moment between the two, or pinning would ask again.
    gcTime: PINNED_KEEP_MS,
    // The answer that pinned the snapshot is also the data of the reading pinned to it (same snapshot, same unit): pinning asks nothing again, even when the cache drops a reading nobody observes for a moment.
    ...(seed !== undefined && seed.snapshotId === query.snapshotId && (seed.scope.unitId ?? '') === query.unitId ? { initialData: seed } : {}),
    enabled: tenant !== undefined,
    retry: false,
    // The figures of a snapshot do not change under the reader: no refetch on focus, on reconnect or by age. A newer snapshot is offered by a banner and taken by a click (AC-ST-HOME-001-5).
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
}

/** What the background reading answers: the latest snapshot and the counts of what waits. */
export interface LatestReading {
  snapshotId: string;
  /** How the server judges the age of that snapshot now: the screen that shows it learns of its aging from here. */
  freshness: Freshness;
  /** The scope the reader is reading in now: when it is not the one of the figures on the screen, their access changed and the figures are read again. */
  scopeHash: string;
  waiting: WaitingCounts;
  /** The same counts as figures of the register, each with its definition (the "i"). */
  countTiles: Tile[];
}

/**
 * The latest frozen snapshot and what waits for someone, asked for in the background while the screen shows one snapshot: when the snapshot is another than the one on the screen a banner offers it, and the counts of what
 * waits (live, not of the snapshot) are the ones of this answer. It never changes the figures of the snapshot, and a failure of the poll is not a failure of the screen.
 */
export function useLatestSnapshot(enabled: boolean, unitId: string) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<LatestReading | undefined>({
    queryKey: [...homeRoot(tenant?.id), 'latest', tenant?.membershipId, unitId],
    queryFn: async () => {
      const center = toCommandCenter(await client.read('getCommandCenter', { query: unitId === '' ? {} : { unit_id: unitId } }));
      return center === undefined ? undefined : { snapshotId: center.snapshotId, freshness: center.freshness, scopeHash: center.scope.hash, waiting: waitingOf(center), countTiles: center.countTiles };
    },
    enabled: tenant !== undefined && enabled,
    refetchInterval: NEW_SNAPSHOT_POLL_MS,
    retry: false,
  });
}
