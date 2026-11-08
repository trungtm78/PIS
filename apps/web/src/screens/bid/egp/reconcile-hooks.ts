import { keepPreviousData, useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../../api/ApiClientContext';
import { AttemptRegistry } from '../../../api/attempt-registry';
import { useSession } from '../../../session/SessionContext';
import { queryOf, toPage, toRunResult } from './reconcile-model';
import type { Filters, ReconcileSubject, ResolveBody, ReconcilePage, RunResult } from './reconcile-model';

// What the screen shows depends on the places the signed-in membership reaches, not only on the tenant: the membership is part of every key.
// The key starts like the other EGP screens', so an import that is applied on BID-24 refreshes this one too.
function useScopeKey(): readonly ['bid-egp', string | undefined, string | undefined] {
  const { tenant } = useSession();
  return ['bid-egp', tenant?.id, tenant?.membershipId];
}

type Query = Record<string, string | number | undefined>;
const q = (value: Query): never => value as never;

/** The items of the reconciliation, page by page: "load more" asks for the next cursor and keeps what is shown. */
export function useReconcileItems(filters: Filters) {
  const client = useApiClient();
  const key = useScopeKey();
  return useInfiniteQuery<ReconcilePage, Error, { pages: ReconcilePage[] }, readonly unknown[], string | undefined>({
    queryKey: [...key, 'reconcile', filters],
    initialPageParam: undefined,
    queryFn: async ({ pageParam }) => toPage(await client.read('listEgpReconciliationItems', { query: q(queryOf(filters, pageParam)) })),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: key[1] !== undefined,
    // A change of filter keeps the chips and the rows of the view before it on the screen until the new one has come.
    placeholderData: keepPreviousData,
    retry: false,
  });
}

/** Everything the bidding screens of the network read is refreshed after the reconciliation changed. */
function useRefresh(): () => Promise<void> {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ predicate: (query) => query.queryKey[0] === 'bid-egp' });
}

/** The reload of the screen after a conflict: the same refresh, for a button. */
export const useReload = useRefresh;

/** One command of the screen: one idempotency attempt per intention, the reads refreshed after it. */
function useReconcileCommand<Input, Output>(send: (input: Input, attempt: ReturnType<AttemptRegistry['forPayload']>) => Promise<Output>) {
  const refresh = useRefresh();
  const attempts = useRef(new AttemptRegistry());
  return useMutation<Output, unknown, Input>({
    mutationFn: (input) => send(input, attempts.current.forPayload(input)),
    onSuccess: async () => {
      attempts.current.done();
      await refresh();
    },
    onError: (error) => attempts.current.ended(error),
  });
}

export interface RunInput {
  subject?: ReconcileSubject | undefined;
}

/** Runs the reconciliation: one item for each field that differs, nothing new when it is run again. */
export function useRunReconciliation() {
  const client = useApiClient();
  return useReconcileCommand<RunInput, RunResult>(async (input, attempt) => toRunResult(await client.command('runEgpReconciliation', { body: input.subject === undefined ? {} : { subject_type: input.subject }, attempt })));
}

export interface ResolveInput {
  id: string;
  version: number;
  body: ResolveBody;
}

/** Settles one item under the version the caller saw (the server refuses when it moved: 409 VERSION_CONFLICT). */
export function useResolveItem() {
  const client = useApiClient();
  return useReconcileCommand<ResolveInput, unknown>((input, attempt) => client.command('resolveEgpReconciliationItem', { path: { id: input.id }, body: input.body, ifMatchVersion: input.version, attempt }));
}
