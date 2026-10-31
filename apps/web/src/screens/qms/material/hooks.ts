import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../../api/ApiClientContext';
import { AttemptRegistry } from '../../../api/attempt-registry';
import { useSession } from '../../../session/SessionContext';
import { toContractOption, toMaterialTest } from './model';
import type { ContractOption, MaterialTest } from './model';

// What the screen shows depends on what the signed-in membership may see, not only on the tenant: the membership is part of every key.
function useScopeKey(): readonly ['qms-material', string | undefined, string | undefined] {
  const { tenant } = useSession();
  return ['qms-material', tenant?.id, tenant?.membershipId];
}

/** The tests in the scope of the caller, the newest first; those of one contract when it is named. Every page is read. */
export function useMaterialTests(contractId: string, enabled: boolean) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<MaterialTest[]>({
    queryKey: [...key, 'list', contractId],
    queryFn: async () => (await client.readAll('listMaterialTests', { query: contractId === '' ? {} : { contract_id: contractId } })).flatMap((raw) => toMaterialTest(raw) ?? []),
    enabled: enabled && key[1] !== undefined,
    retry: false,
  });
}

/** The contracts being performed that a sample can be registered on, under the right to manage the tests: what the form offers. */
export function useMaterialContracts(enabled: boolean) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<ContractOption[]>({
    queryKey: [...key, 'contracts'],
    queryFn: async () => (await client.readAll('listMaterialContracts')).flatMap(toContractOption),
    enabled: enabled && key[1] !== undefined,
    retry: false,
  });
}

/** One mutation hook: one idempotency attempt per intention, the tests read again after the command, also after a refusal (it can follow a result recorded by somebody else). */
function useCommand<Input>(send: (input: Input, attempt: ReturnType<AttemptRegistry['forPayload']>) => Promise<unknown>) {
  const queryClient = useQueryClient();
  const key = useScopeKey();
  const attempts = useRef(new AttemptRegistry());
  const refresh = (): Promise<void> => queryClient.invalidateQueries({ queryKey: key });
  return useMutation({
    mutationFn: (input: Input) => send(input, attempts.current.forPayload(input)),
    onSuccess: async () => {
      attempts.current.done();
      await refresh();
    },
    onError: async (error) => {
      attempts.current.ended(error);
      await refresh();
    },
  });
}

export function useRegisterTest() {
  const client = useApiClient();
  return useCommand<Record<string, unknown>>((body, attempt) => client.command('registerMaterialTest', { body: body as never, attempt }));
}

export interface ResultInput {
  id: string;
  version: number;
  body: Record<string, unknown>;
}

export function useRecordResult() {
  const client = useApiClient();
  return useCommand<ResultInput>((input, attempt) => client.command('recordMaterialTestResult', { path: { id: input.id }, body: input.body as never, ifMatchVersion: input.version, attempt }));
}
