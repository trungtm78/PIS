import { ApiError } from '@machvon/api-client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../../api/ApiClientContext';
import { AttemptRegistry } from '../../../api/attempt-registry';
import { useSession } from '../../../session/SessionContext';
import { toHandoverList, toTrace } from './model';
import type { CreateBody, DecisionBody, FixBody, HandoverLine, ItemBody, Trace, Verification } from './model';

// What the screen shows depends on what the signed-in membership may see, not only on the tenant: the membership is part of every key.
function useScopeKey(): readonly ['ast-handovers', string | undefined, string | undefined] {
  const { tenant } = useSession();
  return ['ast-handovers', tenant?.id, tenant?.membershipId];
}

/** The handovers in the scope of the caller, the newest first; a page of the server is enough for a list. Those of one contract when it is named. */
export function useHandovers(contractId: string) {
  const client = useApiClient();
  const key = useScopeKey();
  const query: Record<string, string> = { limit: '200' };
  if (contractId !== '') query.contract_id = contractId;
  return useQuery<HandoverLine[]>({
    queryKey: [...key, 'list', contractId],
    queryFn: async () => toHandoverList(await client.read('get_resources_handover', { query })),
    enabled: key[1] !== undefined,
    retry: false,
  });
}

/** The trace of one handover: its items, assets, documents and minutes; null when it is not there for the caller (another tenant, or outside the scope: a 404). */
export function useTrace(id: string | null | undefined) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<Trace | null>({
    queryKey: [...key, 'trace', id ?? ''],
    queryFn: async () => {
      try {
        return toTrace(await client.read('getHandoverTrace', { path: { id: id ?? '' } })) ?? null;
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return null;
        throw error;
      }
    },
    enabled: key[1] !== undefined && typeof id === 'string',
    retry: false,
  });
}

/** One mutation hook: one idempotency attempt per intention, the reads of the handovers refreshed once it succeeds. */
function useCommand<Input>(send: (input: Input, attempt: ReturnType<AttemptRegistry['forPayload']>) => Promise<unknown>) {
  const queryClient = useQueryClient();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: (input: Input) => send(input, attempts.current.forPayload(input)),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ predicate: (query) => query.queryKey[0] === 'ast-handovers' });
    },
    onError: (error) => attempts.current.ended(error),
  });
}

export interface VersionedInput<Body> {
  id: string;
  version: number;
  body: Body;
}

export interface ItemInput<Body> {
  id: string;
  body: Body;
}

export function useCreateHandover() {
  const client = useApiClient();
  return useCommand<CreateBody>((body, attempt) => client.command('createHandover', { body, attempt }));
}

export function useAddPunchItem() {
  const client = useApiClient();
  return useCommand<VersionedInput<ItemBody>>((input, attempt) => client.command('addPunchItem', { path: { id: input.id }, body: input.body, ifMatchVersion: input.version, attempt }));
}

export function useMarkPunchItemFixed() {
  const client = useApiClient();
  return useCommand<ItemInput<FixBody>>((input, attempt) => client.command('markPunchItemFixed', { path: { id: input.id }, body: input.body, attempt }));
}

export function useVerifyPunchItem() {
  const client = useApiClient();
  return useCommand<ItemInput<{ outcome: Verification; note: string }>>((input, attempt) => client.command('verifyPunchItem', { path: { id: input.id }, body: input.body, attempt }));
}

export function useWaivePunchItem() {
  const client = useApiClient();
  return useCommand<ItemInput<{ waiver_reason: string }>>((input, attempt) => client.command('waivePunchItem', { path: { id: input.id }, body: input.body, attempt }));
}

export function useDecideHandover() {
  const client = useApiClient();
  return useCommand<VersionedInput<DecisionBody>>((input, attempt) =>
    client.command('post_handovers_id_decision', { path: { id: input.id }, body: input.body, ifMatchVersion: input.version, attempt }),
  );
}
