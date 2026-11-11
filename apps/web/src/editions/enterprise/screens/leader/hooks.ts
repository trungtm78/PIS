import { useQuery } from '@tanstack/react-query';
import type { components } from '@machvon/contracts';
import { useApiClient } from '../../../../api/ApiClientContext';
import { useSession } from '../../../../session/SessionContext';
import type { HomeDisbursed } from '../../../edition';

export type LeaderRates = components['schemas']['LeaderRates'];
export type LeaderRateRow = components['schemas']['LeaderRateRow'];
export type BlockedProjects = components['schemas']['LeaderBlockedProjects'];

// What the panel shows depends on the places the signed-in membership reaches: the membership is part of every key.
function useScopeKey(): readonly ['leader', string | undefined, string | undefined] {
  const { tenant } = useSession();
  return ['leader', tenant?.id, tenant?.membershipId];
}

/** Whether the answer of `getLeaderRates` is the empty one: no enterprise snapshot is frozen yet (200, `snapshot: null` and the reason), which is a state and never a failed request. */
export function isNoSnapshot(raw: unknown): boolean {
  return typeof raw === 'object' && raw !== null && 'snapshot' in raw && (raw as { snapshot: unknown }).snapshot === null;
}

/**
 * The rates against the annual plan of the latest frozen enterprise snapshot, with last year. Nothing refreshes them by itself: they belong to the snapshot. `null` is "nothing frozen yet" (the answer is empty,
 * not a refusal); `undefined` is "not read yet" or "the read failed".
 */
export function useLeaderRates() {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<LeaderRates | null>({
    queryKey: [...key, 'rates'],
    queryFn: async () => {
      const raw = await client.read('getLeaderRates');
      return isNoSnapshot(raw) ? null : (raw as LeaderRates);
    },
    enabled: key[1] !== undefined,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
}

export function useBlockedProjects() {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<BlockedProjects>({
    queryKey: [...key, 'blocked'],
    queryFn: async () => (await client.read('getBlockedProjects')) as BlockedProjects,
    enabled: key[1] !== undefined,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
}

/**
 * The amount disbursed that the command block of HOME shows on the enterprise edition: the company line of the frozen snapshot (the same read as the leader panel, so one number never has two sources). Nothing
 * frozen, or a company with no figure, is `none`: the block says so and never falls back to the Treasury figure.
 */
export function useSnapshotDisbursed(): HomeDisbursed {
  const read = useLeaderRates();
  return snapshotDisbursedOf(read.isLoading, read.data);
}

export function snapshotDisbursedOf(loading: boolean, data: LeaderRates | null | undefined): HomeDisbursed {
  if (loading) return { state: 'loading' };
  const value = data?.company.disbursed_vnd;
  if (data === undefined || data === null || value === null || value === undefined) return { state: 'none' };
  return { state: 'ready', valueVnd: value, asOfDate: data.as_of_date, revision: data.revision ?? 0 };
}
