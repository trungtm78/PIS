import { useQuery } from '@tanstack/react-query';
import { useApiClient } from '../../../api/ApiClientContext';
import { useSession } from '../../../session/SessionContext';
import { toTenantSummary } from '../tenants/types';
import { healthOf } from './model';
import type { PlatformHealth } from './model';

export const healthKey = (sessionTenantId: string | undefined, membershipId: string | undefined) => ['sas', 'health', sessionTenantId, membershipId] as const;

/** The registry of the control plane read to the end and counted (`listSystemTenants`): it carries lifecycle, placement, plan and licence per tenant code, and nothing of a tenant's business. */
export function usePlatformHealth(enabled: boolean) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<PlatformHealth>({
    queryKey: healthKey(tenant?.id, tenant?.membershipId),
    queryFn: async () => healthOf((await client.readAll('listSystemTenants')).map(toTenantSummary)),
    enabled: enabled && tenant !== undefined,
    retry: false,
  });
}
