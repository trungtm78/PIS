import { ApiError } from '@machvon/api-client';
import { useQuery } from '@tanstack/react-query';
import { useApiClient } from '../../../api/ApiClientContext';
import { useScopeKey } from '../hooks';
import { toChain } from './model';
import type { Chain } from './model';

/** The chain of a project, or of one of its contracts; null when it is not there for the caller (another tenant, outside the scope, a guest: a 404). */
export function useChain(projectId: string | null, contractId: string | null, enabled = true) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<Chain | null>({
    queryKey: [...key, 'chain', projectId ?? '', contractId ?? ''],
    queryFn: async () => {
      try {
        const query = { project_id: projectId ?? '', ...(contractId === null ? {} : { contract_id: contractId }) };
        return toChain(await client.read('getPaymentChain', { query })) ?? null;
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return null;
        throw error;
      }
    },
    enabled: enabled && key[1] !== undefined && projectId !== null,
    retry: false,
  });
}
