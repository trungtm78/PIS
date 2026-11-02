import { useQuery } from '@tanstack/react-query';
import { useApiClient } from '../../../api/ApiClientContext';
import { useSession } from '../../../session/SessionContext';
import { toComparison } from './model';
import type { Comparison } from './model';

/** The proposals of a package side by side on one version of the criteria; none is asked for until a package is chosen and the caller may, because opening the comparison is recorded on the server. */
export function useComparison(packageId: string, criteriaVersionId: string, enabled: boolean) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<Comparison | undefined>({
    queryKey: ['bid-compare', tenant?.id, tenant?.membershipId, packageId, criteriaVersionId],
    queryFn: async () => toComparison(await client.read('compareProposals', { path: { id: packageId }, query: criteriaVersionId === '' ? {} : { criteria_version_id: criteriaVersionId } })),
    enabled: enabled && tenant?.id !== undefined && packageId !== '',
    retry: false,
  });
}
