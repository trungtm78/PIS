import { useInfiniteQuery } from '@tanstack/react-query';
import { useApiClient } from '../../../api/ApiClientContext';
import { useSession } from '../../../session/SessionContext';
import { PAGE_SIZE, toSearchPage } from './model';
import type { SearchPage } from './model';

export const searchKey = (tenantId: string | undefined, membershipId: string | undefined, query: string) => ['iam', 'search', tenantId, membershipId, query] as const;

/** The hits for a keyword, a page at a time (`searchGlobal`). What a person finds depends on their scope, so the membership is part of the key; nothing is read until a keyword is submitted and the permission is held. */
export function useSearch(query: string, enabled: boolean) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useInfiniteQuery<SearchPage, Error, { pages: SearchPage[] }, ReturnType<typeof searchKey>, string | undefined>({
    queryKey: searchKey(tenant?.id, tenant?.membershipId, query),
    initialPageParam: undefined,
    queryFn: async ({ pageParam }) => toSearchPage(await client.read('searchGlobal', { query: { q: query, limit: PAGE_SIZE, ...(pageParam === undefined ? {} : { cursor: pageParam }) } })),
    getNextPageParam: (last) => last.nextCursor,
    enabled: enabled && tenant !== undefined,
    retry: false,
  });
}
