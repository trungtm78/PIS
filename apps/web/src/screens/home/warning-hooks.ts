import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError } from '@machvon/api-client';
import { useRef } from 'react';
import { useApiClient } from '../../api/ApiClientContext';
import { AttemptRegistry } from '../../api/attempt-registry';
import { useSession } from '../../session/SessionContext';
import { homeRoot } from './hooks';
import { toRankings, toWarningPage } from './warning-model';
import type { Rankings, WarningItem, WarningPage } from './warning-model';

const PAGE_SIZE = 25;
const warningsRoot = (tenantId: string | undefined, membershipId: string | undefined) => [...homeRoot(tenantId), 'warnings', membershipId] as const;

export interface WarningFilter {
  severity: string;
  ruleCode: string;
}

/** The open warnings of the projects the reader may read, newest first, a page at a time, narrowed by the severity and the rule. */
export function useHomeWarnings(filter: WarningFilter) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useInfiniteQuery<WarningPage, Error, { pages: WarningPage[] }, readonly unknown[], string | undefined>({
    queryKey: [...warningsRoot(tenant?.id, tenant?.membershipId), 'list', filter],
    initialPageParam: undefined,
    queryFn: async ({ pageParam }) =>
      toWarningPage(await client.read('getHomeWarnings', { query: { limit: PAGE_SIZE, ...(filter.severity === '' ? {} : { severity: filter.severity }), ...(filter.ruleCode === '' ? {} : { rule_code: filter.ruleCode }), ...(pageParam === undefined ? {} : { cursor: pageParam }) } })),
    getNextPageParam: (last) => last.nextCursor,
    enabled: tenant !== undefined,
    retry: false,
  });
}

/** The profile of one warning (the contract of the list names no warning_id yet: the server takes it, and the type is told it is a query of the list):  the cause, the evidence in its snapshot, the leader, the explanation and the history. */
export function useHomeWarning(id: string) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<WarningItem>({
    queryKey: [...warningsRoot(tenant?.id, tenant?.membershipId), 'profile', id],
    queryFn: async () => {
      const page = toWarningPage(await client.read('getHomeWarnings', { query: { warning_id: id } as { snapshot_id?: string } }));
      const found = page.items[0];
      if (found === undefined) throw new Error('the warning could not be read');
      return found;
    },
    enabled: tenant !== undefined && id !== '',
    retry: false,
  });
}

/** The ranking of the units, of the latest snapshot that has one. */
export function useRankings() {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<Rankings>({
    queryKey: [...homeRoot(tenant?.id), 'rankings', tenant?.membershipId],
    queryFn: async () => {
      const rankings = toRankings(await client.read('getDisbursementRankings', { query: {} }));
      if (rankings === undefined) throw new Error('the ranking could not be read');
      return rankings;
    },
    enabled: tenant !== undefined,
    retry: false,
  });
}

type Attempt = ReturnType<AttemptRegistry['forPayload']>;

/** One command of another module, under its own right: one idempotency attempt per intention, the warnings read again when it succeeds. */
function useCommand<Input>(send: (input: Input, attempt: Attempt) => Promise<unknown>) {
  const queryClient = useQueryClient();
  const { tenant } = useSession();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: async (input: Input) => send(input, attempts.current.forPayload(input)),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: warningsRoot(tenant?.id, tenant?.membershipId) });
    },
    onError: async (error) => {
      attempts.current.ended(error);
      // A warning that moved is read again, so that the next attempt carries the version that stands.
      if (error instanceof ApiError && error.code === 'VERSION_CONFLICT') await queryClient.invalidateQueries({ queryKey: warningsRoot(tenant?.id, tenant?.membershipId) });
    },
  });
}

export function useAcknowledgeWarning() {
  const client = useApiClient();
  return useCommand<{ warning: WarningItem; reason: string }>((input, attempt) =>
    client.command('acknowledgeEarlyWarning', { path: { id: input.warning.id }, body: { reason: input.reason }, ifMatchVersion: input.warning.version, attempt }),
  );
}

export function useDismissWarning() {
  const client = useApiClient();
  return useCommand<{ warning: WarningItem; reason: string }>((input, attempt) =>
    client.command('dismissEarlyWarning', { path: { id: input.warning.id }, body: { reason: input.reason }, ifMatchVersion: input.warning.version, attempt }),
  );
}

export interface ExplanationAsk {
  warning: WarningItem;
  question: string;
  dueAt: string;
}

/** The explanation asked for on the project of a warning, of the leader in charge of it now (PRJ). */
export function useAskExplanation() {
  const client = useApiClient();
  return useCommand<ExplanationAsk>((input, attempt) =>
    client.command('requestExplanation', {
      body: {
        subject_kind: 'PROJECT',
        project_id: input.warning.project?.id ?? '',
        warning_id: input.warning.id,
        ...(input.warning.periodId === null ? {} : { period_id: input.warning.periodId }),
        trigger_code: input.warning.ruleCode,
        question: input.question.trim(),
        requested_from_membership_id: input.warning.leader?.membershipId ?? '',
        due_at: input.dueAt,
      } as never,
      attempt,
    }),
  );
}
