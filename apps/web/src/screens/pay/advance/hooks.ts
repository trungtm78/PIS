import { ApiError } from '@machvon/api-client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../../api/ApiClientContext';
import { AttemptRegistry } from '../../../api/attempt-registry';
import { useScopeKey } from '../hooks';
import { toAdvance, toAnswer, toPlan } from './model';
import type { Advance, AdvanceAnswer, AdvancePlan, RecoveryBody } from './model';

export interface AdvanceFilter {
  contractId?: string | null;
  status?: string | null;
}

/** The advances the caller may see, the newest first, narrowed by contract and status. */
export function useAdvances(filter: AdvanceFilter = {}) {
  const client = useApiClient();
  const key = useScopeKey();
  const query: Record<string, string> = {};
  if (filter.contractId) query.contract_id = filter.contractId;
  if (filter.status) query.status = filter.status;
  return useQuery<Advance[]>({
    queryKey: [...key, 'advances', filter.contractId ?? '', filter.status ?? ''],
    queryFn: async () => (await client.readAll('listAdvances', { query })).flatMap((raw) => toAdvance(raw) ?? []),
    enabled: key[1] !== undefined,
    retry: false,
  });
}

/** Where the recovery of one advance stands and where it goes; null when it is not there for the caller (another tenant, or outside the scope: a 404). */
export function useRecoveryPlan(id: string | null | undefined) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<AdvancePlan | null>({
    queryKey: [...key, 'advance-plan', id ?? ''],
    queryFn: async () => {
      try {
        return toPlan(await client.read('getAdvanceRecoveryPlan', { path: { id: id ?? '' } })) ?? null;
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return null;
        throw error;
      }
    },
    enabled: key[1] !== undefined && typeof id === 'string',
    retry: false,
  });
}

/** One mutation hook: one idempotency attempt per intention, the cached reads refreshed on success, and the answer of the server given back. */
function useCommand<Input>(send: (input: Input, attempt: ReturnType<AttemptRegistry['forPayload']>) => Promise<unknown>) {
  const queryClient = useQueryClient();
  const key = useScopeKey();
  const attempts = useRef(new AttemptRegistry());
  return useMutation<AdvanceAnswer | undefined, Error, Input>({
    mutationFn: async (input) => toAnswer(await send(input, attempts.current.forPayload(input))),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: key });
    },
    onError: (error) => attempts.current.ended(error),
  });
}

export interface RecoveryInput {
  id: string;
  version: number;
  body: RecoveryBody;
}

export function useRecordRecovery() {
  const client = useApiClient();
  return useCommand<RecoveryInput>((input, attempt) => client.command('recordAdvanceRecovery', { path: { id: input.id }, body: input.body, ifMatchVersion: input.version, attempt }));
}

export interface CancelInput {
  id: string;
  version: number;
  body: { reason: string };
}

export function useCancelAdvance() {
  const client = useApiClient();
  return useCommand<CancelInput>((input, attempt) => client.command('cancelAdvance', { path: { id: input.id }, body: input.body, ifMatchVersion: input.version, attempt }));
}
