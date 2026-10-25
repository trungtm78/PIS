import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../../api/ApiClientContext';
import { AttemptRegistry } from '../../../api/attempt-registry';
import { useSession } from '../../../session/SessionContext';
import { toOverridePage } from './model';
import type { OverridePage } from './model';

export const OVERRIDE_PAGE_SIZE = 50;

export const overridesKey = (sessionTenantId: string | undefined, tenantId: string | undefined) => ['sas', 'overrides', sessionTenantId, tenantId ?? 'none'] as const;

/** The overrides of a tenant, page by page (keyset cursor), the latest to start first. */
export function useOverrides(tenantId: string | undefined, enabled: boolean) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useInfiniteQuery<OverridePage, Error, { pages: OverridePage[] }, ReturnType<typeof overridesKey>, string | undefined>({
    queryKey: overridesKey(tenant?.id, tenantId),
    initialPageParam: undefined,
    queryFn: async ({ pageParam }) =>
      toOverridePage(
        await client.read('listTenantEntitlementOverrides', {
          path: { tenantId: tenantId ?? '' },
          query: {
            limit: OVERRIDE_PAGE_SIZE,
            ...(pageParam === undefined ? {} : { cursor: pageParam }),
          },
        }),
      ),
    getNextPageParam: (last) => last.nextCursor,
    enabled: enabled && tenant !== undefined && tenantId !== undefined,
    retry: false,
  });
}

// A decision changes what the tenant may do, so the table of entitlements of the screen is read again with the list.
function useCommand<Input>(send: (input: Input, attempt: ReturnType<AttemptRegistry['forPayload']>) => Promise<unknown>) {
  const queryClient = useQueryClient();
  const { tenant } = useSession();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: (input: Input) => send(input, attempts.current.forPayload(input)),
    onSuccess: async () => {
      attempts.current.done();
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ['sas', 'overrides', tenant?.id],
        }),
        queryClient.invalidateQueries({
          queryKey: ['sas', 'entitlements', tenant?.id],
        }),
      ]);
    },
    onError: (error) => attempts.current.ended(error),
  });
}

export function useRequestOverride() {
  const client = useApiClient();
  return useCommand<{ tenantId: string; body: Record<string, unknown> }>((input, attempt) =>
    client.command('requestEntitlementOverride', {
      path: { tenantId: input.tenantId },
      body: input.body as never,
      attempt,
    }),
  );
}

export interface DecideInput {
  overrideId: string;
  version: number;
  decision: 'approve' | 'reject';
  reason: string;
}

export function useDecideOverride() {
  const client = useApiClient();
  return useCommand<DecideInput>((input, attempt) =>
    client.command('decideEntitlementOverride', {
      path: { overrideId: input.overrideId },
      body: {
        decision: input.decision,
        reason: input.reason,
        evidence_ids: [],
      } as never,
      ifMatchVersion: input.version,
      attempt,
    }),
  );
}

export interface RevokeInput {
  overrideId: string;
  version: number;
  reason: string;
}

export function useRevokeOverride() {
  const client = useApiClient();
  return useCommand<RevokeInput>((input, attempt) =>
    client.command('revokeEntitlementOverride', {
      path: { overrideId: input.overrideId },
      body: { reason: input.reason } as never,
      ifMatchVersion: input.version,
      attempt,
    }),
  );
}
