import { useQuery } from '@tanstack/react-query';
import { useApiClient } from '../../../api/ApiClientContext';
import { useSession } from '../../../session/SessionContext';
import { monthRange, toCoverage } from './model';
import type { CoverageView } from './model';

/** The coverage of the diaries of one contract in one month; nothing is read until a contract is chosen. Keyed by the membership: what is shown depends on what it may see. */
export function useCoverage(contractId: string, month: string) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<CoverageView | null>({
    queryKey: ['qms-coverage', tenant?.id, tenant?.membershipId, contractId, month],
    queryFn: async () => toCoverage(await client.read('getDiaryCoverage', { path: { id: contractId }, query: monthRange(month) })) ?? null,
    enabled: tenant !== undefined && contractId !== '',
    retry: false,
  });
}
