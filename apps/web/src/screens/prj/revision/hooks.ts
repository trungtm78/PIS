import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../../api/ApiClientContext';
import { AttemptRegistry } from '../../../api/attempt-registry';
import { useScopeKey } from '../hooks';
import { toRevisionRegister } from './model';
import type { RevisionRegister } from './model';

/** The revisions of a project, the latest first. */
export function useRevisions(projectId: string | undefined) {
  const client = useApiClient();
  const scope = useScopeKey();
  return useQuery<RevisionRegister>({
    queryKey: [...scope, 'revisions', projectId ?? ''],
    queryFn: async () => toRevisionRegister(await client.read('listProjectRevisions', { path: { id: projectId ?? '' } })),
    enabled: scope[1] !== undefined && projectId !== undefined,
    retry: false,
  });
}

type Attempt = ReturnType<AttemptRegistry['forPayload']>;

function useCommand<Input>(send: (input: Input, attempt: Attempt) => Promise<unknown>) {
  const queryClient = useQueryClient();
  const scope = useScopeKey();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: async (input: Input) => send(input, attempts.current.forPayload(input)),
    onSuccess: async () => {
      attempts.current.done();
      // An approval changes the figures of the project: the register and the lists that show them are read again as well.
      await queryClient.invalidateQueries({ queryKey: scope });
    },
    onError: (error) => attempts.current.ended(error),
  });
}

export interface ProposeInput {
  projectId: string;
  version: number;
  body: Record<string, unknown>;
}

export function useProposeRevision() {
  const client = useApiClient();
  return useCommand((input: ProposeInput, attempt) => client.command('proposeProjectRevision', { path: { id: input.projectId }, body: input.body as never, ifMatchVersion: input.version, attempt }));
}

export interface DecideInput {
  id: string;
  version: number;
  body: Record<string, unknown>;
}

export function useDecideRevision() {
  const client = useApiClient();
  return useCommand((input: DecideInput, attempt) => client.command('decideProjectRevision', { path: { id: input.id }, body: input.body as never, ifMatchVersion: input.version, attempt }));
}
