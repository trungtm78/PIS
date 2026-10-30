import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../../api/ApiClientContext';
import { AttemptRegistry } from '../../../api/attempt-registry';
import { useSession } from '../../../session/SessionContext';
import { isWaiting, toAccount, toAccountPage } from './model';
import type { AccountPage, AccountView } from './model';

export const accountsKey = (tenantId: string | undefined) => ['omni', 'channel-accounts', tenantId] as const;

/** The channel accounts of the tenant, newest first, a page at a time (`get_resources_channel_account`). */
export function useAccounts(filters: { status: string; channel: string }, enabled: boolean) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useInfiniteQuery<AccountPage, Error, { pages: AccountPage[] }, readonly unknown[], string | undefined>({
    queryKey: [...accountsKey(tenant?.id), 'list', filters.status, filters.channel],
    initialPageParam: undefined,
    queryFn: async ({ pageParam }) =>
      toAccountPage(
        await client.read('get_resources_channel_account', {
          query: {
            ...(filters.status === '' ? {} : { status: filters.status as 'Active' }),
            ...(filters.channel === '' ? {} : { channel: filters.channel as 'EMAIL' }),
            ...(pageParam === undefined ? {} : { cursor: pageParam }),
          },
        }),
      ),
    getNextPageParam: (last) => last.nextCursor,
    enabled: enabled && tenant !== undefined,
    retry: false,
  });
}

/** One account (`get_resources_channel_account_id`). While a verification waits for the provider it is read again every few seconds, so the answer shows without a reload. */
export function useAccount(id: string | undefined, enabled: boolean) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<AccountView | undefined>({
    queryKey: [...accountsKey(tenant?.id), 'one', id ?? 'none'],
    queryFn: async () => toAccount(await client.read('get_resources_channel_account_id', { path: { id: id as string } })),
    enabled: enabled && tenant !== undefined && id !== undefined,
    refetchInterval: (query) => (query.state.data !== undefined && isWaiting(query.state.data) ? 3_000 : false),
    retry: false,
  });
}

function useAccountMutation<I>(run: (client: ReturnType<typeof useApiClient>, input: I, attempt: ReturnType<AttemptRegistry['forPayload']>) => Promise<unknown>) {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const { tenant } = useSession();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: (input: I) => run(client, input, attempts.current.forPayload(input)),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: accountsKey(tenant?.id) });
    },
    onError: (error) => attempts.current.ended(error),
  });
}

export const useConnectAccount = () => useAccountMutation<{ body: Record<string, unknown> }>((client, input, attempt) => client.command('connectChannelAccount', { body: input.body as never, attempt }));

export interface VersionedInput {
  accountId: string;
  version: number;
  reason: string;
}

export const useVerifyAccount = () =>
  useAccountMutation<VersionedInput>((client, input, attempt) => client.command('verifyChannelAccount', { path: { channelAccountId: input.accountId }, body: { reason: input.reason } as never, ifMatchVersion: input.version, attempt }));

export const useDisableAccount = () =>
  useAccountMutation<VersionedInput>((client, input, attempt) => client.command('disableChannelAccount', { path: { channelAccountId: input.accountId }, body: { reason: input.reason } as never, ifMatchVersion: input.version, attempt }));

export interface UpdateInput extends VersionedInput {
  changes: Record<string, unknown>;
}

export const useUpdateAccount = () =>
  useAccountMutation<UpdateInput>((client, input, attempt) =>
    client.command('updateChannelAccount', { path: { channelAccountId: input.accountId }, body: { ...input.changes, reason: input.reason } as never, ifMatchVersion: input.version, attempt }),
  );
