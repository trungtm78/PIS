import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../../api/ApiClientContext';
import { AttemptRegistry } from '../../../api/attempt-registry';
import { useSession } from '../../../session/SessionContext';
import { toAcceptanceList } from './model';
import type { AcceptanceLine, Decision, DraftBody, SignBody } from './model';

// What the screen shows depends on what the signed-in membership may see, not only on the tenant: the membership is part of every key.
function useScopeKey(): readonly ['qms-acceptances', string | undefined, string | undefined] {
  const { tenant } = useSession();
  return ['qms-acceptances', tenant?.id, tenant?.membershipId];
}

/** The minutes in the scope of the caller, the latest first; those of one contract when it is named. */
export function useAcceptances(contractId: string) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<AcceptanceLine[]>({
    queryKey: [...key, 'acceptances', contractId],
    queryFn: async () => toAcceptanceList(await client.read('listQualityAcceptances', { query: contractId === '' ? {} : { contract_id: contractId } })),
    enabled: key[1] !== undefined,
    retry: false,
  });
}

/** One mutation hook: one idempotency attempt per intention, the reads of the inspections and of the minutes refreshed once it succeeds. */
function useCommand<Input>(send: (input: Input, attempt: ReturnType<AttemptRegistry['forPayload']>) => Promise<unknown>) {
  const queryClient = useQueryClient();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: (input: Input) => send(input, attempts.current.forPayload(input)),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ predicate: (query) => typeof query.queryKey[0] === 'string' && query.queryKey[0].startsWith('qms-') });
    },
    onError: (error) => attempts.current.ended(error),
  });
}

export interface DraftInput {
  inspectionId: string;
  body: DraftBody;
}

export function useDraftAcceptance() {
  const client = useApiClient();
  return useCommand<DraftInput>((input, attempt) => client.command('createQualityAcceptance', { path: { id: input.inspectionId }, body: input.body, attempt }));
}

export interface VersionedInput<Body> {
  id: string;
  version: number;
  body: Body;
}

export function useSignAcceptance() {
  const client = useApiClient();
  return useCommand<VersionedInput<SignBody>>((input, attempt) => client.command('signQualityAcceptance', { path: { id: input.id }, body: input.body, ifMatchVersion: input.version, attempt }));
}

export function useDecideAcceptance() {
  const client = useApiClient();
  return useCommand<VersionedInput<{ decision: Decision; reason: string }>>((input, attempt) => client.command('decideQualityAcceptance', { path: { id: input.id }, body: input.body, ifMatchVersion: input.version, attempt }));
}

export function useRevokeAcceptance() {
  const client = useApiClient();
  return useCommand<VersionedInput<{ reason: string }>>((input, attempt) => client.command('revokeQualityAcceptance', { path: { id: input.id }, body: input.body, ifMatchVersion: input.version, attempt }));
}
