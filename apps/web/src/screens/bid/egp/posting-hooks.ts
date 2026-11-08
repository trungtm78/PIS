import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../../api/ApiClientContext';
import { AttemptRegistry } from '../../../api/attempt-registry';
import { useSession } from '../../../session/SessionContext';
import { queryOf, toDetail, toPage, toSweepResult } from './posting-model';
import type { Filters, OpenBody, PostingDetail, PostingPage, SweepResult } from './posting-model';

// What the screen shows depends on the places the signed-in membership reaches, not only on the tenant: the membership is part of every key.
// The key starts like the other EGP screens', so a file applied on BID-24 or a mapping approved on BID-23 refreshes this one too.
function useScopeKey(): readonly ['bid-egp', string | undefined, string | undefined] {
  const { tenant } = useSession();
  return ['bid-egp', tenant?.id, tenant?.membershipId];
}

type Query = Record<string, string | number | undefined>;
const q = (value: Query): never => value as never;

/** The duties, page by page: "load more" asks for the next cursor and keeps what is shown; a change of filter keeps the view before it until the new one has come. */
export function usePostings(filters: Filters) {
  const client = useApiClient();
  const key = useScopeKey();
  return useInfiniteQuery<PostingPage, Error, { pages: PostingPage[] }, readonly unknown[], string | undefined>({
    queryKey: [...key, 'postings', filters],
    initialPageParam: undefined,
    queryFn: async ({ pageParam }) => toPage(await client.read('listEgpObligations', { query: q(queryOf(filters, pageParam)) })),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: key[1] !== undefined,
    placeholderData: keepPreviousData,
    retry: false,
  });
}

/** One duty with its history, the fields the kind needs and what our register can offer to fill them (read when a dialog asks). */
export function usePostingDetail(id: string | undefined) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<PostingDetail>({
    queryKey: [...key, 'posting', id],
    queryFn: async () => toDetail(await client.read('getEgpObligation', { path: { id: id as string } })),
    enabled: key[1] !== undefined && id !== undefined,
    retry: false,
  });
}

/** Everything the screens of the network read is refreshed after a duty changed. */
function useRefresh(): () => Promise<void> {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ predicate: (query) => query.queryKey[0] === 'bid-egp' });
}

/** The reload of the screen after a conflict: the same refresh, for a button. */
export const useReload = useRefresh;

/** One command of the screen: one idempotency attempt per intention, the reads refreshed after it. */
function usePostingCommand<Input, Output>(send: (input: Input, attempt: ReturnType<AttemptRegistry['forPayload']>) => Promise<Output>) {
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

export function useOpenPosting() {
  const client = useApiClient();
  return usePostingCommand<OpenBody, unknown>((body, attempt) => client.command('openEgpObligation', { body, attempt }));
}

export interface SweepInput {
  sinceOn: string;
}

/** Opens the duties of the facts the register states from a cutover day (the server's default when none is given); running it again opens nothing. */
export function useSweepPostings() {
  const client = useApiClient();
  return usePostingCommand<SweepInput, SweepResult>(async (input, attempt) => toSweepResult(await client.command('sweepEgpObligations', { body: input.sinceOn === '' ? {} : { since_on: input.sinceOn }, attempt })));
}

export interface MoveInput {
  id: string;
  version: number;
}

export function usePreparePosting() {
  const client = useApiClient();
  return usePostingCommand<MoveInput & { body: { fields?: Record<string, string>; export_batch_id?: string } }, unknown>((input, attempt) =>
    client.command('prepareEgpObligation', { path: { id: input.id }, body: input.body, ifMatchVersion: input.version, attempt }),
  );
}

export function useSubmitPosting() {
  const client = useApiClient();
  return usePostingCommand<MoveInput, unknown>((input, attempt) => client.command('submitEgpObligation', { path: { id: input.id }, ifMatchVersion: input.version, attempt }));
}

export function useReceiptPosting() {
  const client = useApiClient();
  return usePostingCommand<MoveInput & { body: { receipt_ref: string; receipted_at?: string } }, unknown>((input, attempt) =>
    client.command('receiptEgpObligation', { path: { id: input.id }, body: input.body, ifMatchVersion: input.version, attempt }),
  );
}

export function useRejectPosting() {
  const client = useApiClient();
  return usePostingCommand<MoveInput & { reason: string }, unknown>((input, attempt) => client.command('rejectEgpObligation', { path: { id: input.id }, body: { reason: input.reason }, ifMatchVersion: input.version, attempt }));
}

export function useCancelPosting() {
  const client = useApiClient();
  return usePostingCommand<MoveInput & { reason: string }, unknown>((input, attempt) => client.command('cancelEgpObligation', { path: { id: input.id }, body: { reason: input.reason }, ifMatchVersion: input.version, attempt }));
}
