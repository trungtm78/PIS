import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../../api/ApiClientContext';
import { AttemptRegistry } from '../../../api/attempt-registry';
import { useSession } from '../../../session/SessionContext';
import { boardQueryOf, toBatch, toBatches, toBoard, toHistory, toTaxonomy } from './model';
import type { BoardQuery, FundingBatch, FundingBoard, FundingHistory, FundingTaxonomy } from './model';

// What the screens show depends on the places the signed-in membership reaches, not only on the tenant: the membership is part of every key.
function useScopeKey(): readonly ['dis-funding', string | undefined, string | undefined] {
  const { tenant } = useSession();
  return ['dis-funding', tenant?.id, tenant?.membershipId];
}

type Query = Record<string, string | number | boolean | undefined>;
const q = (value: Query): never => value as never;
type Runner = (operation: string, input: unknown) => Promise<unknown>;

/** The pack in force: classes, tiers, measures, the ratios, and where the numbers come from. Read once for a screen (it moves with a rule version, not with a minute). */
export function useTaxonomy() {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<FundingTaxonomy>({ queryKey: [...key, 'taxonomy'], queryFn: async () => toTaxonomy(await client.read('getFundingTaxonomy')), enabled: key[1] !== undefined, retry: false });
}

export function useBoard(query: BoardQuery | undefined) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<FundingBoard>({
    queryKey: [...key, 'board', query],
    queryFn: async () => toBoard(await client.read('getFundingFigureBoard', { query: q(boardQueryOf(query as BoardQuery)) })),
    enabled: key[1] !== undefined && query !== undefined,
    retry: false,
  });
}

export interface BatchFilter {
  status?: string;
  projectId?: string;
  planYear?: number;
}

export function useBatches(filter: BatchFilter) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<FundingBatch[]>({
    queryKey: [...key, 'batches', filter],
    queryFn: async () => toBatches(await client.read('listFundingFigureBatches', { query: q({ status: filter.status, project_id: filter.projectId, plan_year: filter.planYear, limit: 100 }) })),
    enabled: key[1] !== undefined,
    retry: false,
  });
}

export function useBatch(batchId: string | undefined) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<FundingBatch>({
    queryKey: [...key, 'batch', batchId],
    queryFn: async () => toBatch(await client.read('getFundingFigureBatch', { path: { batch_id: batchId } } as never)),
    enabled: key[1] !== undefined && batchId !== undefined,
    retry: false,
  });
}

export interface HistoryKey {
  projectId: string;
  classCode: string;
  tierCode: string;
  measure: string;
  grain: string;
  planYear: number;
  ordinal: number;
}

export function useHistory(history: HistoryKey | undefined) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<FundingHistory>({
    queryKey: [...key, 'history', history],
    queryFn: async () => {
      const found = history as HistoryKey;
      return toHistory(await client.read('getFundingFigureHistory', { query: q({ project_id: found.projectId, class_code: found.classCode, tier_code: found.tierCode, measure: found.measure, period_grain: found.grain, plan_year: found.planYear, period_ordinal: found.ordinal }) }));
    },
    enabled: key[1] !== undefined && history !== undefined,
    retry: false,
  });
}

/** One command with one idempotency attempt for each intention; every read of the figures is refreshed on success. */
function useFigureCommand<Input extends object>(send: (run: Runner, input: Input, attempt: unknown) => Promise<unknown>) {
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
    onError: (error) => attempts.current.ended(error),
  });
}

export interface ProposeInput {
  body: Record<string, unknown>;
}
export interface MoveInput {
  batchId: string;
  /** The version of the batch the caller saw: the server refuses the move when the batch moved (409 VERSION_CONFLICT). */
  version: number;
  reason?: string;
}

export const usePropose = () => useFigureCommand<ProposeInput>((run, input, attempt) => run('proposeFundingFigures', { body: input.body, attempt }));
export const useSubmit = () => useFigureCommand<MoveInput>((run, input, attempt) => run('submitFundingFigures', { path: { batch_id: input.batchId }, body: {}, ifMatchVersion: input.version, attempt }));
export const useAccept = () => useFigureCommand<MoveInput>((run, input, attempt) => run('acceptFundingFigures', { path: { batch_id: input.batchId }, body: {}, ifMatchVersion: input.version, attempt }));
export const useReturn = () => useFigureCommand<MoveInput>((run, input, attempt) => run('returnFundingFigures', { path: { batch_id: input.batchId }, body: { reason: input.reason }, ifMatchVersion: input.version, attempt }));
export const useWithdraw = () => useFigureCommand<MoveInput>((run, input, attempt) => run('withdrawFundingFigures', { path: { batch_id: input.batchId }, body: { reason: input.reason }, ifMatchVersion: input.version, attempt }));
