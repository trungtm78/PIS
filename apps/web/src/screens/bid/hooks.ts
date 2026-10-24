import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../api/ApiClientContext';
import { AttemptRegistry } from '../../api/attempt-registry';
import { useSession } from '../../session/SessionContext';
import { registerBody, restrictionBody, toContractorLine, toContractorView } from './model';
import type { ContractorLine, ContractorView, Decision, RegisterForm, RestrictionForm } from './model';

// What the registry shows depends on who is signed in (a guest sees one contractor, the tax id is covered unless the caller holds the full
// right), so the membership is part of every key, as well as the tenant.
function useScopeKey(): readonly ['bid', string | undefined, string | undefined] {
  const { tenant } = useSession();
  return ['bid', tenant?.id, tenant?.membershipId];
}

/** The contractors the caller may see, in the order of the read (the newest first). */
export function useContractors() {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<ContractorLine[]>({
    queryKey: [...key, 'contractors'],
    queryFn: async () => (await client.readAll('get_resources_contractor')).flatMap((raw) => toContractorLine(raw) ?? []),
    enabled: key[1] !== undefined,
    retry: false,
  });
}

/** One contractor with its restrictions; null when none is named. */
export function useContractor(contractorId: string | null | undefined) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<ContractorView | null>({
    queryKey: [...key, 'contractor', contractorId ?? ''],
    queryFn: async () => toContractorView(await client.read('get_resources_contractor_id', { path: { id: contractorId ?? '' } })) ?? null,
    enabled: key[1] !== undefined && typeof contractorId === 'string',
    retry: false,
  });
}

/** One mutation hook: one idempotency attempt per intention, the cached reads of the registry refreshed on success. */
function useCommand<Input>(send: (input: Input, attempt: ReturnType<AttemptRegistry['forPayload']>) => Promise<{ resource_id?: string; resource_version?: number }>) {
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

export function useRegisterContractor() {
  const client = useApiClient();
  return useCommand<RegisterForm>((form, attempt) => client.command('registerContractor', { body: registerBody(form), attempt }));
}

export interface VerifyInput {
  id: string;
  version: number;
  decision: Decision;
  evidenceDocumentId: string;
}

export function useVerifyContractor() {
  const client = useApiClient();
  return useCommand<VerifyInput>((input, attempt) =>
    client.command('verifyContractor', {
      path: { id: input.id },
      body: { decision: input.decision, verification_evidence_document_id: input.evidenceDocumentId.trim() },
      ifMatchVersion: input.version,
      attempt,
    }),
  );
}

export interface RestrictionInput {
  id: string;
  form: RestrictionForm;
}

export function useRecordRestriction() {
  const client = useApiClient();
  return useCommand<RestrictionInput>((input, attempt) => client.command('recordContractorRestriction', { path: { id: input.id }, body: restrictionBody(input.form), attempt }));
}
