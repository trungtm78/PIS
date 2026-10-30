import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../../api/ApiClientContext';
import { AttemptRegistry } from '../../../api/attempt-registry';
import { useSession } from '../../../session/SessionContext';
import { toPolicyPage, toReplyPage } from './model';
import type { PolicyPage, ReplyPage } from './model';

// Who reads is part of the key, as for every read that depends on the permission of the person.
export const policyKey = (tenantId: string | undefined, membershipId: string | undefined) => ['omni', 'policy', tenantId, membershipId] as const;
export const replyKey = (tenantId: string | undefined, membershipId: string | undefined) => ['omni', 'canned-replies', tenantId, membershipId] as const;

/** The versions of the routing policy, newest first, a page at a time (`listRoutingPolicies`); the first page also carries the units a rule may name. */
export function usePolicies(enabled: boolean) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useInfiniteQuery<PolicyPage, Error, { pages: PolicyPage[] }, readonly unknown[], string | undefined>({
    queryKey: policyKey(tenant?.id, tenant?.membershipId),
    initialPageParam: undefined,
    queryFn: async ({ pageParam }) => toPolicyPage(await client.read('listRoutingPolicies', { query: pageParam === undefined ? {} : { cursor: pageParam } })),
    getNextPageParam: (last) => last.nextCursor,
    enabled: enabled && tenant !== undefined,
    retry: false,
  });
}

/** The canned replies by code, a page at a time (`listCannedReplies`). */
export function useReplies(enabled: boolean) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useInfiniteQuery<ReplyPage, Error, { pages: ReplyPage[] }, readonly unknown[], string | undefined>({
    queryKey: replyKey(tenant?.id, tenant?.membershipId),
    initialPageParam: undefined,
    queryFn: async ({ pageParam }) => toReplyPage(await client.read('listCannedReplies', { query: pageParam === undefined ? {} : { cursor: pageParam } })),
    getNextPageParam: (last) => last.nextCursor,
    enabled: enabled && tenant !== undefined,
    retry: false,
  });
}

/** One command: keeps its idempotency attempt across retries and reads the list again, also after a refusal (it can follow a change made by someone else). */
function useListCommand<Input>(key: (tenantId: string | undefined, membershipId: string | undefined) => readonly unknown[], run: (client: ReturnType<typeof useApiClient>, input: Input, attempt: { key: string }) => Promise<unknown>) {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const { tenant } = useSession();
  const attempts = useRef(new AttemptRegistry());
  const refresh = (): Promise<void> => queryClient.invalidateQueries({ queryKey: key(tenant?.id, tenant?.membershipId) });
  return useMutation({
    mutationFn: (input: Input) => run(client, input, attempts.current.forPayload(input)),
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

export const useCreatePolicy = () => useListCommand<Record<string, unknown>>(policyKey, (client, body, attempt) => client.command('createRoutingPolicyVersion', { body: body as never, attempt }));

export interface PublishInput {
  id: string;
  version: number;
  reason: string;
}

export const usePublishPolicy = () =>
  useListCommand<PublishInput>(policyKey, (client, input, attempt) => client.command('publishRoutingPolicy', { path: { policyId: input.id }, body: { reason: input.reason }, ifMatchVersion: input.version, attempt }));

export interface SaveReplyInput {
  /** The reply that is changed, with the version read; none makes a new one. */
  existing: { id: string; version: number } | undefined;
  body: Record<string, unknown>;
}

export const useSaveReply = () =>
  useListCommand<SaveReplyInput>(replyKey, (client, input, attempt) =>
    input.existing === undefined
      ? client.command('createCannedReply', { body: input.body as never, attempt })
      : client.command('updateCannedReply', { path: { replyId: input.existing.id }, body: input.body as never, ifMatchVersion: input.existing.version, attempt }),
  );
