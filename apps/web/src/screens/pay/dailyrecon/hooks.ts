import { ApiError } from '@machvon/api-client';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../../api/ApiClientContext';
import { AttemptRegistry } from '../../../api/attempt-registry';
import { useScopeKey } from '../hooks';
import { toItemAnswer, toItemsPage, toRunAnswer, toRunDetail, toRunsPage } from './model';
import type { ItemAnswer, ItemsPage, RunAnswer, RunDetail, RunsPage } from './model';

/** The passes, the state of each day from `from` to `to` (both days, Vietnam time) and the thresholds in force today. */
export function useRuns(range: { from: string; to: string } | undefined, enabled = true) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<RunsPage>({
    queryKey: [...key, 'daily-recon-runs', range?.from ?? '', range?.to ?? ''],
    queryFn: async () => toRunsPage(await client.read('listTreasuryDailyReconRuns', { query: { limit: 50, ...(range === undefined ? {} : { from: range.from, to: range.to }) } })),
    placeholderData: keepPreviousData,
    enabled: enabled && key[1] !== undefined,
    retry: false,
  });
}

/** One pass with its lines of the projects the caller may see; null when it is not there for the caller (a 404). */
export function useRunDetail(id: string | null | undefined, enabled = true) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<RunDetail | null>({
    queryKey: [...key, 'daily-recon-run', id ?? ''],
    queryFn: async () => {
      try {
        return toRunDetail(await client.read('getTreasuryDailyReconRun', { path: { id: id ?? '' } })) ?? null;
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return null;
        throw error;
      }
    },
    enabled: enabled && key[1] !== undefined && typeof id === 'string',
    retry: false,
  });
}

export interface ItemFilter {
  status?: string | null;
}

/** The items of difference of the daily reconciliation the caller may see, the ones due first, with what the board counts. */
export function useItems(filter: ItemFilter, enabled = true) {
  const client = useApiClient();
  const key = useScopeKey();
  const query: Record<string, string> = { limit: '200' };
  if (filter.status) query.status = filter.status;
  return useQuery<ItemsPage>({
    queryKey: [...key, 'daily-recon-items', filter.status ?? ''],
    queryFn: async () => toItemsPage(await client.read('listTreasuryDailyReconItems', { query })),
    placeholderData: keepPreviousData,
    enabled: enabled && key[1] !== undefined,
    retry: false,
  });
}

/** One mutation hook: one idempotency attempt per intention, the cached reads of PAY refreshed on success, and the answer of the server given back. */
function useCommand<Input, Answer>(send: (input: Input, attempt: ReturnType<AttemptRegistry['forPayload']>) => Promise<unknown>, read: (value: unknown) => Answer | undefined) {
  const queryClient = useQueryClient();
  const key = useScopeKey();
  const attempts = useRef(new AttemptRegistry());
  return useMutation<Answer | undefined, Error, Input>({
    mutationFn: async (input) => read(await send(input, attempts.current.forPayload(input))),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: key });
    },
    onError: (error) => attempts.current.ended(error),
  });
}

/** Runs one business day: the lines are compared, the items opened and cleared; the same day twice with the same lines writes nothing. */
export function useRunDay() {
  const client = useApiClient();
  return useCommand<{ day: string }, RunAnswer>((input, attempt) => client.command('runTreasuryDailyRecon', { body: { recon_date: input.day }, attempt }), toRunAnswer);
}

export interface AssignInput {
  id: string;
  version: number;
  body: { owner_membership_id: string; due_on: string };
}

export function useAssign() {
  const client = useApiClient();
  return useCommand<AssignInput, ItemAnswer>((input, attempt) => client.command('assignTreasuryDailyReconItem', { path: { id: input.id }, body: input.body, ifMatchVersion: input.version, attempt }), toItemAnswer);
}

export interface ResolveInput {
  id: string;
  version: number;
  body: { resolution: 'EXPLAINED' | 'RESOLVED' | 'WRITTEN_OFF'; note: string; approval_document_version_id?: string };
}

export function useResolve() {
  const client = useApiClient();
  return useCommand<ResolveInput, ItemAnswer>((input, attempt) => client.command('resolveTreasuryDailyReconItem', { path: { id: input.id }, body: input.body, ifMatchVersion: input.version, attempt }), toItemAnswer);
}
