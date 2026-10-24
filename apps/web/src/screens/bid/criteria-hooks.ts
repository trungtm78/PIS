import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../api/ApiClientContext';
import { AttemptRegistry } from '../../api/attempt-registry';
import { useSession } from '../../session/SessionContext';
import { criteriaBody, toCriteriaVersion, toEligiblePackage } from './criteria-model';
import type { CriteriaForm, CriteriaVersion } from './criteria-model';
import type { PackageLine } from './plan-model';

// What the criteria show depends on who is signed in (a draft is for those who draft and approve), so the membership is part of every key.
function useScopeKey(): readonly ['bid-criteria', string | undefined, string | undefined] {
  const { tenant } = useSession();
  return ['bid-criteria', tenant?.id, tenant?.membershipId];
}

/** The packages of the scope of the caller that criteria can be made for. */
export function useCriteriaPackages() {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<PackageLine[]>({
    queryKey: [...key, 'packages'],
    queryFn: async () => (await client.readAll('get_resources_procurement_package')).flatMap((raw) => toEligiblePackage(raw) ?? []),
    enabled: key[1] !== undefined,
    retry: false,
  });
}

/** The versions of the criteria of one package, the newest first; nothing is read until a package is chosen. */
export function useCriteriaVersions(packageId: string | undefined) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<CriteriaVersion[]>({
    queryKey: [...key, 'versions', packageId],
    queryFn: async () => (await client.readAll('get_resources_criteria_version', { query: { package_id: packageId as string } })).flatMap((raw) => toCriteriaVersion(raw) ?? []),
    enabled: key[1] !== undefined && packageId !== undefined,
    retry: false,
  });
}

/** One mutation hook: one idempotency attempt per intention, the cached reads of the criteria refreshed on success. */
function useCommand<Input>(send: (input: Input, attempt: ReturnType<AttemptRegistry['forPayload']>) => Promise<{ resource_id?: string; resource_version?: number; status?: string }>) {
  const queryClient = useQueryClient();
  const key = useScopeKey();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: (input: Input) => send(input, attempts.current.forPayload(input)),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: key });
    },
    onError: (error) => attempts.current.ended(error),
  });
}

/** The contract types the criteria as an open object (the schema of the items is staged for the contract), so the typed body takes the allowlisted criteria through this one cast. */
function contractBodyOf(form: CriteriaForm): { package_id: string; legal_basis: string; criteria_json: Record<string, never> } {
  const body = criteriaBody(form);
  return { ...body, criteria_json: body.criteria_json as unknown as Record<string, never> };
}

export function useCreateCriteria() {
  const client = useApiClient();
  return useCommand<CriteriaForm>((form, attempt) => client.command('createCriteriaVersion', { body: contractBodyOf(form), attempt }));
}

export interface ApproveInput {
  id: string;
  version: number;
}

export function useApproveCriteria() {
  const client = useApiClient();
  return useCommand<ApproveInput>((input, attempt) => client.command('approveCriteriaVersion', { path: { id: input.id }, ifMatchVersion: input.version, attempt }));
}
