import { ApiError } from '@machvon/api-client';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../../api/ApiClientContext';
import { AttemptRegistry } from '../../../api/attempt-registry';
import { useScopeKey } from '../hooks';
import { toBoardPage, toProjectSignals } from './model';
import type { BoardPage, ProjectSignals } from './model';

const PAGE_SIZE = 25;
const root = (scope: ReturnType<typeof useScopeKey>) => [...scope, 'risk-signals'] as const;

export interface BoardFilter {
  kind: string;
  level: string;
}

/** The board of the projects in the scope of the caller, the highest score first, a page at a time, narrowed by kind and by level. Each filter is part of the key, so a change reads again. */
export function useRiskBoard(filter: BoardFilter) {
  const client = useApiClient();
  const scope = useScopeKey();
  return useInfiniteQuery<BoardPage, Error, { pages: BoardPage[] }, readonly unknown[], string | undefined>({
    queryKey: [...root(scope), 'board', filter.kind, filter.level],
    initialPageParam: undefined,
    queryFn: async ({ pageParam }) => {
      const page = toBoardPage(
        await client.read('getRiskSignalBoard' as never, {
          query: { limit: PAGE_SIZE, ...(filter.kind === '' ? {} : { kind: filter.kind }), ...(filter.level === '' ? {} : { level: filter.level }), ...(pageParam === undefined ? {} : { cursor: pageParam }) },
        } as never),
      );
      if (page === undefined) throw new Error('RISK_BOARD_UNUSABLE');
      return page;
    },
    getNextPageParam: (last) => last.nextCursor,
    enabled: scope[1] !== undefined,
    retry: false,
  });
}

/** The lines, the history and the alerts of one project; null when the project is not there for the caller (a 404), any other failure is the failure of the read. */
export function useProjectSignals(projectId: string | undefined) {
  const client = useApiClient();
  const scope = useScopeKey();
  return useQuery<ProjectSignals | null>({
    queryKey: [...root(scope), 'project', projectId ?? ''],
    queryFn: async () => {
      try {
        return toProjectSignals(await client.read('getProjectRiskSignals' as never, { path: { id: projectId ?? '' } } as never)) ?? null;
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return null;
        throw error;
      }
    },
    enabled: scope[1] !== undefined && projectId !== undefined,
    retry: false,
  });
}

export interface AcknowledgeInput {
  id: string;
  version: number;
  body: { note: string };
}

/** One idempotency attempt per intention; the reads of the board and of the project are read again on success. */
export function useAcknowledgeRiskAlert() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const scope = useScopeKey();
  const attempts = useRef(new AttemptRegistry());
  return useMutation<unknown, Error, AcknowledgeInput>({
    mutationFn: (input) =>
      client.command('acknowledgeProjectRiskAlert' as never, { path: { id: input.id }, body: input.body, ifMatchVersion: input.version, attempt: attempts.current.forPayload(input) } as never),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: root(scope) });
    },
    onError: (error) => attempts.current.ended(error),
  });
}
