import { useInfiniteQuery } from '@tanstack/react-query';
import { useApiClient } from '../../../api/ApiClientContext';
import { useSession } from '../../../session/SessionContext';
import { ledgerQuery, toLedgerPage } from './model';
import type { LedgerFilter, LedgerPage } from './model';

const PAGE_SIZE = 25;

/** The entries of the capital ledger for a filter, newest first, a page at a time; the balance of the whole filter comes with every page. */
export function useLedger(filter: LedgerFilter, enabled: boolean) {
  const client = useApiClient();
  const { tenant } = useSession();
  // What the ledger shows depends on the scope of the membership that is signed in, so the membership is part of the key.
  const key = ['cap', tenant?.id, tenant?.membershipId, 'ledger', filter] as const;
  return useInfiniteQuery<LedgerPage, Error, { pages: LedgerPage[] }, readonly unknown[], string | undefined>({
    queryKey: key,
    initialPageParam: undefined,
    queryFn: async ({ pageParam }) => toLedgerPage(await client.read('listCapitalLedger', { query: { ...ledgerQuery(filter), limit: PAGE_SIZE, ...(pageParam === undefined ? {} : { cursor: pageParam }) } })),
    getNextPageParam: (last) => last.nextCursor,
    enabled: enabled && tenant?.id !== undefined,
    retry: false,
  });
}
