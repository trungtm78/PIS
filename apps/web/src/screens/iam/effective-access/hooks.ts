import { useQuery } from '@tanstack/react-query';
import { useApiClient } from '../../../api/ApiClientContext';
import { useSession } from '../../../session/SessionContext';
import { toEffectiveAccess } from './types';
import type { EffectiveAccessView } from './types';

/** How often the screen asks again whether the access changed; a change by an administrator shows within this time (IAM section 3.4: 60 s at most). */
export const REFRESH_MS = 30_000;

export const effectiveAccessKey = (tenantId: string | undefined, membershipId: string | undefined) => ['iam', 'effective-access', tenantId, membershipId] as const;

/**
 * The caller's own effective access (`getMyEffectiveAccess`). The key holds the session tenant and membership, so a tenant
 * switch never shows the answer of another one; the reading is repeated, because the screen warns when it moves on.
 */
export function useEffectiveAccess(options: { enabled?: boolean } = {}) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<EffectiveAccessView>({
    queryKey: effectiveAccessKey(tenant?.id, tenant?.membershipId),
    queryFn: async () => toEffectiveAccess(await client.read('getMyEffectiveAccess')),
    enabled: tenant !== undefined && options.enabled !== false,
    retry: false,
    refetchInterval: REFRESH_MS,
    refetchOnWindowFocus: true,
  });
}
