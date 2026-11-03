import { keepPreviousData, useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../../api/ApiClientContext';
import { AttemptRegistry } from '../../../api/attempt-registry';
import { useSession } from '../../../session/SessionContext';
import { queryOf, toPage } from './model';
import type { Filter, InteropMessage, MessagePage } from './model';

// What the monitor shows depends on what the signed-in membership may read, not only on the tenant: the membership is part of every key.
function useScopeKey(): readonly ['doc-interop', string | undefined, string | undefined] {
  const { tenant } = useSession();
  return ['doc-interop', tenant?.id, tenant?.membershipId];
}

/** The messages of the tenant, the latest first, a page at a time, narrowed by the filter. Nothing is read before the caller may. */
export function useInteropMessages(filter: Filter, enabled: boolean) {
  const client = useApiClient();
  const key = useScopeKey();
  return useInfiniteQuery<MessagePage, Error, { pages: MessagePage[] }, readonly unknown[], string | undefined>({
    queryKey: [...key, 'list', filter],
    initialPageParam: undefined,
    queryFn: async ({ pageParam }) => toPage(await client.read('listInteropMessages', { query: queryOf(filter, pageParam) })),
    getNextPageParam: (last) => last.next,
    // A new filter keeps the table it replaces on the screen until its own answer comes, so that the filter itself never disappears under a loading state.
    placeholderData: keepPreviousData,
    enabled: enabled && key[1] !== undefined,
    retry: false,
  });
}

/**
 * Sending a failed or dead message again. It names the version of the message the person saw (If-Match), and each message keeps the idempotency attempt of its own intention, so a retry after a lost answer is the same
 * request. A refusal ends the intention; the messages are read again whatever the answer was, so that a person who met a version conflict, or a message the job had already taken, sees what stands now.
 */
export function useRetryInteropMessage() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const key = useScopeKey();
  const attempts = useRef(new Map<string, AttemptRegistry>());
  const registryOf = (id: string): AttemptRegistry => {
    const found = attempts.current.get(id) ?? new AttemptRegistry();
    attempts.current.set(id, found);
    return found;
  };
  return useMutation<unknown, unknown, InteropMessage>({
    mutationFn: (message) => client.command('retryInteropMessage', { path: { id: message.id }, ifMatchVersion: message.version, attempt: registryOf(message.id).forPayload({ id: message.id, version: message.version }) }),
    onSuccess: (_answer, message) => attempts.current.delete(message.id),
    onError: (error, message) => registryOf(message.id).ended(error),
    onSettled: () => queryClient.invalidateQueries({ queryKey: key }),
  });
}
