import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef } from 'react';
import { useApiClient } from '../../../api/ApiClientContext';
import type { AttemptRegistry } from '../../../api/attempt-registry';
import { useSession } from '../../../session/SessionContext';
import { useEffective } from '../../adm/governance/hooks';
import type { VersionedInput } from '../hooks';
import { usePwfCommand } from '../hooks';
import { POINTS_CEILING, ADJUSTMENT_REASON_MIN, PAGE_SIZE } from './model';
import type { AdjustmentRequest, Comparison, DecisionBody, KpiOperationList, KpiResultPage, MyScorePage, PeriodExport, PeriodPage, PeriodPreview, PeriodRequest, ResponseHandle, ScoreLine, ScoreLinePage, ScorePeriod, SignalPage } from './model';

/**
 * Privacy of the scores (BR-PWF-40, R33): what these hooks read is a person's score, and the screen of a person who is not the subject must leave none of it behind. Every query of this module sits under
 * the one root `SCORE_ROOT`, carries the tenant and the membership in its key, is not kept once nothing watches it (`gcTime` 0, never served stale), and is removed from the cache when the screen goes away and
 * whenever the rights of the signed-in membership change.
 */
export const SCORE_ROOT = 'pwf-score';

export function useScoreKey(): readonly [typeof SCORE_ROOT, string | undefined, string | undefined] {
  const { tenant } = useSession();
  return [SCORE_ROOT, tenant?.id, tenant?.membershipId];
}

/** What a score query is: kept for no time at all after the last watcher goes, and read again every time a screen asks. */
const FRESH = { gcTime: 0, staleTime: 0, retry: false, refetchOnWindowFocus: false } as const;

/** Drops every score from the cache when the screen unmounts and when the membership or its rights change (a revoked right must not show a score the next render). */
export function useScoreCacheGuard(): void {
  const queryClient = useQueryClient();
  const { tenant, permissions } = useSession();
  const signature = useMemo(() => `${tenant?.id ?? ''}:${tenant?.membershipId ?? ''}:${[...(permissions ?? [])].sort().join(',')}`, [tenant, permissions]);
  const previous = useRef(signature);
  useEffect(() => {
    if (previous.current !== signature) {
      previous.current = signature;
      queryClient.removeQueries({ queryKey: [SCORE_ROOT] });
    }
  }, [signature, queryClient]);
  useEffect(
    () => () => {
      queryClient.removeQueries({ queryKey: [SCORE_ROOT] });
    },
    [queryClient],
  );
}

// ---- reads ------------------------------------------------------------------------------------------------------------------------------------------------------------------

/** The score of the signed-in person in each period, with the trace down to the tasks (only their own). */
export function useMyScores(enabled = true) {
  const client = useApiClient();
  const key = useScoreKey();
  return useInfiniteQuery<MyScorePage, Error, { pages: MyScorePage[] }, readonly unknown[], string | undefined>({
    queryKey: [...key, 'mine'],
    initialPageParam: undefined,
    queryFn: ({ pageParam }) => client.read('getMyStaffScore', { query: { limit: PAGE_SIZE, ...(pageParam === undefined ? {} : { cursor: pageParam }) } }),
    getNextPageParam: (last) => last.next_cursor ?? undefined,
    enabled: enabled && key[1] !== undefined,
    ...FRESH,
  });
}

/** The periods of one person side by side. */
export function useComparison(membershipId: string | undefined, enabled: boolean) {
  const client = useApiClient();
  const key = useScoreKey();
  return useQuery<Comparison>({
    queryKey: [...key, 'compare', membershipId ?? ''],
    queryFn: () => client.read('compareStaffScoreLines', { query: membershipId === undefined ? {} : { membership_id: membershipId } }),
    enabled: enabled && key[1] !== undefined,
    ...FRESH,
  });
}

/** One line with its trace; another person's line is read in the scope of the caller and audited by the server (ADM-11). */
export function useScoreLine(lineId: string | null, enabled = true) {
  const client = useApiClient();
  const key = useScoreKey();
  return useQuery<ScoreLine>({
    queryKey: [...key, 'line', lineId ?? ''],
    queryFn: () => client.read('getStaffScoreLine', { path: { id: lineId ?? '' } }),
    enabled: enabled && key[1] !== undefined && lineId !== null,
    ...FRESH,
  });
}

/** The KPI results behind one task of a line: formula, value, score and the facts they were computed from. */
export function useTaskKpiResults(taskId: string | null, enabled: boolean) {
  const client = useApiClient();
  const key = useScoreKey();
  return useQuery<KpiResultPage>({
    queryKey: [...key, 'kpi-results', taskId ?? ''],
    queryFn: () => client.read('listTaskKpiResults', { path: { task_id: taskId ?? '' } }),
    enabled: enabled && key[1] !== undefined && taskId !== null,
    ...FRESH,
  });
}

export interface PeriodFilter {
  unitId?: string | undefined;
  status?: string | undefined;
}

/** The periods within the scope of the caller, page by page. */
export function usePeriods(filter: PeriodFilter, enabled: boolean) {
  const client = useApiClient();
  const key = useScoreKey();
  return useInfiniteQuery<PeriodPage, Error, { pages: PeriodPage[] }, readonly unknown[], string | undefined>({
    queryKey: [...key, 'periods', filter.unitId ?? '', filter.status ?? ''],
    initialPageParam: undefined,
    queryFn: ({ pageParam }) =>
      client.read('listStaffScorePeriods', { query: { limit: PAGE_SIZE, ...(filter.unitId === undefined ? {} : { scope_unit_id: filter.unitId }), ...(filter.status === undefined ? {} : { status: filter.status }), ...(pageParam === undefined ? {} : { cursor: pageParam }) } }),
    getNextPageParam: (last) => last.next_cursor ?? undefined,
    enabled: enabled && key[1] !== undefined,
    ...FRESH,
  });
}

export function usePeriod(periodId: string | null, enabled: boolean) {
  const client = useApiClient();
  const key = useScoreKey();
  return useQuery<ScorePeriod>({
    queryKey: [...key, 'period', periodId ?? ''],
    queryFn: () => client.read('getStaffScorePeriod', { path: { id: periodId ?? '' } }),
    enabled: enabled && key[1] !== undefined && periodId !== null,
    ...FRESH,
  });
}

export interface LineFilter {
  state?: string | undefined;
  unitId?: string | undefined;
}

/** The lines of a period the caller may see (the server judges the unit of each line at the time of the period), page by page. */
export function usePeriodLines(periodId: string | null, filter: LineFilter, enabled: boolean) {
  const client = useApiClient();
  const key = useScoreKey();
  return useInfiniteQuery<ScoreLinePage, Error, { pages: ScoreLinePage[] }, readonly unknown[], string | undefined>({
    queryKey: [...key, 'lines', periodId ?? '', filter.state ?? '', filter.unitId ?? ''],
    initialPageParam: undefined,
    queryFn: ({ pageParam }) =>
      client.read('listStaffScoreLines', {
        path: { id: periodId ?? '' },
        query: { limit: PAGE_SIZE, ...(filter.state === undefined ? {} : { state: filter.state }), ...(filter.unitId === undefined ? {} : { unit_id: filter.unitId }), ...(pageParam === undefined ? {} : { cursor: pageParam }) },
      }),
    getNextPageParam: (last) => last.next_cursor ?? undefined,
    enabled: enabled && key[1] !== undefined && periodId !== null,
    ...FRESH,
  });
}

/** The flags of possible gaming, for the people who review the period; they change no score. */
export function useSignals(periodId: string | null, enabled: boolean) {
  const client = useApiClient();
  const key = useScoreKey();
  return useInfiniteQuery<SignalPage, Error, { pages: SignalPage[] }, readonly unknown[], string | undefined>({
    queryKey: [...key, 'signals', periodId ?? ''],
    initialPageParam: undefined,
    queryFn: ({ pageParam }) => client.read('listStaffScoreSignals', { path: { id: periodId ?? '' }, query: { limit: PAGE_SIZE, ...(pageParam === undefined ? {} : { cursor: pageParam }) } }),
    getNextPageParam: (last) => last.next_cursor ?? undefined,
    enabled: enabled && key[1] !== undefined && periodId !== null,
    ...FRESH,
  });
}

/** The catalogue of operations a KPI may be computed by (the set only picks from it). */
export function useKpiOperations(enabled: boolean) {
  const client = useApiClient();
  const key = useScoreKey();
  return useQuery<KpiOperationList>({
    queryKey: [...key, 'kpi-operations'],
    queryFn: () => client.read('getKpiOperations', {}),
    enabled: enabled && key[1] !== undefined,
    ...FRESH,
  });
}

/** The swing and the length of reason the scoring policy of a period allows, read from the rule (the server judges again); the contract ceiling when the rule cannot be read. */
export function usePolicyLimits(policyCode: string | undefined, enabled: boolean): { ceiling: number; reasonMin: number } {
  const effective = useEffective('STAFF_SCORING_POLICY', policyCode, undefined, enabled && policyCode !== undefined);
  const calibration = (effective.data?.params as { calibration?: { max_adjustment_points?: unknown; min_reason_length?: unknown } } | undefined)?.calibration;
  const points = calibration?.max_adjustment_points;
  const reason = calibration?.min_reason_length;
  return { ceiling: typeof points === 'number' && points > 0 && points <= POINTS_CEILING ? points : POINTS_CEILING, reasonMin: typeof reason === 'number' && reason >= ADJUSTMENT_REASON_MIN ? reason : ADJUSTMENT_REASON_MIN };
}

// ---- commands ---------------------------------------------------------------------------------------------------------------------------------------------------------------

/** One mutation: one idempotency attempt per intention; every score read is read again on success, and so is the rest of the module. */
function useScoreCommand<Input, Output = unknown>(send: (input: Input, attempt: ReturnType<AttemptRegistry['forPayload']>) => Promise<Output>) {
  const queryClient = useQueryClient();
  const base = usePwfCommand<Input>(send);
  return {
    ...base,
    mutateAsync: async (input: Input): Promise<unknown> => {
      const result = await base.mutateAsync(input);
      await queryClient.invalidateQueries({ queryKey: [SCORE_ROOT] });
      return result;
    },
  };
}

export function useComputePeriod() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const base = usePwfCommand<PeriodRequest>((body, attempt) => client.command('computeStaffScorePeriod', { body, attempt }));
  return {
    ...base,
    mutateAsync: async (body: PeriodRequest): Promise<PeriodPreview> => {
      const preview = (await base.mutateAsync(body)) as PeriodPreview;
      await queryClient.invalidateQueries({ queryKey: [SCORE_ROOT] });
      return preview;
    },
  };
}

export function useLockPeriod() {
  const client = useApiClient();
  return useScoreCommand<{ id: string; version: number }>((input, attempt) => client.command('lockStaffScorePeriod', { path: { id: input.id }, ifMatchVersion: input.version, attempt }));
}

export function useOfficializePeriod() {
  const client = useApiClient();
  return useScoreCommand<{ id: string; version: number }>((input, attempt) => client.command('officializeStaffScorePeriod', { path: { id: input.id }, ifMatchVersion: input.version, attempt }));
}

export function useRequestAdjustment() {
  const client = useApiClient();
  return useScoreCommand<{ id: string; body: AdjustmentRequest }>((input, attempt) => client.command('requestStaffScoreAdjustment', { path: { id: input.id }, body: input.body, attempt }));
}

export function useDecideAdjustment() {
  const client = useApiClient();
  return useScoreCommand<VersionedInput<DecisionBody>>((input, attempt) => client.command('decideStaffScoreAdjustment', { path: { id: input.id }, body: input.body, ifMatchVersion: input.version, attempt }));
}

export function useSubmitResponse() {
  const client = useApiClient();
  return useScoreCommand<{ id: string; body: string }>((input, attempt) => client.command('submitStaffScoreResponse', { path: { id: input.id }, body: { body: input.body }, attempt }));
}

export function useHandleResponse() {
  const client = useApiClient();
  return useScoreCommand<VersionedInput<ResponseHandle>>((input, attempt) => client.command('handleStaffScoreResponse', { path: { id: input.id }, body: input.body, ifMatchVersion: input.version, attempt }));
}

/** The file of a period as the caller may have it: asked for on a click and never kept in the cache (a mutation, not a query). */
export function useExportPeriod() {
  const client = useApiClient();
  return useMutation<PeriodExport, Error, string>({ mutationFn: (periodId) => client.read('exportStaffScorePeriod', { path: { id: periodId }, query: { format: 'xlsx' } }), gcTime: 0 });
}

/** Reads every score read again (after a refusal that says somebody changed it first). */
export function useReloadScores(): () => Promise<void> {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: [SCORE_ROOT] });
}
