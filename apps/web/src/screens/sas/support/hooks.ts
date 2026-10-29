import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../../api/ApiClientContext';
import { AttemptRegistry } from '../../../api/attempt-registry';
import { useSession } from '../../../session/SessionContext';
import { toGrantPage } from './model';
import type { AccessMode, GrantPage } from './model';

/** How often the screen reads again while it stays open: a grant starts, ends or is revoked elsewhere without this client doing anything, and the notice of access in force must follow it. */
export const REFRESH_MS = 30_000;

export const grantsKey = (sessionTenantId: string | undefined) => ['sas', 'support-grants', sessionTenantId] as const;

/** The support access grants of the tenant of the session, the newest request first, page by page (`get_resources_support_access_grant`). */
export function useSupportGrants(enabled: boolean) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useInfiniteQuery<GrantPage, Error, { pages: GrantPage[] }, ReturnType<typeof grantsKey>, string | undefined>({
    queryKey: grantsKey(tenant?.id),
    initialPageParam: undefined,
    queryFn: async ({ pageParam }) => toGrantPage(await client.read('get_resources_support_access_grant', { query: pageParam === undefined ? {} : { cursor: pageParam } })),
    getNextPageParam: (last) => last.nextCursor,
    enabled: enabled && tenant !== undefined,
    refetchInterval: REFRESH_MS,
    retry: false,
  });
}

/** The grants that let their operator in at this moment, whatever page of the history they would fall on: the banner of the screen is a security notice and does not wait for "more" (the most a tenant can have open is far below the limit of a page). */
export function useGrantsInForce(enabled: boolean) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<GrantPage>({
    queryKey: [...grantsKey(tenant?.id), 'in-force'],
    queryFn: async () => toGrantPage(await client.read('get_resources_support_access_grant', { query: { in_force: true, limit: 200 } as never })),
    enabled: enabled && tenant !== undefined,
    refetchInterval: REFRESH_MS,
    retry: false,
  });
}

export interface RequestInput {
  tenantId: string;
  ticketReference: string;
  modules: string[];
  accessMode: AccessMode;
  durationMinutes: number;
  reason: string;
}

/** The operator's request (`requestSupportAccess`). It gives nothing: the grant waits for the people of the tenant. */
export function useRequestSupport() {
  const client = useApiClient();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: (input: RequestInput) =>
      client.command('requestSupportAccess', {
        body: { tenant_id: input.tenantId, ticket_reference: input.ticketReference, scope: { modules: input.modules }, access_mode: input.accessMode, duration_minutes: input.durationMinutes, reason: input.reason } as never,
        attempt: attempts.current.forPayload(input),
      }),
    onSuccess: () => attempts.current.done(),
    onError: (error) => attempts.current.ended(error),
  });
}

export interface DecideInput {
  grantId: string;
  version: number;
  decision: 'approve' | 'reject';
  reason: string;
  startsAt?: string;
}

/** One person of the tenant approves or rejects a request (`post_support_access_id_approve`). */
export function useDecideSupport() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const { tenant } = useSession();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: (input: DecideInput) =>
      client.command('post_support_access_id_approve', {
        path: { id: input.grantId },
        body: { decision: input.decision, reason: input.reason, ...(input.startsAt === undefined ? {} : { starts_at: input.startsAt }) } as never,
        ifMatchVersion: input.version,
        attempt: attempts.current.forPayload(input),
      }),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: grantsKey(tenant?.id) });
    },
    onError: (error) => attempts.current.ended(error),
  });
}

export interface RevokeInput {
  grantId: string;
  version: number;
  reason: string;
}

/** The tenant takes a grant back, at any time (`revokeSupportAccess`). */
export function useRevokeSupport() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const { tenant } = useSession();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: (input: RevokeInput) => client.command('revokeSupportAccess', { path: { id: input.grantId }, body: { reason: input.reason } as never, ifMatchVersion: input.version, attempt: attempts.current.forPayload(input) }),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: grantsKey(tenant?.id) });
    },
    onError: (error) => attempts.current.ended(error),
  });
}
