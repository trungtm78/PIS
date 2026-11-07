import { useQuery } from '@tanstack/react-query';
import { useApiClient } from '../../api/ApiClientContext';
import { useSession } from '../../session/SessionContext';
import { homeRoot } from './hooks';
import { toCashFlow } from './overview-model';
import type { CashFlow } from './overview-model';
import { toWarningPage } from './warning-model';
import type { WarningItem } from './warning-model';

/** How many open warnings the analysis of the causes reads at most (the contract's own limit of a page). */
export const CAUSE_SAMPLE = 200;

/**
 * The cumulative curve of the year by month, of the snapshot the leader reads. It has its own state: a curve that cannot be read is said so in its card, and the rest of the page stands. Nothing is drawn as 0 for a month
 * that has no figure.
 */
export function useCashFlow(snapshotId: string | undefined, unitId: string) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<CashFlow>({
    queryKey: [...homeRoot(tenant?.id), 'cash-flow', tenant?.membershipId, snapshotId ?? '', unitId],
    queryFn: async () => {
      const flow = toCashFlow(await client.read('getDisbursementForecast', { query: { ...(snapshotId === undefined || snapshotId === '' ? {} : { snapshot_id: snapshotId }), ...(unitId === '' ? {} : { unit_id: unitId }), limit: 1 } }));
      if (flow === undefined) throw new Error('the cash flow could not be read');
      return flow;
    },
    enabled: tenant !== undefined,
    retry: false,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
}

/** The open warnings the causes are read from: one page of the largest size, because the analysis counts and does not list. */
export function useCauseWarnings() {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<WarningItem[]>({
    queryKey: [...homeRoot(tenant?.id), 'causes', tenant?.membershipId],
    queryFn: async () => toWarningPage(await client.read('getHomeWarnings', { query: { limit: CAUSE_SAMPLE } })).items,
    enabled: tenant !== undefined,
    retry: false,
  });
}
