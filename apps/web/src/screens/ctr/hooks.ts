import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../api/ApiClientContext';
import { AttemptRegistry } from '../../api/attempt-registry';
import { useSession } from '../../session/SessionContext';
import { toContractLine, toContractView, toContractorOption, toProjectOption } from './model';
import type { ContractLine, ContractView, CreateBody, Option, PartiesBody, ReviseBody } from './model';

// What the register shows depends on the scope of the membership that is signed in, not only on the tenant: switching between two
// memberships of one tenant keeps the query client, so the membership is part of every key.
export function useScopeKey(): readonly ['ctr', string | undefined, string | undefined] {
  const { tenant } = useSession();
  return ['ctr', tenant?.id, tenant?.membershipId];
}

/** The register in the scope of the caller, in the order of the read (by contract code). */
export function useContracts(enabled = true) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<ContractLine[]>({
    queryKey: [...key, 'contracts'],
    queryFn: async () => (await client.readAll('get_resources_contract')).flatMap((raw) => toContractLine(raw) ?? []),
    enabled: enabled && key[1] !== undefined,
    retry: false,
  });
}

/** One contract with its terms, revisions and members; null when none is named. */
export function useContract(contractId: string | null | undefined) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<ContractView | null>({
    queryKey: [...key, 'contract', contractId ?? ''],
    queryFn: async () => toContractView(await client.read('get_resources_contract_id', { path: { id: contractId ?? '' } })) ?? null,
    enabled: key[1] !== undefined && typeof contractId === 'string',
    retry: false,
  });
}

/** The projects the caller may read: a contract is drafted under one of them. */
export function useProjectOptions(enabled = true) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<Option[]>({
    queryKey: [...key, 'projects'],
    queryFn: async () => (await client.readAll('get_resources_project')).flatMap(toProjectOption),
    enabled: enabled && key[1] !== undefined,
    retry: false,
  });
}

/** The contractors that are verified: only they can hold a contract or a share of one. */
export function useContractorOptions(enabled = true) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<Option[]>({
    queryKey: [...key, 'contractors'],
    queryFn: async () => (await client.readAll('get_resources_contractor')).flatMap(toContractorOption),
    enabled: enabled && key[1] !== undefined,
    retry: false,
  });
}

/** One mutation hook: one idempotency attempt per intention, the cached reads of the register refreshed on success. */
export function useCommand<Input>(send: (input: Input, attempt: ReturnType<AttemptRegistry['forPayload']>) => Promise<{ resource_id?: string; resource_version?: number }>) {
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

export function useCreateContract() {
  const client = useApiClient();
  return useCommand<CreateBody>((body, attempt) => client.command('createContract', { body, attempt }));
}

export interface ReviseInput {
  id: string;
  version: number;
  body: ReviseBody;
}

export function useReviseContract() {
  const client = useApiClient();
  return useCommand<ReviseInput>((input, attempt) => client.command('reviseContractDraft', { path: { id: input.id }, body: input.body, ifMatchVersion: input.version, attempt }));
}

export interface PartiesInput {
  id: string;
  version: number;
  body: PartiesBody;
}

export function useReplaceParties() {
  const client = useApiClient();
  return useCommand<PartiesInput>((input, attempt) => client.command('replaceContractParties', { path: { id: input.id }, body: input.body, ifMatchVersion: input.version, attempt }));
}

export interface CancelInput {
  id: string;
  version: number;
  reason: string;
}

export function useCancelContract() {
  const client = useApiClient();
  return useCommand<CancelInput>((input, attempt) => client.command('cancelContractDraft', { path: { id: input.id }, body: { reason: input.reason }, ifMatchVersion: input.version, attempt }));
}
