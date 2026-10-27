import { useInfiniteQuery } from '@tanstack/react-query';
import { useApiClient } from '../../../api/ApiClientContext';
import { useSession } from '../../../session/SessionContext';
import { toForecast } from './model';
import type { Forecast } from './model';

const PAGE_SIZE = 50;

/** The next page of the same snapshot the first page was of: a snapshot frozen while the screen is open must not slip into the middle of the list. */
interface PageParam {
  cursor: string;
  snapshotId: string;
}

/** The year-end estimate and the curve over a frozen snapshot (the latest frozen close snapshot when none is named): the totals come with the first page, the projects a page at a time. */
export function useForecast(snapshotId: string) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useInfiniteQuery<Forecast | undefined, Error, { pages: Array<Forecast | undefined> }, readonly unknown[], PageParam | undefined>({
    queryKey: ['dis', tenant?.id, 'forecast', snapshotId],
    initialPageParam: undefined,
    queryFn: async ({ pageParam }) =>
      toForecast(await client.read('getDisbursementForecast', { query: { limit: PAGE_SIZE, ...(pageParam !== undefined ? { snapshot_id: pageParam.snapshotId, cursor: pageParam.cursor } : snapshotId === '' ? {} : { snapshot_id: snapshotId }) } })),
    getNextPageParam: (last) => (last?.nextCursor === undefined ? undefined : { cursor: last.nextCursor, snapshotId: last.snapshotId }),
    enabled: tenant !== undefined,
    retry: false,
  });
}
