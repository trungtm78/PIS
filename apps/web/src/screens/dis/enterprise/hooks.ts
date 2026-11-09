import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../../api/ApiClientContext';
import { AttemptRegistry } from '../../../api/attempt-registry';
import { useSession } from '../../../session/SessionContext';
import { toDetail, toReadiness, toSnapshots } from './model';
import type { Readiness, Snapshot, SnapshotDetail } from './model';

// What the screens show depends on the places the signed-in membership reaches, not only on the tenant: the membership is part of every key.
function useScopeKey(): readonly ['dis-enterprise', string | undefined, string | undefined] {
  const { tenant } = useSession();
  return ['dis-enterprise', tenant?.id, tenant?.membershipId];
}

type Query = Record<string, string | number | boolean | undefined>;
const q = (value: Query): never => value as never;
type Runner = (operation: string, input: unknown) => Promise<unknown>;

/** Whether the period can be built now and what is missing; read for the period the person picked. */
export function useReadiness(periodId: string | undefined) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<Readiness>({
    queryKey: [...key, 'readiness', periodId],
    queryFn: async () => toReadiness(await client.read('getEnterpriseSnapshotReadiness', { query: q({ period_id: periodId }) })),
    enabled: key[1] !== undefined && periodId !== undefined,
    retry: false,
  });
}

/** The snapshots of one period, newest revision first as the server orders them. */
export function useSnapshots(periodId: string | undefined) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<Snapshot[]>({
    queryKey: [...key, 'list', periodId],
    queryFn: async () => toSnapshots(await client.read('listEnterpriseSnapshots', { query: q({ period_id: periodId, limit: 100 }) })),
    enabled: key[1] !== undefined && periodId !== undefined,
    retry: false,
  });
}

export function useSnapshot(snapshotId: string | undefined, measure: string | undefined) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<SnapshotDetail>({
    queryKey: [...key, 'detail', snapshotId, measure],
    queryFn: async () => toDetail(await client.read('getEnterpriseSnapshot', { path: { id: snapshotId }, ...(measure === undefined ? {} : { query: q({ measure }) }) } as never)),
    enabled: key[1] !== undefined && snapshotId !== undefined,
    retry: false,
  });
}

/** One command with one idempotency attempt for each intention; every read of the snapshots is refreshed once it ended, and a refusal also refreshes what the screen says is missing. */
function useSnapshotCommand<Input extends object>(send: (run: Runner, input: Input, attempt: unknown) => Promise<unknown>) {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const key = useScopeKey();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: (input: Input) => send(client.command as unknown as Runner, input, attempts.current.forPayload(input)),
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

export interface BuildInput {
  periodId: string;
}
export interface FreezeInput {
  snapshotId: string;
  /** The version of the snapshot the caller saw: the server refuses the freeze when the snapshot moved (409 VERSION_CONFLICT). */
  version: number;
}

export const useBuild = () => useSnapshotCommand<BuildInput>((run, input, attempt) => run('buildEnterpriseSnapshot', { body: { period_id: input.periodId }, attempt }));
export const useFreeze = () => useSnapshotCommand<FreezeInput>((run, input, attempt) => run('freezeEnterpriseSnapshot', { path: { id: input.snapshotId }, ifMatchVersion: input.version, attempt }));
