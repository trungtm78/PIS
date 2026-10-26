import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../../api/ApiClientContext';
import { AttemptRegistry } from '../../../api/attempt-registry';
import { useSession } from '../../../session/SessionContext';
import { buildRequest, toLinesPage, toSnapshotList } from './model';
import type { LinesPage, SnapshotKind, SnapshotList, SnapshotView } from './model';

const root = (tenantId: string | undefined) => ['dis', tenantId, 'snapshots'] as const;
const PAGE_SIZE = 50;

/** The snapshots of a period, newest first, and the reports that were handed in for it and are not accepted (what a snapshot leaves out). */
export function useSnapshots(periodId: string | undefined) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<SnapshotList>({
    queryKey: [...root(tenant?.id), 'list', periodId ?? ''],
    queryFn: async () => toSnapshotList(await client.read('listPeriodSnapshots', { query: { period_id: periodId as string, limit: 100 } })),
    enabled: tenant !== undefined && periodId !== undefined,
    retry: false,
  });
}

/** The lines of one snapshot in the scope of the caller, page by page. */
export function useSnapshotLines(id: string | undefined) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useInfiniteQuery<LinesPage, Error, { pages: LinesPage[] }, readonly unknown[], string | undefined>({
    queryKey: [...root(tenant?.id), 'lines', id ?? ''],
    initialPageParam: undefined,
    queryFn: async ({ pageParam }) =>
      toLinesPage(await client.read('listPeriodSnapshotLines', { path: { id: id as string }, query: { limit: PAGE_SIZE, ...(pageParam === undefined ? {} : { cursor: pageParam }) } })),
    getNextPageParam: (last) => last.nextCursor,
    enabled: tenant !== undefined && id !== undefined,
    retry: false,
  });
}

function useCommand<Input>(send: (input: Input, attempt: ReturnType<AttemptRegistry['forPayload']>) => Promise<unknown>) {
  const queryClient = useQueryClient();
  const { tenant } = useSession();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: async (input: Input) => send(input, attempts.current.forPayload(input)),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: root(tenant?.id) });
    },
    onError: (error) => attempts.current.ended(error),
  });
}

/** Builds a snapshot of a period for a kind and a cutoff of the Treasury; nothing is frozen. */
export function useBuildSnapshot() {
  const client = useApiClient();
  return useCommand<{ periodId: string; kind: SnapshotKind; cutoffDate: string }>((input, attempt) =>
    client.command('buildPeriodSnapshot', { body: buildRequest(input.periodId, input.kind, input.cutoffDate), attempt }),
  );
}

/** Freezes a snapshot under the version the screen showed: the one frozen before for the same period and kind is replaced. */
export function useFreezeSnapshot() {
  const client = useApiClient();
  return useCommand<{ snapshot: SnapshotView }>((input, attempt) => client.command('freezePeriodSnapshot', { path: { id: input.snapshot.id }, ifMatchVersion: input.snapshot.version, attempt }));
}
