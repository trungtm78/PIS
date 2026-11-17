import { useQuery } from '@tanstack/react-query';
import { useSession } from '../../session/SessionContext';
import { assemble } from './sources/assemble';
import type { DashboardData } from './sources/assemble';
import { loadTemplateDb } from './sources/template-db';

export const dashKey = (tenantId: string | undefined, membershipId: string | undefined) => ['dash9', tenantId, membershipId] as const;

/** The tables of the dashboard for the member of the tenant: read once when the screen opens, and again when the reader asks. */
export function useDashboardData() {
  const { tenant } = useSession();
  return useQuery<DashboardData>({
    queryKey: dashKey(tenant?.id, tenant?.membershipId),
    queryFn: async () => assemble(await loadTemplateDb()),
    enabled: tenant !== undefined,
    retry: false,
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });
}
