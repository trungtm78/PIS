import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../../api/ApiClientContext';
import { AttemptRegistry } from '../../../api/attempt-registry';
import { useSession } from '../../../session/SessionContext';
import { toNcrList } from './model';
import type { AssignBody, EvidenceBody, NcrLine, RaiseBody, Verification } from './model';

// What the screen shows depends on what the signed-in membership may see, not only on the tenant: the membership is part of every key.
function useScopeKey(): readonly ['qms-nonconformances', string | undefined, string | undefined] {
  const { tenant } = useSession();
  return ['qms-nonconformances', tenant?.id, tenant?.membershipId];
}

/** The non-conformances in the scope of the caller, the newest first; a page of the server is enough for a board. Those of one contract when it is named. */
export function useNonconformances(contractId: string) {
  const client = useApiClient();
  const key = useScopeKey();
  const query: Record<string, string> = { limit: '200' };
  if (contractId !== '') query.contract_id = contractId;
  return useQuery<NcrLine[]>({
    queryKey: [...key, 'list', contractId],
    queryFn: async () => toNcrList(await client.read('get_resources_quality_nonconformance', { query })),
    enabled: key[1] !== undefined,
    retry: false,
  });
}

export interface Assignee {
  id: string;
  name: string;
}

/** The members who can be given a non-conformance or an action: every active member, a guest contractor among them. */
export function useAssignees(enabled: boolean) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<Assignee[]>({
    queryKey: ['qms-nonconformances', tenant?.id, 'assignees'],
    queryFn: async () =>
      (await client.readAll('get_resources_membership')).flatMap((raw) => {
        const row = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
        return typeof row.id === 'string' && typeof row.display_name === 'string' && row.status === 'Active' ? [{ id: row.id, name: row.display_name }] : [];
      }),
    enabled: enabled && tenant !== undefined,
    retry: false,
  });
}

/** One mutation hook: one idempotency attempt per intention, the reads of the non-conformances refreshed once it succeeds. */
function useCommand<Input>(send: (input: Input, attempt: ReturnType<AttemptRegistry['forPayload']>) => Promise<unknown>) {
  const queryClient = useQueryClient();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: (input: Input) => send(input, attempts.current.forPayload(input)),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ predicate: (query) => query.queryKey[0] === 'qms-nonconformances' });
    },
    onError: (error) => attempts.current.ended(error),
  });
}

export interface VersionedInput<Body> {
  id: string;
  version: number;
  body: Body;
}

export interface ActionInput<Body> {
  id: string;
  body: Body;
}

export function useRaiseNonconformance() {
  const client = useApiClient();
  return useCommand<RaiseBody>((body, attempt) => client.command('raiseNonconformance', { body, attempt }));
}

export function useAssignCorrectiveAction() {
  const client = useApiClient();
  return useCommand<VersionedInput<AssignBody>>((input, attempt) => client.command('assignCorrectiveAction', { path: { id: input.id }, body: input.body, ifMatchVersion: input.version, attempt }));
}

export function useSubmitCorrectiveEvidence() {
  const client = useApiClient();
  return useCommand<ActionInput<EvidenceBody>>((input, attempt) => client.command('submitCorrectiveEvidence', { path: { id: input.id }, body: input.body, attempt }));
}

export function useVerifyCorrectiveAction() {
  const client = useApiClient();
  return useCommand<ActionInput<{ outcome: Verification; verification_note: string }>>((input, attempt) =>
    client.command('verifyCorrectiveAction', { path: { id: input.id }, body: input.body, attempt }),
  );
}

export function useCloseNonconformance() {
  const client = useApiClient();
  return useCommand<VersionedInput<{ closure_note: string }>>((input, attempt) =>
    client.command('closeNonconformance', { path: { id: input.id }, body: input.body, ifMatchVersion: input.version, attempt }),
  );
}

export function useReopenNonconformance() {
  const client = useApiClient();
  return useCommand<VersionedInput<{ reason: string }>>((input, attempt) =>
    client.command('reopenNonconformance', { path: { id: input.id }, body: input.body, ifMatchVersion: input.version, attempt }),
  );
}
