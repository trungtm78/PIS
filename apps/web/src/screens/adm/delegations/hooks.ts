import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../../api/ApiClientContext';
import { AttemptRegistry } from '../../../api/attempt-registry';
import { useSession } from '../../../session/SessionContext';
import { toMember } from '../../dgv/model';
import type { MemberOption } from '../../dgv/model';
import { toDelegation } from './model';
import type { DelegationView } from './model';

const root = (tenantId: string | undefined, membershipId: string | undefined) => ['adm', 'delegations', tenantId, membershipId] as const;

/** The delegations the person gave or received (every page). */
export function useDelegations(role: 'given' | 'received', enabled: boolean) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<DelegationView[]>({
    queryKey: [...root(tenant?.id, tenant?.membershipId), role],
    queryFn: async () => (await client.readAll('get_resources_delegation_grant', { query: { role } })).flatMap((raw) => toDelegation(raw) ?? []),
    enabled: enabled && tenant !== undefined,
    retry: false,
  });
}

/** The active staff a delegation can be made to, read in the scope of the signed-in membership. */
export function useDelegates(enabled: boolean) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<MemberOption[]>({
    queryKey: [...root(tenant?.id, tenant?.membershipId), 'delegates'],
    queryFn: async () => (await client.readAll('get_resources_membership')).flatMap((raw) => toMember(raw) ?? []),
    enabled: enabled && tenant !== undefined,
    retry: false,
  });
}

function useDelegationCommand<Input>(send: (input: Input, attempt: ReturnType<AttemptRegistry['forPayload']>) => Promise<unknown>) {
  const queryClient = useQueryClient();
  const { tenant } = useSession();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: (input: Input) => send(input, attempts.current.forPayload(input)),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: root(tenant?.id, tenant?.membershipId) });
    },
    onError: (error) => attempts.current.ended(error),
  });
}

export function useCreateDelegation() {
  const client = useApiClient();
  return useDelegationCommand<Record<string, unknown>>((body, attempt) => client.command('createDelegation', { body: body as never, attempt }));
}

export function useRevokeDelegation() {
  const client = useApiClient();
  return useDelegationCommand<{ id: string; version: number; reason: string }>((input, attempt) => client.command('revokeDelegation', { path: { delegationId: input.id }, body: { reason: input.reason } as never, ifMatchVersion: input.version, attempt }));
}
