import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../api/ApiClientContext';
import { AttemptRegistry } from '../../api/attempt-registry';
import { useSession } from '../../session/SessionContext';
import { toDecisionDetail, toDecisionPage } from './decision-model';
import type { DecisionDetail, DecisionPage, Outcome, SubjectKind } from './decision-model';

const root = (tenantId: string | undefined, membershipId: string | undefined) => ['ana', tenantId, membershipId, 'decisions'] as const;

export interface DecisionFilters {
  subjectKind: SubjectKind | '';
  openFollowUp: boolean;
  cursor: string;
}

export function useDecisions(filters: DecisionFilters) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<DecisionPage>({
    queryKey: [...root(tenant?.id, tenant?.membershipId), 'list', filters.subjectKind, filters.openFollowUp, filters.cursor],
    queryFn: async () => {
      const page = toDecisionPage(
        await client.read('listAnalyticsDecisions', {
          query: { ...(filters.subjectKind === '' ? {} : { subject_kind: filters.subjectKind }), ...(filters.openFollowUp ? { open_follow_up: true } : {}), ...(filters.cursor === '' ? {} : { cursor: filters.cursor }), limit: 25 },
        }),
      );
      if (page === undefined) throw new Error('the decisions could not be read');
      return page;
    },
    enabled: tenant !== undefined,
    retry: false,
    staleTime: 0,
    refetchOnWindowFocus: false,
  });
}

export function useDecision(id: string) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<DecisionDetail>({
    queryKey: [...root(tenant?.id, tenant?.membershipId), 'one', id],
    queryFn: async () => {
      const detail = toDecisionDetail(await client.read('getAnalyticsDecision', { path: { id } }));
      if (detail === undefined) throw new Error('the decision could not be read');
      return detail;
    },
    enabled: tenant !== undefined && id !== '',
    retry: false,
    staleTime: 0,
    refetchOnWindowFocus: false,
  });
}

export interface RecordInput {
  subject: { kind: SubjectKind; metricCode?: string | undefined; unitId?: string | undefined; source?: string | undefined; sourceId?: string | undefined; title?: string | undefined };
  kind: string;
  reason: string;
  followUpDue: string;
  followUpOwnerId: string;
}
export interface OutcomeInput {
  id: string;
  outcome: Outcome;
  note: string;
  supersededBy: string;
}

/** The two commands of the log. Each intention keeps one idempotency attempt across retries; the log and the open decision are read again after a success so that the server stays the truth. */
export function useDecisionCommands() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const { tenant } = useSession();
  const recordAttempts = useRef(new AttemptRegistry());
  const outcomeAttempts = useRef(new AttemptRegistry());
  const refresh = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: root(tenant?.id, tenant?.membershipId) });
  };
  const record = useMutation({
    mutationFn: (input: RecordInput) => {
      const body = {
        subject: {
          kind: input.subject.kind,
          ...(input.subject.metricCode === undefined ? {} : { metric_code: input.subject.metricCode }),
          ...(input.subject.unitId === undefined || input.subject.unitId === '' ? {} : { unit_id: input.subject.unitId }),
          ...(input.subject.source === undefined ? {} : { source: input.subject.source }),
          ...(input.subject.sourceId === undefined ? {} : { source_id: input.subject.sourceId }),
          ...(input.subject.title === undefined ? {} : { title: input.subject.title }),
        },
        kind: input.kind,
        reason: input.reason,
        ...(input.followUpDue === '' ? {} : { follow_up: { due_on: input.followUpDue, ...(input.followUpOwnerId === '' ? {} : { owner_id: input.followUpOwnerId }) } }),
      };
      return client.command('recordAnalyticsDecision', { body, attempt: recordAttempts.current.forPayload(body) });
    },
    onSuccess: async () => {
      recordAttempts.current.done();
      await refresh();
    },
    onError: (error) => recordAttempts.current.ended(error),
  });
  const outcome = useMutation({
    mutationFn: (input: OutcomeInput) => {
      const body = { outcome: input.outcome, note: input.note, ...(input.outcome === 'SUPERSEDED' ? { superseded_by: input.supersededBy } : {}) };
      return client.command('recordAnalyticsDecisionOutcome', { path: { id: input.id }, body, attempt: outcomeAttempts.current.forPayload({ id: input.id, ...body }) });
    },
    onSuccess: async () => {
      outcomeAttempts.current.done();
      await refresh();
    },
    onError: (error) => outcomeAttempts.current.ended(error),
  });
  return { record, outcome };
}
