import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useApiClient } from '../../api/ApiClientContext';
import { useSession } from '../../session/SessionContext';
import { toFreshness, toLineage, toScorecard } from './trust-model';
import type { FreshnessReading, LineageView, Scorecard } from './trust-model';

const base = { retry: false, staleTime: 0, refetchOnWindowFocus: false } as const;

export function useFreshness() {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<FreshnessReading>({
    queryKey: ['ana', tenant?.id, tenant?.membershipId, 'freshness'],
    queryFn: async () => {
      const reading = toFreshness(await client.read('getDataFreshness', {}));
      if (reading === undefined) throw new Error('the freshness of the datasets could not be read');
      return reading;
    },
    enabled: tenant !== undefined,
    ...base,
  });
}

export function useScorecard() {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<Scorecard>({
    queryKey: ['ana', tenant?.id, tenant?.membershipId, 'scorecard'],
    queryFn: async () => {
      const card = toScorecard(await client.read('getDataTrustScorecard', {}));
      if (card === undefined) throw new Error('the scorecard could not be read');
      return card;
    },
    enabled: tenant !== undefined,
    ...base,
  });
}

export interface LineageQuery {
  node: string;
  direction: 'UPSTREAM' | 'DOWNSTREAM';
  depth: number;
}

export function useLineage(query: LineageQuery) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<LineageView>({
    queryKey: ['ana', tenant?.id, tenant?.membershipId, 'lineage', query.node, query.direction, query.depth],
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const view = toLineage(await client.read('getMetricLineageGraph', { query: query.node === '' ? {} : { node: query.node, direction: query.direction, depth: query.depth } }));
      if (view === undefined) throw new Error('the lineage could not be read');
      return view;
    },
    enabled: tenant !== undefined,
    ...base,
  });
}
