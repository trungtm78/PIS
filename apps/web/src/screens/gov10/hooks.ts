import type { ApiClient } from '@machvon/api-client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../api/ApiClientContext';
import { AttemptRegistry } from '../../api/attempt-registry';
import { useSession } from '../../session/SessionContext';
import { toClosurePage, toClosureSummary, toFeedbackPage, toFindingDetail, toFindingPage, toFlood, toIndicators, toLadderKpi, toLadderPolicies, toLadderRuns, toRedFlagSummary, toStorms, toTypeStats } from './model';

type ReadOperation = Parameters<ApiClient['read']>[0];
type CommandOperation = Parameters<ApiClient['command']>[0];
type Parts = { path?: Record<string, string>; query?: Record<string, string | number | boolean | undefined> };

const callRead = (client: ApiClient, operation: string, input: Parts): Promise<unknown> => (client.read as (operation: ReadOperation, input?: unknown) => Promise<unknown>)(operation as ReadOperation, input);
const callCommand = (client: ApiClient, operation: string, input: unknown): Promise<unknown> => (client.command as (operation: CommandOperation, input: unknown) => Promise<unknown>)(operation as CommandOperation, input);

/** What a screen shows depends on the places the signed-in membership reaches, not only on the tenant: the membership is part of every key. */
function useScope(root: string): readonly [string, string | undefined, string | undefined] {
  const { tenant } = useSession();
  return [root, tenant?.id, tenant?.membershipId];
}

function useGovRead<T>(root: string, name: string, operation: string, input: Parts, parse: (raw: unknown) => T, enabled = true) {
  const client = useApiClient();
  const scope = useScope(root);
  return useQuery<T>({
    queryKey: [...scope, name, input],
    queryFn: async () => parse(await callRead(client, operation, input)),
    enabled: scope[1] !== undefined && enabled,
    retry: false,
  });
}

/** One command with one idempotency attempt per intention; every read of the screen group is refreshed when it succeeds. */
export function useGovCommand<I>(root: string, send: (input: I, attempt: ReturnType<AttemptRegistry['forPayload']>, client: ApiClient) => Promise<unknown>) {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const scope = useScope(root);
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: (input: I) => send(input, attempts.current.forPayload(input), client),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: scope });
    },
    onError: (error) => attempts.current.ended(error),
  });
}

// -- red flags ------------------------------------------------------------------------------------------------------------------------------------------------------------------------

export interface RedFlagFilter {
  status?: string | undefined;
  band?: string | undefined;
  offset: number;
}
export const RED_FLAG_PAGE = 25;
const RF = 'gov10-red-flags';

export const useRedFlags = (filter: RedFlagFilter) =>
  useGovRead(RF, 'list', 'listRedFlags', { query: { ...(filter.status === undefined ? {} : { status: filter.status }), ...(filter.band === undefined ? {} : { band: filter.band }), limit: RED_FLAG_PAGE, offset: filter.offset } }, toFindingPage);
export const useRedFlagSummary = () => useGovRead(RF, 'summary', 'getRedFlagSummary', {}, toRedFlagSummary);
export const useRedFlagIndicators = () => useGovRead(RF, 'indicators', 'listRedFlagIndicators', {}, toIndicators);
export const useRedFlag = (id: string) => useGovRead(RF, 'one', 'getRedFlag', { path: { id } }, toFindingDetail, id !== '');

export const useScanRedFlags = () => useGovCommand<{ note?: string }>(RF, (input, attempt, client) => callCommand(client, 'scanRedFlags', { body: input.note === undefined ? {} : { note: input.note }, attempt }));

export type RedFlagMoveName = 'takeRedFlag' | 'proposeClearRedFlag' | 'confirmClearRedFlag' | 'rejectClearRedFlag' | 'referRedFlag';
export interface RedFlagMoveInput {
  id: string;
  version: number;
  move: RedFlagMoveName;
  reason?: string | undefined;
}
export const useRedFlagMove = () =>
  useGovCommand<RedFlagMoveInput>(RF, (input, attempt, client) =>
    callCommand(client, input.move, { path: { id: input.id }, ifMatchVersion: input.version, attempt, ...(input.reason === undefined ? {} : { body: { reason: input.reason } }) }),
  );

// -- the channel ladder ---------------------------------------------------------------------------------------------------------------------------------------------------------

const LD = 'gov10-ladder';
export const LADDER_PAGE = 25;
export const useLadderPolicies = () => useGovRead(LD, 'policy', 'getAlertLadderPolicy', {}, toLadderPolicies);
export const useLadderRuns = (filter: { state?: string | undefined; severity?: string | undefined; offset: number }) =>
  useGovRead(LD, 'runs', 'listAlertLadderRuns', { query: { ...(filter.state === undefined ? {} : { state: filter.state }), ...(filter.severity === undefined ? {} : { severity: filter.severity }), limit: LADDER_PAGE, offset: filter.offset } }, toLadderRuns);
export const useLadderKpi = () => useGovRead(LD, 'kpi', 'getAlertLadderKpi', {}, toLadderKpi);

// -- feedback, closures, storms -------------------------------------------------------------------------------------------------------------------------------------------

const AO = 'gov10-alert-ops';
export const useFeedbackQueue = (status: string | undefined, cursor: string | undefined) =>
  useGovRead(AO, 'feedback', 'listAlertFeedback', { query: { ...(status === undefined ? {} : { status }), ...(cursor === undefined ? {} : { cursor }), limit: 25 } }, toFeedbackPage);
export const useFeedbackStats = () => useGovRead(AO, 'feedback-stats', 'getAlertFeedbackStats', {}, toTypeStats);
export const useClosures = (filter: { withoutRecord: boolean; reopened: boolean }, cursor: string | undefined) =>
  useGovRead(AO, 'closures', 'listAlertClosures', { query: { state: 'RESOLVED_BY_SYSTEM', ...(filter.withoutRecord ? { without_record: true } : {}), ...(filter.reopened ? { reopened: true } : {}), ...(cursor === undefined ? {} : { cursor }), limit: 25 } }, toClosurePage);
export const useClosureSummary = () => useGovRead(AO, 'closure-summary', 'getAlertClosureSummary', {}, toClosureSummary);
export const useStorms = () => useGovRead(AO, 'storms', 'listAlertStorms', { query: { limit: 25 } }, toStorms);
export const useFlood = () => useGovRead(AO, 'flood', 'getAlertFlood', {}, toFlood);

export interface ReviewInput {
  id: string;
  version: number;
  move: 'ACCEPT_FOR_TUNING' | 'REJECT' | 'MARK_DUPLICATE';
  reviewNote?: string | undefined;
  proposalNote?: string | undefined;
  duplicateOfId?: string | undefined;
}
export const useReviewFeedback = () =>
  useGovCommand<ReviewInput>(AO, (input, attempt, client) =>
    callCommand(client, 'reviewAlertFeedback', {
      path: { id: input.id },
      ifMatchVersion: input.version,
      attempt,
      body: { move: input.move, ...(input.reviewNote === undefined ? {} : { review_note: input.reviewNote }), ...(input.proposalNote === undefined ? {} : { proposal_note: input.proposalNote }), ...(input.duplicateOfId === undefined ? {} : { duplicate_of_id: input.duplicateOfId }) },
    }),
  );

export interface ReportInput {
  source: string;
  sourceId: string;
  reason: string;
  note?: string | undefined;
}
export const useReportAlertWrong = () =>
  useGovCommand<ReportInput>(AO, (input, attempt, client) => callCommand(client, 'reportAlertWrong', { body: { source: input.source, source_id: input.sourceId, reason: input.reason, ...(input.note === undefined ? {} : { note: input.note }) }, attempt }));

export const useMyFeedback = () => useGovRead(AO, 'feedback-mine', 'listMyAlertFeedback', { query: { limit: 50 } }, toFeedbackPage);
export interface WithdrawInput {
  id: string;
  version: number;
}
export const useWithdrawFeedback = () => useGovCommand<WithdrawInput>(AO, (input, attempt, client) => callCommand(client, 'withdrawAlertFeedback', { path: { id: input.id }, ifMatchVersion: input.version, attempt, body: {} }));

/** The ladders of one alert item (`getAlertLadderForItem`): read only when the person asked for an item. */
export const useLadderItem = (source: string, sourceId: string, enabled: boolean) => useGovRead(LD, 'item', 'getAlertLadderForItem', { query: { source, source_id: sourceId } }, toLadderRuns, enabled);
