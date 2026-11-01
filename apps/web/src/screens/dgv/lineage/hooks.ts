import { useQuery } from '@tanstack/react-query';
import { useApiClient } from '../../../api/ApiClientContext';
import { useSession } from '../../../session/SessionContext';
import { root } from '../hooks';
import { queryParams, toGraph } from './model';
import type { LineageGraph, LineageQuery } from './model';

/** The graph of a node, up or down: the server decides which nodes the person sees and shows the others as restricted; nothing is asked until there is something to ask. */
export function useLineage(query: LineageQuery | undefined) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<LineageGraph>({
    queryKey: [...root(tenant?.id), 'lineage', tenant?.membershipId, query?.kind, query?.refId, query?.direction, query?.depth],
    queryFn: async () => {
      const graph = toGraph(await client.read('getLineageGraph', { query: queryParams(query as LineageQuery) as never }));
      if (graph === undefined) throw new Error('the lineage could not be read');
      return graph;
    },
    enabled: tenant !== undefined && query !== undefined,
    retry: false,
  });
}
