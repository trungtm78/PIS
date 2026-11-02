import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../../api/ApiClientContext';
import { AttemptRegistry } from '../../../api/attempt-registry';
import { useTranslation } from '../../../i18n';
import { useSession } from '../../../session/SessionContext';
import { toOcrListing } from '../ocr/model';
import { toTrackedPackage } from '../procurement/model';
import type { TrackedPackage } from '../procurement/model';
import type { OcrListing } from '../ocr/model';
import { findingQuery, isCommittedRefusal, toFindingList, toRun, toRunList, toStarted } from './model';
import type { FindingFilter, FindingList, Run, RunList, RunStatus, Started, StartBody } from './model';

const PAGE_SIZE = 25;

// What the screens show depends on what the signed-in membership may see, not only on the tenant: the membership is part of every key.
function useScopeKey(): readonly ['bid-analysis', string | undefined, string | undefined] {
  const { tenant } = useSession();
  return ['bid-analysis', tenant?.id, tenant?.membershipId];
}

/** The runs of one proposal, newest first, a page at a time; none is asked for until the proposal is chosen and the caller holds the right to read runs. */
export function useRuns(proposalId: string, status: RunStatus | '', enabled: boolean) {
  const client = useApiClient();
  const key = useScopeKey();
  return useInfiniteQuery<RunList, Error, { pages: RunList[] }, readonly unknown[], string | undefined>({
    queryKey: [...key, 'runs', proposalId, status],
    initialPageParam: undefined,
    queryFn: async ({ pageParam }) =>
      toRunList(await client.read('get_resources_analysis_run', { query: { proposal_id: proposalId, ...(status === '' ? {} : { status }), limit: PAGE_SIZE, ...(pageParam === undefined ? {} : { cursor: pageParam }) } })),
    getNextPageParam: (last) => last.nextCursor,
    enabled: enabled && key[1] !== undefined && proposalId !== '',
    retry: false,
  });
}

/** One run, with its timeline, read when the caller holds the right to read runs. */
export function useRun(runId: string, enabled: boolean) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<Run | undefined>({
    queryKey: [...key, 'run', runId],
    queryFn: async () => toRun(await client.read('get_resources_analysis_run_id', { path: { id: runId } })),
    enabled: enabled && key[1] !== undefined && runId !== '',
    retry: false,
  });
}

/** The findings of a run with their evidence for a filter, a page at a time; reading them is recorded on the server as the opening of the evidence, so it is made when the caller may and not before. */
export function useFindings(runId: string, filter: FindingFilter, enabled: boolean) {
  const client = useApiClient();
  const key = useScopeKey();
  return useInfiniteQuery<FindingList, Error, { pages: FindingList[] }, readonly unknown[], string | undefined>({
    queryKey: [...key, 'findings', runId, filter],
    initialPageParam: undefined,
    queryFn: async ({ pageParam }) =>
      toFindingList(await client.read('listAnalysisFindings', { path: { id: runId }, query: { ...findingQuery(filter), limit: PAGE_SIZE, ...(pageParam === undefined ? {} : { cursor: pageParam }) } })),
    getNextPageParam: (last) => last.nextCursor,
    enabled: enabled && key[1] !== undefined && runId !== '',
    retry: false,
  });
}

/** Whether a page of the proposal still waits for a person: the gate of the analysis, read from the first page of the OCR of the proposal. */
export function useOcrGate(proposalId: string, enabled: boolean) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<OcrListing>({
    queryKey: [...key, 'gate', proposalId],
    queryFn: async () => toOcrListing(await client.read('listProposalOcrPages', { path: { id: proposalId }, query: { limit: 1 } })),
    enabled: enabled && key[1] !== undefined && proposalId !== '',
    retry: false,
  });
}

/** The request of a run: one idempotency attempt per intention, so a retry after a lost answer is the same request; every cached read of the screens is refreshed on success. */
export function useStartRun() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const key = useScopeKey();
  const attempts = useRef(new AttemptRegistry());
  return useMutation<Started | undefined, unknown, StartBody>({
    mutationFn: async (body) => toStarted(await client.command('post_analysis_runs', { body, attempt: attempts.current.forPayload(body) })),
    onSuccess: () => attempts.current.done(),
    // A request the gateway refused is kept as a run that ended, so the runs are read again whatever the answer was.
    onSettled: () => queryClient.invalidateQueries({ queryKey: key }),
    onError: (error) => {
      if (isCommittedRefusal(error)) attempts.current.done();
      else attempts.current.ended(error);
    },
  });
}

export interface CancelInput {
  run: Run;
  reason: string;
}

/** The cancellation of a run that waits for the experts: it names the version the person saw, and one attempt stands for one intention. */
export function useCancelRun() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const key = useScopeKey();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: (input: CancelInput) => {
      const body = { reason: input.reason.trim() };
      return client.command('post_analysis_runs_id_cancel', { path: { id: input.run.id }, body, ifMatchVersion: input.run.version, attempt: attempts.current.forPayload({ id: input.run.id, version: input.run.version, body }) });
    },
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: key });
    },
    onError: (error) => attempts.current.ended(error),
  });
}

/** The moment as a person reads it, in the zone of the server. */
export function useMoment(): (iso: string | null) => string {
  const { locale } = useTranslation();
  return (iso) => (iso === null ? '' : new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'short', timeZone: 'UTC' }).format(new Date(iso)));
}

/** The packages of the scope of the caller; none is asked for before the caller may use the screen. */
export function usePackages(enabled: boolean) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<TrackedPackage[]>({
    queryKey: [...key, 'packages'],
    queryFn: async () => (await client.readAll('get_resources_procurement_package')).flatMap((raw) => toTrackedPackage(raw) ?? []),
    enabled: enabled && key[1] !== undefined,
    retry: false,
  });
}
