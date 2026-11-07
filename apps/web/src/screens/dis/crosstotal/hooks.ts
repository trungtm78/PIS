import { ApiError } from '@machvon/api-client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../../api/ApiClientContext';
import { AttemptRegistry } from '../../../api/attempt-registry';
import { useSession } from '../../../session/SessionContext';
import { toCheckAnswer, toControl, toSnapshotHeads } from './model';
import type { CheckAnswer, Control, SnapshotHead } from './model';

const root = (tenantId: string | undefined, membershipId: string | undefined) => ['dis', tenantId, membershipId, 'cross-total'] as const;

/** The latest snapshots the caller may pick from, newest first. */
export function useSnapshotHeads(enabled = true) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<SnapshotHead[]>({
    queryKey: [...root(tenant?.id, tenant?.membershipId), 'snapshots'],
    queryFn: async () => toSnapshotHeads(await client.read('listPeriodSnapshots', { query: { limit: 20 } })),
    enabled: enabled && tenant !== undefined,
    retry: false,
  });
}

/** The control of one snapshot, read now; null when it is not there for the caller (a 404). */
export function useControl(snapshotId: string | undefined, enabled = true) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<Control | null>({
    queryKey: [...root(tenant?.id, tenant?.membershipId), 'control', snapshotId ?? ''],
    queryFn: async () => {
      try {
        return toControl(await client.read('getCrossTotalControl', { path: { id: snapshotId ?? '' } })) ?? null;
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return null;
        throw error;
      }
    },
    enabled: enabled && tenant !== undefined && snapshotId !== undefined,
    retry: false,
  });
}

/** Writes a check of the snapshot (the history of why it was or was not frozen); one idempotency attempt per intention. */
export function useEvaluate() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const { tenant } = useSession();
  const attempts = useRef(new AttemptRegistry());
  return useMutation<CheckAnswer | undefined, Error, { snapshotId: string }>({
    mutationFn: async (input) => toCheckAnswer(await client.command('evaluateCrossTotal', { path: { id: input.snapshotId }, body: {}, attempt: attempts.current.forPayload(input) })),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: root(tenant?.id, tenant?.membershipId) });
    },
    onError: (error) => attempts.current.ended(error),
  });
}
