import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../../api/ApiClientContext';
import { AttemptRegistry } from '../../../api/attempt-registry';
import { useSession } from '../../../session/SessionContext';
import { isRunning, toRestorePage } from './model';
import type { RestorePage, RestoreTarget } from './model';

/** How often the list is read while a restore is waiting for the worker or running, and the pace of the one that is not (a restore ends on the server). */
export const RUNNING_REFRESH_MS = 5_000;
export const IDLE_REFRESH_MS = 60_000;

export const restoresKey = (sessionTenantId: string | undefined, tenantId: string | undefined) => ['sas', 'restores', sessionTenantId, tenantId ?? 'none'] as const;

/** The restores of a tenant, the newest first, with the window of the recovery points and the targets (`listTenantRestoreRequests`). */
export function useTenantRestores(tenantId: string | undefined, enabled: boolean) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useInfiniteQuery<RestorePage | undefined, Error, { pages: Array<RestorePage | undefined> }, ReturnType<typeof restoresKey>, string | undefined>({
    queryKey: restoresKey(tenant?.id, tenantId),
    initialPageParam: undefined,
    queryFn: async ({ pageParam }) => toRestorePage(await client.read('listTenantRestoreRequests', { path: { tenantId: tenantId as string }, query: pageParam === undefined ? {} : { cursor: pageParam } })),
    getNextPageParam: (last) => last?.nextCursor,
    enabled: enabled && tenant !== undefined && tenantId !== undefined,
    refetchInterval: (query) => (query.state.data?.pages.some((page) => page?.items.some(isRunning) === true) === true ? RUNNING_REFRESH_MS : IDLE_REFRESH_MS),
    retry: false,
  });
}

export interface AskRestoreInput {
  tenantId: string;
  recoveryPoint: string;
  target: RestoreTarget;
  reason: string;
}

export interface DecideRestoreInput {
  tenantId: string;
  restoreId: string;
  version: number;
  decision: 'approve' | 'reject';
  reason: string;
}

function useRestoreMutation<I extends { tenantId: string }>(run: (client: ReturnType<typeof useApiClient>, input: I, attempt: ReturnType<AttemptRegistry['forPayload']>) => Promise<unknown>) {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const { tenant } = useSession();
  const attempts = useRef(new AttemptRegistry());
  return useMutation<unknown, Error, I>({
    mutationFn: (input) => run(client, input, attempts.current.forPayload(input)),
    onSuccess: async (_result, input) => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: restoresKey(tenant?.id, input.tenantId) });
    },
    // A refusal (a request already decided, a stale version) means the list on the screen is out of date: it is read again.
    onError: async (error, input) => {
      attempts.current.ended(error);
      await queryClient.invalidateQueries({ queryKey: restoresKey(tenant?.id, input.tenantId) });
    },
  });
}

/** Asks for a restore of the tenant to a recovery point (`requestTenantRestore`). */
export function useAskRestore() {
  return useRestoreMutation<AskRestoreInput>((client, input, attempt) =>
    client.command('requestTenantRestore', { path: { tenantId: input.tenantId }, body: { recovery_point: input.recoveryPoint, target: input.target, reason: input.reason } as never, attempt }),
  );
}

/** Approves or turns down a request that another System Admin made (`decideTenantRestore`). */
export function useDecideRestore() {
  return useRestoreMutation<DecideRestoreInput>((client, input, attempt) =>
    client.command('decideTenantRestore', { path: { restoreId: input.restoreId }, body: { decision: input.decision, reason: input.reason, evidence_ids: [] } as never, ifMatchVersion: input.version, attempt }),
  );
}
