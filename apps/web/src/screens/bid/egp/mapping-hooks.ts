import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../../api/ApiClientContext';
import { AttemptRegistry } from '../../../api/attempt-registry';
import { useSession } from '../../../session/SessionContext';
import { queryOf, toMappingPage, toSuggestionList } from './mapping-model';
import type { Filters, MappingPage, ProposeBody, SuggestionList } from './mapping-model';

// What the screen shows depends on the places the signed-in membership reaches, not only on the tenant: the membership is part of every key.
function useScopeKey(): readonly ['bid-egp', string | undefined, string | undefined] {
  const { tenant } = useSession();
  return ['bid-egp', tenant?.id, tenant?.membershipId];
}

type Query = Record<string, string | number | undefined>;
const q = (value: Query): never => value as never;

/** The mappings, page by page: "load more" asks for the next cursor and keeps what is shown. */
export function useMappings(filters: Filters) {
  const client = useApiClient();
  const key = useScopeKey();
  return useInfiniteQuery<MappingPage, Error, { pages: MappingPage[] }, readonly unknown[], string | undefined>({
    queryKey: [...key, 'mappings', filters],
    initialPageParam: undefined,
    queryFn: async ({ pageParam }) => toMappingPage(await client.read('listEgpMappings', { query: q(queryOf(filters, pageParam)) })),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: key[1] !== undefined,
    retry: false,
  });
}

/** The suggestions waiting for a person: a hint of the server, never a link. */
export function useSuggestions() {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<SuggestionList>({
    queryKey: [...key, 'suggestions'],
    queryFn: async () => toSuggestionList(await client.read('listEgpMappingSuggestions')),
    enabled: key[1] !== undefined,
    retry: false,
  });
}

/** Everything the bidding screens read is refreshed after a mapping changed (the list, its counts and the suggestions). */
function useRefresh(): () => Promise<void> {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ predicate: (query) => query.queryKey[0] === 'bid-egp' });
}

/** The reload of the screen after a conflict: the same refresh, for a button. */
export const useReload = useRefresh;

/** One command of the screen: one idempotency attempt per intention, the reads refreshed after it. */
function useMappingCommand<Input>(send: (input: Input, attempt: ReturnType<AttemptRegistry['forPayload']>) => Promise<unknown>) {
  const refresh = useRefresh();
  const attempts = useRef(new AttemptRegistry());
  return useMutation<unknown, unknown, Input>({
    mutationFn: (input) => send(input, attempts.current.forPayload(input)),
    onSuccess: async () => {
      attempts.current.done();
      await refresh();
    },
    onError: (error) => attempts.current.ended(error),
  });
}

export function usePropose() {
  const client = useApiClient();
  return useMappingCommand<ProposeBody>((body, attempt) => client.command('proposeEgpMapping', { body, attempt }));
}

export interface DecideInput {
  id: string;
  version: number;
  decision: 'APPROVE' | 'REJECT';
  reason: string;
}

export function useDecide() {
  const client = useApiClient();
  return useMappingCommand<DecideInput>((input, attempt) => client.command('decideEgpMapping', { path: { id: input.id }, body: { decision: input.decision, reason: input.reason }, ifMatchVersion: input.version, attempt }));
}

export interface RetireInput {
  id: string;
  version: number;
  reason: string;
}

export function useRetire() {
  const client = useApiClient();
  return useMappingCommand<RetireInput>((input, attempt) => client.command('retireEgpMapping', { path: { id: input.id }, body: { reason: input.reason }, ifMatchVersion: input.version, attempt }));
}
