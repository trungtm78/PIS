import { useQuery } from '@tanstack/react-query';
import { useApiClient } from '../../../api/ApiClientContext';
import { useSession } from '../../../session/SessionContext';
import { toUsage } from './model';
import type { UsageSummary } from './model';

export const usageKey = (sessionTenantId: string | undefined, tenantId: string | undefined) => ['sas', 'usage', sessionTenantId, tenantId ?? 'mine'] as const;

/**
 * The usage of the month: the control plane reads any tenant (`getTenantUsage`, with the latest events), the tenant plane reads its own (`getMyUsage`, when no
 * tenant id is given). The query is keyed by the session tenant, so a switch never shows another tenant's counters.
 */
export function useUsage(tenantId: string | undefined, enabled = true) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<UsageSummary>({
    queryKey: usageKey(tenant?.id, tenantId),
    queryFn: async () => toUsage(tenantId === undefined ? await client.read('getMyUsage') : await client.read('getTenantUsage', { path: { tenantId } })),
    enabled: enabled && tenant !== undefined,
    retry: false,
  });
}
