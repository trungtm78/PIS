import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../../api/ApiClientContext';
import { AttemptRegistry } from '../../../api/attempt-registry';
import { useScopeKey } from '../hooks';
import { toRiskPage } from './model';
import type { RiskPage } from './model';

const PAGE_SIZE = 25;
const root = (scope: ReturnType<typeof useScopeKey>) => [...scope, 'risks'] as const;

/** The register of a project, the highest score first, a page at a time, narrowed by status. */
export function useRisks(projectId: string | undefined, status: string) {
  const client = useApiClient();
  const scope = useScopeKey();
  return useInfiniteQuery<RiskPage, Error, { pages: RiskPage[] }, readonly unknown[], string | undefined>({
    queryKey: [...root(scope), projectId ?? '', status],
    initialPageParam: undefined,
    queryFn: async ({ pageParam }) =>
      toRiskPage(
        await client.read('listProjectRisks', {
          path: { id: projectId ?? '' },
          query: { limit: PAGE_SIZE, ...(status === '' ? {} : { status }), ...(pageParam === undefined ? {} : { cursor: pageParam }) },
        }),
      ),
    getNextPageParam: (last) => last.nextCursor,
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
      await queryClient.invalidateQueries({ queryKey: root(scope) });
    },
    onError: (error) => attempts.current.ended(error),
  });
}

export interface RegisterInput {
  projectId: string;
  body: Record<string, unknown>;
}

export function useRegisterRisk() {
  const client = useApiClient();
  return useCommand((input: RegisterInput, attempt) => client.command('registerProjectRisk', { path: { id: input.projectId }, body: input.body as never, attempt }));
}

export interface ChangeInput {
  id: string;
  version: number;
  body: Record<string, unknown>;
}

export function useUpdateRisk() {
  const client = useApiClient();
  return useCommand((input: ChangeInput, attempt) => client.command('updateProjectRisk', { path: { id: input.id }, body: input.body as never, ifMatchVersion: input.version, attempt }));
}

export function useCloseRisk() {
  const client = useApiClient();
  return useCommand((input: ChangeInput, attempt) => client.command('closeProjectRisk', { path: { id: input.id }, body: input.body as never, ifMatchVersion: input.version, attempt }));
}
