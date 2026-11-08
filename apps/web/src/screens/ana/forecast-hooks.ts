import { useQuery } from '@tanstack/react-query';
import { useApiClient } from '../../api/ApiClientContext';
import { useSession } from '../../session/SessionContext';
import { toOutlookReading } from './forecast-model';
import type { OutlookReading } from './forecast-model';

export interface OutlookQuery {
  unitId: string;
  planBasis: 'PM' | 'TOTAL';
  byFund: boolean;
}

/** The year-end outlook of the disbursement for a scope, a plan basis and (optionally) per fund source; keyed by member so a switch of tenant or person never shows another's figures. */
export function useOutlook(query: OutlookQuery) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<OutlookReading>({
    queryKey: ['ana', tenant?.id, tenant?.membershipId, 'outlook', query.unitId, query.planBasis, query.byFund],
    queryFn: async () => {
      const reading = toOutlookReading(
        await client.read('getDisbursementOutlook', { query: { ...(query.unitId === '' ? {} : { unit_id: query.unitId }), plan_basis: query.planBasis, breakdown: query.byFund ? 'FUND' : 'NONE' } }),
      );
      if (reading === undefined) throw new Error('the outlook could not be read');
      return reading;
    },
    enabled: tenant !== undefined,
    retry: false,
    staleTime: 0,
    refetchOnWindowFocus: false,
  });
}
