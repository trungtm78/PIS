import { ApiError } from '@machvon/api-client';
import { keepPreviousData, useInfiniteQuery } from '@tanstack/react-query';
import { useApiClient } from '../../../api/ApiClientContext';
import { useScopeKey } from '../hooks';
import { joinPages, toLedger } from './model';
import type { Ledger } from './model';

const PAGE_SIZE = 50;

export interface LedgerFilter {
  itemId: string | null;
  acceptanceId: string | null;
}

/**
 * The ledger of a contract, a page at a time (the lines the server keeps in a stable order). `missing` when the contract is not there for the caller (another tenant, or outside the scope),
 * which is what a 404 means. The contractor of a contract is refused (403) and the screen says so.
 */
export function useLedger(contractId: string | null | undefined, filter: LedgerFilter) {
  const client = useApiClient();
  const key = useScopeKey();
  const query = useInfiniteQuery({
    queryKey: [...key, 'ledger', contractId ?? '', filter.itemId ?? '', filter.acceptanceId ?? ''],
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }): Promise<Ledger | null> => {
      try {
        const read = await client.read('getCumulativeLedger', {
          path: { id: contractId ?? '' },
          query: {
            limit: PAGE_SIZE,
            ...(pageParam === undefined ? {} : { cursor: pageParam }),
            ...(filter.itemId === null ? {} : { boq_item_id: filter.itemId }),
            ...(filter.acceptanceId === null ? {} : { acceptance_id: filter.acceptanceId }),
          },
        });
        return toLedger(read) ?? null;
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return null;
        throw error;
      }
    },
    getNextPageParam: (last: Ledger | null) => last?.nextCursor ?? undefined,
    // A change of filter keeps the lines on the screen (and the filter in its place) until the answer comes.
    placeholderData: keepPreviousData,
    enabled: key[1] !== undefined && typeof contractId === 'string',
    retry: false,
  });
  const pages = (query.data?.pages ?? []).flatMap((page) => (page === null ? [] : [page]));
  const missing = query.data !== undefined && query.data.pages[0] === null;
  return { ...query, ledger: joinPages(pages), missing };
}
