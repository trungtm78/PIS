import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useApiClient } from '../../../api/ApiClientContext';
import { useSession } from '../../../session/SessionContext';
import { drillQueryOf, toBoard } from './model';
import type { Board, DrillQuery } from './model';

const root = (tenantId: string | undefined) => ['dis', tenantId, 'board'] as const;
const PAGE_SIZE = 100;

/** The board of a period: the numbers of each unit and of all of them. */
export function useBoard(periodId: string | undefined) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<Board | undefined>({
    queryKey: [...root(tenant?.id), 'units', periodId ?? ''],
    queryFn: async () => toBoard(await client.read('getSubmissionProgress', { path: { id: periodId ?? '' } })),
    enabled: tenant !== undefined && periodId !== undefined,
    retry: false,
  });
}

/** The exact projects a number of the board counted, a page at a time, with their narrative when it is asked for. */
export function useDrill(periodId: string | undefined, query: DrillQuery | undefined) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useInfiniteQuery<Board | undefined, Error, { pages: Array<Board | undefined> }, readonly unknown[], string | undefined>({
    queryKey: [...root(tenant?.id), 'drill', periodId ?? '', query ?? null],
    initialPageParam: undefined,
    queryFn: async ({ pageParam }) => toBoard(await client.read('getSubmissionProgress', { path: { id: periodId ?? '' }, query: drillQueryOf(query as DrillQuery, pageParam, PAGE_SIZE) })),
    getNextPageParam: (last) => last?.nextCursor,
    enabled: tenant !== undefined && periodId !== undefined && query !== undefined,
    retry: false,
  });
}
