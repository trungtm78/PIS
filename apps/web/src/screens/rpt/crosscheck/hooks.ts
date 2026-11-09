import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../../api/ApiClientContext';
import { AttemptRegistry } from '../../../api/attempt-registry';
import { useSession } from '../../../session/SessionContext';
import type { Crosscheck, PeriodChoice } from './model';

// The answer depends on the membership as well as the tenant (the right is over the whole tenant): both are part of every key.
function useScopeKey(): readonly ['rpt', string | undefined, string | undefined] {
  const { tenant } = useSession();
  return ['rpt', tenant?.id, tenant?.membershipId];
}

const q = (value: Record<string, string | number | boolean | undefined>): never => value as never;

/** The comparison of the reports of a period; with a draft it also says what stops that draft. It is computed at the moment of the read, so it is never out of date. */
export function useCrosscheck(period: PeriodChoice, draftId: string | undefined) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<Crosscheck>({
    queryKey: [...key, 'crosscheck', period.kind, period.year, period.index, draftId ?? ''],
    queryFn: () => client.read('getReportCrosscheck', { query: q({ kind: period.kind, year: period.year, index: period.index, ...(draftId === undefined ? {} : { draft_id: draftId }) }) }) as Promise<Crosscheck>,
    enabled: key[1] !== undefined,
    retry: false,
  });
}

export interface ExplainInput {
  period: PeriodChoice;
  fingerprint: string;
  reason: string;
}

/** Records the explanation of one difference; one attempt per intention, so a retry of the same request keeps its key. */
export function useExplain() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const key = useScopeKey();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: (input: ExplainInput) =>
      client.command('explainCrosscheckFinding', { body: { period: { kind: input.period.kind, year: input.period.year, index: input.period.index }, fingerprint: input.fingerprint, reason: input.reason } as never, attempt: attempts.current.forPayload(input) }),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: key });
    },
    onError: (error) => attempts.current.ended(error),
  });
}
