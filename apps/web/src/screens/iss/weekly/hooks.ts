import { useQuery } from '@tanstack/react-query';
import { useApiClient } from '../../../api/ApiClientContext';
import { useSession } from '../../../session/SessionContext';
import { toMatrix } from './model';
import type { Matrix } from './model';

/** The weekly matrix of the issues for an ISO week, of one unit when it is named (`getIssueWeeklyMatrix`); who reads is part of the key, since the matrix follows the scope of the caller. */
export function useWeeklyMatrix(week: string, unitId: string, enabled: boolean) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<Matrix | null>({
    queryKey: ['iss-weekly', tenant?.id, tenant?.membershipId, week, unitId],
    queryFn: async () => toMatrix(await client.read('getIssueWeeklyMatrix', { query: unitId === '' ? { week } : { week, unit_id: unitId } })) ?? null,
    enabled: enabled && tenant !== undefined,
    retry: false,
  });
}
