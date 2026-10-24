import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../api/ApiClientContext';
import { AttemptRegistry } from '../../api/attempt-registry';
import { useSession } from '../../session/SessionContext';
import { toAppropriation, toMasterOption } from './model';
import type { AppropriationLine, MasterOption, RegisterBody } from './model';

// What the register shows is the capital of the tenant for the member that is signed in: switching between two memberships of one
// tenant keeps the query client, so the membership is part of every key.
function useScopeKey(): readonly ['cap', string | undefined, string | undefined] {
  const { tenant } = useSession();
  return ['cap', tenant?.id, tenant?.membershipId];
}

/** The register of the tenant, every page of it: drafts waiting for a decision and published appropriations, the newest first. */
export function useAppropriations() {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<AppropriationLine[]>({
    queryKey: [...key, 'appropriations'],
    queryFn: async () => (await client.readAll('listAppropriations')).flatMap((raw) => toAppropriation(raw) ?? []),
    enabled: key[1] !== undefined,
    retry: false,
  });
}

/** The entries in force of some master types, by the id of the version an appropriation stores. */
export function useMasterOptions(masterTypes: readonly string[], enabled = true) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<MasterOption[]>({
    queryKey: [...key, 'master', ...masterTypes],
    queryFn: async () => {
      const lists = await Promise.all(masterTypes.map((masterType) => client.readAll('searchMasterRecords', { query: { master_type: masterType } })));
      return lists.flat().flatMap(toMasterOption);
    },
    enabled: enabled && key[1] !== undefined,
    retry: false,
  });
}

/** One mutation hook: one idempotency attempt per intention, the cached reads of the register refreshed on success. */
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

export function useRegisterAppropriation() {
  const client = useApiClient();
  return useCommand<RegisterBody>((body, attempt) => client.command('registerAppropriation', { body, attempt }));
}

export interface DecideInput {
  id: string;
  version: number;
  decision: 'approve' | 'reject';
  reason: string;
}

export function useDecideAppropriation() {
  const client = useApiClient();
  return useCommand<DecideInput>((input, attempt) =>
    client.command('decideAppropriation', { path: { id: input.id }, body: { decision: input.decision, reason: input.reason }, ifMatchVersion: input.version, attempt }),
  );
}
