import { useQuery } from '@tanstack/react-query';
import { useApiClient } from '../../../api/ApiClientContext';
import { useSession } from '../../../session/SessionContext';
import { toSnapshotList } from '../snapshot/model';
import type { SnapshotView } from '../snapshot/model';
import { ratesQueryOf, toRates } from './model';
import type { Rates, RatesQuery } from './model';

const root = (tenantId: string | undefined) => ['dis', tenantId, 'rates'] as const;

/** The two rates over a snapshot (the most recent frozen one when none is named) and a scope, whole and by unit or by project. */
export function useRates(query: RatesQuery, enabled = true) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<Rates | undefined>({
    queryKey: [...root(tenant?.id), 'rates', query],
    queryFn: async () => toRates(await client.read('getDisbursementRates', { query: ratesQueryOf(query) })),
    enabled: tenant !== undefined && enabled,
    retry: false,
  });
}

/** The snapshots that were frozen, newest first, what a screen of the rates lets a person choose from. */
export function useFrozenSnapshots() {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<SnapshotView[]>({
    queryKey: [...root(tenant?.id), 'frozen'],
    queryFn: async () => toSnapshotList(await client.read('listPeriodSnapshots', { query: { status: 'FROZEN', limit: 100 } })).items,
    enabled: tenant !== undefined,
    retry: false,
  });
}
