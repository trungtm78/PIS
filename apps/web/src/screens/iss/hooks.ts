import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../api/ApiClientContext';
import { AttemptRegistry } from '../../api/attempt-registry';
import { useSession } from '../../session/SessionContext';
import { ISSUE_CATEGORY_TYPE, toCategory, toPolicy, toUnit } from './model';
import type { CategoryOption, PolicyView, PublishPolicyBody, UnitOption } from './model';

/** Every read and every mutation of the issue screens lives under this key of the tenant, so one command refreshes them all. */
export const issRoot = (tenantId: string | undefined) => ['iss', tenantId] as const;

/** One mutation hook: one idempotency attempt per intention, the cached reads of the tenant refreshed on success. */
function useCommand<Input>(send: (input: Input, attempt: ReturnType<AttemptRegistry['forPayload']>) => Promise<unknown>) {
  const queryClient = useQueryClient();
  const { tenant } = useSession();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: (input: Input) => send(input, attempts.current.forPayload(input)),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: issRoot(tenant?.id) });
    },
    onError: (error) => attempts.current.ended(error),
  });
}

/** Publishes a policy, or the next revision of the policy that has the same code. */
export function usePublishPolicy() {
  const client = useApiClient();
  return useCommand<PublishPolicyBody>((body, attempt) => client.command('upsertIssueSlaPolicy', { body, attempt }));
}

export interface RetirePolicyInput {
  id: string;
  validUntil: string;
}

/** Ends a policy from a date; the row stays, so the issues created under it keep their version. */
export function useRetirePolicy() {
  const client = useApiClient();
  return useCommand<RetirePolicyInput>((input, attempt) => client.command('retireIssueSlaPolicy', { path: { id: input.id }, body: { valid_until: input.validUntil }, attempt }));
}

/** The issue categories that are in force, for the choice of the category a policy is written for (MDM-17). */
export function useCategories() {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<CategoryOption[]>({
    queryKey: [...issRoot(tenant?.id), 'categories'],
    queryFn: async () => (await client.readAll('searchMasterRecords', { query: { master_type: ISSUE_CATEGORY_TYPE } })).flatMap((raw) => toCategory(raw) ?? []),
    enabled: tenant !== undefined,
    retry: false,
  });
}

/** The units of the tenant that the caller may read, for the choice of the unit a policy is written for. */
export function useUnits() {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<UnitOption[]>({
    queryKey: [...issRoot(tenant?.id), 'units'],
    queryFn: async () => (await client.readAll('get_resources_organization_unit')).flatMap((raw) => toUnit(raw) ?? []),
    enabled: tenant !== undefined,
    retry: false,
  });
}

/** Every version of every policy of the tenant, newest first; the screen groups them by category, severity and unit. */
export function usePolicies() {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<PolicyView[]>({
    queryKey: [...issRoot(tenant?.id), 'policies'],
    queryFn: async () => (await client.readAll('listIssueSlaPolicies')).flatMap((raw) => toPolicy(raw) ?? []),
    enabled: tenant !== undefined,
    retry: false,
  });
}
