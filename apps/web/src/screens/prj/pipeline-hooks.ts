import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../api/ApiClientContext';
import { AttemptRegistry } from '../../api/attempt-registry';
import { useScopeKey } from './hooks';
import type { ProjectStatus } from './model';
import { BOARD_PAGE_SIZE, toBoardPage, toLifecycle } from './pipeline-model';
import type { BoardPage, Lifecycle, ProjectGroup, StageBody, StageOperation } from './pipeline-model';

/**
 * One column of the board: the cards of a stage in the scope of the caller, in the order of the project bank, a page at a time. The group is a
 * filter of the whole board, so it is part of the key and a column starts over when it changes.
 */
export function useBoardColumn(stage: ProjectStatus, group: ProjectGroup | '', enabled = true) {
  const client = useApiClient();
  const key = useScopeKey();
  return useInfiniteQuery({
    queryKey: [...key, 'board', stage, group],
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }): Promise<BoardPage> =>
      toBoardPage(
        await client.read('listProjectPipeline', {
          query: { stage, limit: BOARD_PAGE_SIZE, ...(group === '' ? {} : { project_group: group }), ...(pageParam === undefined ? {} : { cursor: pageParam }) },
        }),
      ),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: enabled && key[1] !== undefined,
    retry: false,
  });
}

/** The history of the stage of one project and the moves open from it with the state of their guards; null when nothing readable came back. */
export function useLifecycle(projectId: string) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<Lifecycle | null>({
    queryKey: [...key, 'lifecycle', projectId],
    queryFn: async () => toLifecycle(await client.read('getProjectLifecycle', { path: { id: projectId } })) ?? null,
    enabled: key[1] !== undefined,
    retry: false,
    // The guards are the state of the day: a dialog that is opened again reads them again.
    gcTime: 0,
  });
}

export interface StageMoveInput {
  operation: StageOperation;
  id: string;
  version: number;
  body: StageBody;
}

/** A stage command: one idempotency attempt per intention, every cached read of the register and of the board refreshed on success. */
export function useStageMove() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const key = useScopeKey();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: (input: StageMoveInput) =>
      client.command(input.operation, { path: { id: input.id }, body: input.body, ifMatchVersion: input.version, attempt: attempts.current.forPayload(input) }),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: key });
    },
    onError: (error) => attempts.current.ended(error),
  });
}
