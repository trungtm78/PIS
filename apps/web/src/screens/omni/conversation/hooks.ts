import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../../api/ApiClientContext';
import { AttemptRegistry } from '../../../api/attempt-registry';
import { useSession } from '../../../session/SessionContext';
import { queryOf, toAssignees, toConversationPage } from './model';
import type { Assignee, ConversationPage, Filters } from './model';

// Who reads is part of the key, as for every read that depends on the scope of the person; the filters are part of it too.
export const conversationsKey = (tenantId: string | undefined, membershipId: string | undefined) => ['omni', 'conversations', tenantId, membershipId] as const;

/** The conversations in the queues of the reader and those assigned to them, newest first, a page at a time (`get_resources_conversation`). */
export function useConversations(filters: Filters, enabled: boolean) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useInfiniteQuery<ConversationPage, Error, { pages: ConversationPage[] }, readonly unknown[], string | undefined>({
    queryKey: [...conversationsKey(tenant?.id, tenant?.membershipId), filters.status, filters.mine],
    initialPageParam: undefined,
    queryFn: async ({ pageParam }) => toConversationPage(await client.read('get_resources_conversation', { query: queryOf(filters, pageParam) as never })),
    getNextPageParam: (last) => last.nextCursor,
    enabled: enabled && tenant !== undefined,
    retry: false,
  });
}

/** The members a conversation can be given to, read when the assignment is opened (`listConversationAssignees`). */
export function useAssignees(conversationId: string | undefined) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<Assignee[]>({
    queryKey: [...conversationsKey(tenant?.id, tenant?.membershipId), 'assignees', conversationId ?? 'none'],
    queryFn: async () => toAssignees(await client.read('listConversationAssignees', { path: { conversationId: conversationId as string } })),
    enabled: conversationId !== undefined && tenant !== undefined,
    retry: false,
  });
}

export interface AssignInput {
  conversationId: string;
  version: number;
  assigneeId: string;
  reason: string | undefined;
}

/** Gives a conversation to a member: versioned (a stale version is a 409), one idempotency attempt per intention, and the list is read again whatever the answer, since a refusal can follow a change made by someone else. */
export function useAssignConversation() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const { tenant } = useSession();
  const attempts = useRef(new AttemptRegistry());
  const refresh = (): Promise<void> => queryClient.invalidateQueries({ queryKey: conversationsKey(tenant?.id, tenant?.membershipId) });
  return useMutation({
    mutationFn: (input: AssignInput) =>
      client.command('assignConversation', {
        path: { conversationId: input.conversationId },
        body: { assignee_membership_id: input.assigneeId, ...(input.reason === undefined ? {} : { reason: input.reason }) },
        ifMatchVersion: input.version,
        attempt: attempts.current.forPayload(input),
      }),
    onSuccess: async () => {
      attempts.current.done();
      await refresh();
    },
    onError: async (error) => {
      attempts.current.ended(error);
      await refresh();
    },
  });
}
