import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../api/ApiClientContext';
import { AttemptRegistry } from '../../api/attempt-registry';
import { useSession } from '../../session/SessionContext';
import { generateBody, toPeriod } from './model';
import type { PeriodMove, PeriodView } from './model';

const root = (tenantId: string | undefined) => ['dis', tenantId] as const;

/**
 * Every period of the tenant, read page by page. The server decides who sees what; the screen picks the year and the status in the browser,
 * because the list answers no filter in its contract and a year has a few dozen periods.
 */
export function usePeriods() {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<PeriodView[]>({
    queryKey: [...root(tenant?.id), 'periods'],
    queryFn: async () => (await client.readAll('get_resources_reporting_period')).flatMap((raw) => toPeriod(raw) ?? []),
    enabled: tenant !== undefined,
    retry: false,
  });
}

function useCommand<Input>(send: (input: Input, attempt: ReturnType<AttemptRegistry['forPayload']>) => Promise<unknown>) {
  const queryClient = useQueryClient();
  const { tenant } = useSession();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: (input: Input) => send(input, attempts.current.forPayload(input)),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: root(tenant?.id) });
    },
    onError: (error) => attempts.current.ended(error),
  });
}

export function useGeneratePeriods() {
  const client = useApiClient();
  return useCommand<{ year: number }>((input, attempt) => client.command('generateReportingPeriods', { body: generateBody(input.year), attempt }));
}

export interface MoveInput {
  move: PeriodMove;
  id: string;
  /** The version of the period the screen showed: the server refuses the move if the period has changed since (If-Match). */
  version: number;
  reason: string;
}

/** Soft closes or locks a period for a stated reason. */
export function usePeriodMove() {
  const client = useApiClient();
  return useCommand<MoveInput>((input, attempt) => {
    const request = { path: { id: input.id }, body: { reason: input.reason }, ifMatchVersion: input.version, attempt };
    return input.move === 'softClose' ? client.command('softCloseReportingPeriod', request) : client.command('lockReportingPeriod', request);
  });
}
