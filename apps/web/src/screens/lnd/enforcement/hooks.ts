import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../../api/ApiClientContext';
import { AttemptRegistry } from '../../../api/attempt-registry';
import { useScopeKey } from '../hooks';
import { toCase } from './model';
import type { CaseLine } from './model';

/** The cases of a project inside the units of the caller, newest first, with the household masked. */
export function useCases(projectId: string | undefined) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<CaseLine[]>({
    queryKey: [...key, 'enforcement', projectId ?? ''],
    queryFn: async () => (await client.readAll('listEnforcementCases', { query: { project_id: projectId ?? '' } })).flatMap((raw) => toCase(raw) ?? []),
    enabled: key[1] !== undefined && projectId !== undefined,
    retry: false,
  });
}

/** One mutation hook: one idempotency attempt per intention, every cached read of the land screens read again after the command, also after a refusal (it can follow a step taken by somebody else). */
function useCommand<Input>(send: (input: Input, attempt: ReturnType<AttemptRegistry['forPayload']>) => Promise<unknown>) {
  const queryClient = useQueryClient();
  const key = useScopeKey();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: (input: Input) => send(input, attempts.current.forPayload(input)),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: key });
    },
    onError: async (error) => {
      attempts.current.ended(error);
      await queryClient.invalidateQueries({ queryKey: key });
    },
  });
}

export function useStartEnforcement() {
  const client = useApiClient();
  return useCommand<Record<string, unknown>>((body, attempt) => client.command('startEnforcement', { body: body as never, attempt }));
}

export interface AdvanceInput {
  id: string;
  version: number;
  body: Record<string, unknown>;
}

export function useAdvanceEnforcement() {
  const client = useApiClient();
  return useCommand<AdvanceInput>((input, attempt) => client.command('advanceEnforcement', { path: { id: input.id }, body: input.body as never, ifMatchVersion: input.version, attempt }));
}
