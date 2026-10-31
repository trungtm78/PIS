import { useQuery } from '@tanstack/react-query';
import { useApiClient } from '../../../api/ApiClientContext';
import { useSession } from '../../../session/SessionContext';
import { toHistory } from './model';
import type { HistoryView } from './model';

/** The history of one contractor; nothing is read until one is chosen. Keyed by the membership: the scorecards shown depend on the contracts it reads. */
export function useHistory(contractorId: string) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<HistoryView | null>({
    queryKey: ['bid', tenant?.id, tenant?.membershipId, 'history', contractorId],
    queryFn: async () => toHistory(await client.read('getContractorHistory', { path: { id: contractorId } })) ?? null,
    enabled: tenant !== undefined && contractorId !== '',
    retry: false,
  });
}
