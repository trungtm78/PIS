import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../api/ApiClientContext';
import { AttemptRegistry } from '../../api/attempt-registry';
import { useSession } from '../../session/SessionContext';
import { toChanges, toFiguresFile, toRagReading } from './gov-model';
import type { Changes, FiguresFile, OverrideBand, RagReading } from './gov-model';
import { homeRoot } from './hooks';

const ragRoot = (tenantId: string | undefined, membershipId: string | undefined) => [...homeRoot(tenantId), 'rag', membershipId] as const;

/**
 * "Thay đổi từ tuần trước": at most five lines the server made by rules from this week's snapshot and the week before. It is keyed by the snapshot on the screen and the unit, so a newer snapshot or another
 * unit asks again and never shows the lines of the other.
 */
export function useHomeChanges(snapshotId: string, unitId: string, enabled = true) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<Changes>({
    queryKey: [...homeRoot(tenant?.id), 'changes', tenant?.membershipId, snapshotId, unitId],
    queryFn: async () => {
      const changes = toChanges(await client.read('getHomeChanges', { query: unitId === '' ? {} : { unit_id: unitId } }));
      if (changes === undefined) throw new Error('the changes since last week could not be read');
      return changes;
    },
    enabled: tenant !== undefined && enabled,
    retry: false,
    staleTime: 0,
    refetchOnWindowFocus: false,
  });
}

/** The explainable colours of the units of the reader (red first), of the latest frozen snapshot or of the one named, narrowed to a unit when one is chosen. */
export function useRagReading(unitId: string, snapshotId = '', enabled = true) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<RagReading>({
    queryKey: [...ragRoot(tenant?.id, tenant?.membershipId), 'reading', snapshotId, unitId],
    queryFn: async () => {
      const reading = toRagReading(await client.read('getRagReading', { query: { ...(snapshotId === '' ? {} : { snapshot_id: snapshotId }), ...(unitId === '' ? {} : { unit_id: unitId }) } }));
      if (reading === undefined) throw new Error('the colours could not be read');
      return reading;
    },
    enabled: tenant !== undefined && enabled,
    retry: false,
    staleTime: 0,
    refetchOnWindowFocus: false,
  });
}

export interface OverrideInput {
  unitId: string;
  band: OverrideBand;
  reason: string;
  until: string;
}

export interface WithdrawInput {
  unitId: string;
  reason: string;
}

/**
 * The three commands over the colours. Each user intention keeps one idempotency attempt across retries (the same body is the same intention; a different body is a new one; a final refusal ends it), and a success
 * asks the colours and the changes again so the server stays the truth.
 */
export function useRagCommands() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const { tenant } = useSession();
  const overrideAttempts = useRef(new AttemptRegistry());
  const withdrawAttempts = useRef(new AttemptRegistry());
  const scoreAttempts = useRef(new AttemptRegistry());
  const refresh = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ragRoot(tenant?.id, tenant?.membershipId) });
    await queryClient.invalidateQueries({ queryKey: [...homeRoot(tenant?.id), 'changes'] });
  };

  const override = useMutation({
    mutationFn: (input: OverrideInput) => {
      const body = { unit_id: input.unitId, band: input.band, reason: input.reason.trim(), until: input.until };
      return client.command('setRagOverride', { body, attempt: overrideAttempts.current.forPayload(body) });
    },
    onSuccess: async () => {
      overrideAttempts.current.done();
      await refresh();
    },
    onError: (error) => overrideAttempts.current.ended(error),
  });
  const withdraw = useMutation({
    mutationFn: (input: WithdrawInput) => {
      const body = { unit_id: input.unitId, reason: input.reason.trim() };
      return client.command('revokeRagOverride', { body, attempt: withdrawAttempts.current.forPayload(body) });
    },
    onSuccess: async () => {
      withdrawAttempts.current.done();
      await refresh();
    },
    onError: (error) => withdrawAttempts.current.ended(error),
  });
  const score = useMutation({
    mutationFn: () => client.command('scoreEarlyWarningWeek', { attempt: scoreAttempts.current.forPayload('score-week') }),
    onSuccess: async () => {
      scoreAttempts.current.done();
      await refresh();
    },
    onError: (error) => scoreAttempts.current.ended(error),
  });
  return { override, withdraw, score };
}

export interface ExportRequest {
  format: 'CSV' | 'XLSX';
  snapshotId: string;
  unitId: string;
}

/** The file of the figures of the snapshot on the screen (the same figures, the same text as the screen), as a base64 file the page turns into a download. */
export function useExportFigures() {
  const client = useApiClient();
  return useMutation<FiguresFile, Error, ExportRequest>({
    mutationFn: async (request) => {
      const file = toFiguresFile(await client.read('exportHomeFigures', { query: { format: request.format, ...(request.snapshotId === '' ? {} : { snapshot_id: request.snapshotId }), ...(request.unitId === '' ? {} : { unit_id: request.unitId }) } }));
      if (file === undefined) throw new Error('the file of the figures could not be read');
      return file;
    },
  });
}
