import { useQuery } from '@tanstack/react-query';
import { useApiClient } from '../../../api/ApiClientContext';
import { useSession } from '../../../session/SessionContext';
import { llmRoot } from '../hooks';
import { toCompareRun } from './model';
import type { CompareRun } from './model';

/** Every evaluation run of the tenant: the screen narrows them to one dataset version. */
export function useCompareRuns() {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<CompareRun[]>({
    queryKey: [...llmRoot(tenant?.id), 'compare-runs', tenant?.membershipId],
    queryFn: async () => (await client.readAll('get_resources_ai_eval_run')).flatMap((raw) => toCompareRun(raw) ?? []),
    enabled: tenant !== undefined,
    retry: false,
  });
}
