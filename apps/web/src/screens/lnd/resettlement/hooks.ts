import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../../api/ApiClientContext';
import { AttemptRegistry } from '../../../api/attempt-registry';
import { useScopeKey } from '../hooks';
import { toAllocation, toCandidate } from './model';
import type { AllocationLine, Candidate } from './model';

/** The allocations of a project inside the units of the caller, newest first, with the household masked. */
export function useAllocations(projectId: string | undefined) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<AllocationLine[]>({
    queryKey: [...key, 'resettlement', projectId ?? ''],
    queryFn: async () => (await client.readAll('listResettlementAllocations', { query: { project_id: projectId ?? '' } })).flatMap((raw) => toAllocation(raw) ?? []),
    enabled: key[1] !== undefined && projectId !== undefined,
    retry: false,
  });
}

/** The items of approved plans that give a household resettlement and have no unit yet: what the form offers. Read only for someone who may allocate. */
export function useCandidates(projectId: string | undefined, enabled: boolean) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<Candidate[]>({
    queryKey: [...key, 'resettlement-candidates', projectId ?? ''],
    queryFn: async () => (await client.readAll('listResettlementCandidates', { query: { project_id: projectId ?? '' } })).flatMap((raw) => toCandidate(raw) ?? []),
    enabled: key[1] !== undefined && projectId !== undefined && enabled,
    retry: false,
  });
}

/** The allocation of a unit: one idempotency attempt per intention, every cached read of the land screens refreshed on success. */
export function useAllocate() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const key = useScopeKey();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: (body: Record<string, unknown>) => client.command('allocateResettlement', { body: body as never, attempt: attempts.current.forPayload(body) }),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: key });
    },
    onError: (error) => attempts.current.ended(error),
  });
}
