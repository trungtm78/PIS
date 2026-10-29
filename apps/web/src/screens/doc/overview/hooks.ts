import { useQuery } from '@tanstack/react-query';
import { useApiClient } from '../../../api/ApiClientContext';
import { useSession } from '../../../session/SessionContext';
import { toOverview } from './model';
import type { Overview } from './model';

/** The overview of the documents for the signed-in membership: what is counted depends on what the membership may read, so the membership is part of the key. */
export function useOverview() {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<Overview>({
    queryKey: ['doc-overview', tenant?.id, tenant?.membershipId],
    queryFn: async () => toOverview(await client.read('getDocumentOverview')),
    enabled: tenant !== undefined,
    retry: false,
  });
}
