import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../../api/ApiClientContext';
import { AttemptRegistry } from '../../../api/attempt-registry';
import { useSession } from '../../../session/SessionContext';
import { isSettling, toChallenge, toDomainPage } from './model';
import type { ChallengeView, DomainKind, DomainPage } from './model';

/** How often the list is read while a domain waits for its certificate, and the pace of the one that does not (the weekly recheck and the renewal happen on the server). */
export const SETTLING_REFRESH_MS = 5_000;
export const IDLE_REFRESH_MS = 60_000;

export const domainsKey = (sessionTenantId: string | undefined, tenantId: string | undefined) => ['sas', 'domains', sessionTenantId, tenantId ?? 'none'] as const;

/** The domains of a tenant, the newest first (`listTenantDomains`); read again quickly while one waits for its certificate. */
export function useTenantDomains(tenantId: string | undefined, enabled: boolean) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useInfiniteQuery<DomainPage, Error, { pages: DomainPage[] }, ReturnType<typeof domainsKey>, string | undefined>({
    queryKey: domainsKey(tenant?.id, tenantId),
    initialPageParam: undefined,
    queryFn: async ({ pageParam }) => toDomainPage(await client.read('listTenantDomains', { path: { tenantId: tenantId as string }, query: pageParam === undefined ? {} : { cursor: pageParam } })),
    getNextPageParam: (last) => last.nextCursor,
    enabled: enabled && tenant !== undefined && tenantId !== undefined,
    refetchInterval: (query) => (query.state.data?.pages.some((page) => page.items.some(isSettling)) === true ? SETTLING_REFRESH_MS : IDLE_REFRESH_MS),
    retry: false,
  });
}

export interface AddDomainInput {
  tenantId: string;
  hostname: string;
  kind: DomainKind;
}

export interface DomainActionInput {
  tenantId: string;
  domainId: string;
  version: number;
  reason: string;
}

function useDomainMutation<I extends { tenantId: string }, R>(run: (client: ReturnType<typeof useApiClient>, input: I, attempt: ReturnType<AttemptRegistry['forPayload']>) => Promise<R>) {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const { tenant } = useSession();
  const attempts = useRef(new AttemptRegistry());
  return useMutation<R, Error, I>({
    mutationFn: (input) => run(client, input, attempts.current.forPayload(input)),
    onSuccess: async (_result, input) => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: domainsKey(tenant?.id, input.tenantId) });
    },
    // A refused check still moved the time of the last check: the list is read again.
    onError: async (error, input) => {
      attempts.current.ended(error);
      await queryClient.invalidateQueries({ queryKey: domainsKey(tenant?.id, input.tenantId) });
    },
  });
}

/** Attaches a domain to a tenant (`addTenantDomain`); the TXT value comes back once and is not kept by the cache. */
export function useAddDomain() {
  return useDomainMutation<AddDomainInput, ChallengeView | undefined>(async (client, input, attempt) =>
    toChallenge(await client.command('addTenantDomain', { path: { tenantId: input.tenantId }, body: { hostname: input.hostname, kind: input.kind } as never, attempt })),
  );
}

/** Looks for the proof in the DNS (`verifyTenantDomain`); the platform answers 422 DOMAIN_UNVERIFIED while it is not there. */
export function useVerifyDomain() {
  return useDomainMutation<DomainActionInput, unknown>((client, input, attempt) =>
    client.command('verifyTenantDomain', { path: { domainId: input.domainId }, body: { reason: input.reason } as never, ifMatchVersion: input.version, attempt }),
  );
}

/** Releases a domain (`removeTenantDomain`); its hostname is held for 90 days. */
export function useRemoveDomain() {
  return useDomainMutation<DomainActionInput, unknown>((client, input, attempt) =>
    client.command('removeTenantDomain', { path: { domainId: input.domainId }, body: { reason: input.reason } as never, ifMatchVersion: input.version, attempt }),
  );
}
