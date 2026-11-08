import { useQuery } from '@tanstack/react-query';
import { useApiClient } from '../../../api/ApiClientContext';
import { useScopeKey } from '../../vnd/shared/vnd-hooks';

export { useVendorCommand as useOutcomeCommand } from '../../vnd/shared/vnd-hooks';

/**
 * The outcomes of petitions, optionally of one petition or in one status. The reads share the key family of the contractor module, so that a command here also refreshes the dispute figures of VND-22 that fold the confirmed outcomes.
 */
export function useOutcomes(filters: { status: string; petition: string }) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery({
    queryKey: [...key, 'petition-outcomes', filters],
    queryFn: () => client.read('listProcurementPetitionOutcomes', { query: { ...(filters.status === '' ? {} : { status: filters.status }), ...(filters.petition === '' ? {} : { petition_id: filters.petition }) } }),
    enabled: key[1] !== undefined,
    retry: false,
    placeholderData: (previous) => previous,
  });
}
