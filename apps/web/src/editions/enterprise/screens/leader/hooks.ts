import { useQuery } from '@tanstack/react-query';
import type { components } from '@machvon/contracts';
import { useApiClient } from '../../../../api/ApiClientContext';
import { useSession } from '../../../../session/SessionContext';

export type LeaderRates = components['schemas']['LeaderRates'];
export type LeaderRateRow = components['schemas']['LeaderRateRow'];
export type BlockedProjects = components['schemas']['LeaderBlockedProjects'];

// What the panel shows depends on the places the signed-in membership reaches: the membership is part of every key.
function useScopeKey(): readonly ['leader', string | undefined, string | undefined] {
  const { tenant } = useSession();
  return ['leader', tenant?.id, tenant?.membershipId];
}

/** The rates against the annual plan of the latest frozen enterprise snapshot, with last year. Nothing refreshes them by itself: they belong to the snapshot. */
export function useLeaderRates() {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<LeaderRates>({
    queryKey: [...key, 'rates'],
    queryFn: async () => (await client.read('getLeaderRates')) as LeaderRates,
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
