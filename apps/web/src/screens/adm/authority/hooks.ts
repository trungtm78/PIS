import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../../api/ApiClientContext';
import { AttemptRegistry } from '../../../api/attempt-registry';
import { useSession } from '../../../session/SessionContext';
import { toMember } from '../../dgv/model';
import type { MemberOption } from '../../dgv/model';
import { toActing, toGrantOption, toPeriodScope, toPermanent, toStandingRequest } from './model';
import type { ActingView, GrantOption, PermanentView, PeriodScopeView, StandingRequestView } from './model';

const root = (tenantId: string | undefined, membershipId: string | undefined) => ['adm', 'authority', tenantId, membershipId] as const;

function useScopedQuery<T>(name: string, extra: readonly unknown[], enabled: boolean, read: () => Promise<T>) {
  const { tenant } = useSession();
  return useQuery<T>({
    queryKey: [...root(tenant?.id, tenant?.membershipId), name, ...extra],
    queryFn: read,
    enabled: enabled && tenant !== undefined,
    retry: false,
  });
}

/** The requests for a permanent delegation: the ones the person made or is the delegate of, and every one for the approver. */
export function useStandingRequests(enabled: boolean) {
  const client = useApiClient();
  return useScopedQuery<StandingRequestView[]>('requests', [], enabled, async () => (await client.readAll('get_resources_standing_delegation_request')).flatMap((raw) => toStandingRequest(raw) ?? []));
}

/** The permanent delegations the person gave or received, or every one when they may read them all (`role` undefined). */
export function usePermanentDelegations(role: 'given' | 'received', enabled: boolean) {
  const client = useApiClient();
  return useScopedQuery<PermanentView[]>('permanent', [role], enabled, async () => (await client.readAll('get_resources_delegation_grant', { query: { role, kind: 'PERMANENT' } })).flatMap((raw) => toPermanent(raw) ?? []));
}

/** The active staff a delegation, an acting grant or a limit can name, read in the scope of the signed-in membership. */
export function useStaff(enabled: boolean) {
  const client = useApiClient();
  return useScopedQuery<MemberOption[]>('staff', [], enabled, async () => (await client.readAll('get_resources_membership')).flatMap((raw) => toMember(raw) ?? []));
}

export function useActingGrants(enabled: boolean) {
  const client = useApiClient();
  return useScopedQuery<ActingView[]>('acting', [], enabled, async () => (await client.readAll('get_resources_acting_grant')).flatMap((raw) => toActing(raw) ?? []));
}

export function usePeriodScopes(status: 'Active' | 'Lifted', enabled: boolean) {
  const client = useApiClient();
  return useScopedQuery<PeriodScopeView[]>('scopes', [status], enabled, async () => (await client.readAll('get_resources_period_scope', { query: { status } })).flatMap((raw) => toPeriodScope(raw) ?? []));
}

/** The role grants a limit can be set on: the active ones the person may read. */
export function useGrantOptions(enabled: boolean) {
  const client = useApiClient();
  return useScopedQuery<GrantOption[]>('grants', [], enabled, async () => (await client.readAll('get_resources_role_grant')).flatMap((raw) => toGrantOption(raw) ?? []));
}

function useAuthorityCommand<Input>(send: (input: Input, attempt: ReturnType<AttemptRegistry['forPayload']>) => Promise<unknown>) {
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

interface Versioned {
  id: string;
  version: number;
}

export function useCreateStandingRequest() {
  const client = useApiClient();
  return useAuthorityCommand<Record<string, unknown>>((body, attempt) => client.command('createStandingDelegationRequest', { body: body as never, attempt }));
}

export function useDecideStandingRequest() {
  const client = useApiClient();
  return useAuthorityCommand<Versioned & { decision: 'approve' | 'reject'; reason: string }>((input, attempt) =>
    client.command('decideStandingDelegationRequest', { path: { requestId: input.id }, body: { decision: input.decision, ...(input.reason === '' ? {} : { reason: input.reason }) } as never, ifMatchVersion: input.version, attempt }),
  );
}

export function useCancelStandingRequest() {
  const client = useApiClient();
  return useAuthorityCommand<Versioned & { reason: string }>((input, attempt) => client.command('cancelStandingDelegationRequest', { path: { requestId: input.id }, body: { reason: input.reason } as never, ifMatchVersion: input.version, attempt }));
}

export function useReviewDelegation() {
  const client = useApiClient();
  return useAuthorityCommand<Versioned & { reviewDueAt: string; note: string }>((input, attempt) =>
    client.command('reviewDelegation', { path: { delegationId: input.id }, body: { review_due_at: input.reviewDueAt, ...(input.note === '' ? {} : { note: input.note }) } as never, ifMatchVersion: input.version, attempt }),
  );
}

export function useRevokePermanent() {
  const client = useApiClient();
  return useAuthorityCommand<Versioned & { reason: string }>((input, attempt) => client.command('revokeDelegation', { path: { delegationId: input.id }, body: { reason: input.reason } as never, ifMatchVersion: input.version, attempt }));
}

export function useRequestActing() {
  const client = useApiClient();
  return useAuthorityCommand<Record<string, unknown>>((body, attempt) => client.command('requestActing', { body: body as never, attempt }));
}

export function useDecideActing() {
  const client = useApiClient();
  return useAuthorityCommand<Versioned & { decision: 'approve' | 'reject'; reason: string }>((input, attempt) =>
    client.command('decideActingRequest', { path: { actingId: input.id }, body: { decision: input.decision, ...(input.reason === '' ? {} : { reason: input.reason }) } as never, ifMatchVersion: input.version, attempt }),
  );
}

export function useCancelActing() {
  const client = useApiClient();
  return useAuthorityCommand<Versioned & { reason: string }>((input, attempt) => client.command('cancelActingRequest', { path: { actingId: input.id }, body: { reason: input.reason } as never, ifMatchVersion: input.version, attempt }));
}

export function useRevokeActing() {
  const client = useApiClient();
  return useAuthorityCommand<Versioned & { reason: string }>((input, attempt) => client.command('revokeActing', { path: { actingId: input.id }, body: { reason: input.reason } as never, ifMatchVersion: input.version, attempt }));
}

export function useCreatePeriodScope() {
  const client = useApiClient();
  return useAuthorityCommand<{ grantId: string; periodCodes: string[]; reason: string }>((input, attempt) =>
    client.command('createPeriodScope', { body: { role_grant_id: input.grantId, period_codes: input.periodCodes, reason: input.reason } as never, attempt }),
  );
}

export function useLiftPeriodScope() {
  const client = useApiClient();
  return useAuthorityCommand<Versioned & { reason: string }>((input, attempt) => client.command('liftPeriodScope', { path: { scopeId: input.id }, body: { reason: input.reason } as never, ifMatchVersion: input.version, attempt }));
}
