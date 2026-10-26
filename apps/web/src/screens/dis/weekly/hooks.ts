import { useInfiniteQuery } from '@tanstack/react-query';
import { useApiClient } from '../../../api/ApiClientContext';
import { useSession } from '../../../session/SessionContext';
import { toWeeklyPlanPage } from './model';
import type { WeeklyPlanPage } from './model';

const PAGE_SIZE = 50;

export interface WeeklyFilter {
  /** The plan year, or undefined for the year of today. */
  planYear: string | undefined;
}

/** The weekly commitments of the projects in the scope of the caller against what the Treasury paid, a page at a time. */
export function useWeeklyPlans(filter: WeeklyFilter) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useInfiniteQuery<WeeklyPlanPage, Error, { pages: WeeklyPlanPage[] }, readonly unknown[], string | undefined>({
    queryKey: ['dis', tenant?.id, 'weekly-plans', filter],
    initialPageParam: undefined,
    queryFn: async ({ pageParam }) =>
      toWeeklyPlanPage(
        await client.read('listWeeklyDisbursementPlans', {
          query: { limit: PAGE_SIZE, ...(filter.planYear === undefined ? {} : { plan_year: Number(filter.planYear) }), ...(pageParam === undefined ? {} : { cursor: pageParam }) },
        }),
      ),
    getNextPageParam: (last) => last.nextCursor,
    enabled: tenant !== undefined,
    retry: false,
  });
}
