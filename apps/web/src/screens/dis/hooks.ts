import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useApiClient } from '../../api/ApiClientContext';
import { AttemptRegistry } from '../../api/attempt-registry';
import { useSession } from '../../session/SessionContext';
import { decisionBody, generateBody, reopenBody, toPeriod, toProjectOption } from './model';
import type { GeneratedPeriodType } from './model';
import type { DecisionForm, PeriodMove, PeriodView, ProjectOption, ReopenForm } from './model';

const root = (tenantId: string | undefined) => ['dis', tenantId] as const;

const CLOCK_MS = 60_000;

/** The current time, moved on every minute so that a deadline or the end of a reopening window is seen while the screen stays open. */
export function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), CLOCK_MS);
    return () => clearInterval(timer);
  }, []);
  return now;
}

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
  return useCommand<{ year: number; periodType?: GeneratedPeriodType }>((input, attempt) => client.command('generateReportingPeriods', { body: generateBody(input.year, input.periodType), attempt }));
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

/** The projects the requester can name (the register answers only what the caller may see); read only while the request form is open. */
export function useReopenProjects(enabled: boolean) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<ProjectOption[]>({
    queryKey: [...root(tenant?.id), 'projects'],
    queryFn: async () => (await client.readAll('get_resources_project')).flatMap((raw) => toProjectOption(raw) ?? []),
    enabled: enabled && tenant !== undefined,
    retry: false,
  });
}

export interface RequestInput {
  periodId: string;
  form: ReopenForm;
}

/** Asks for a locked period to be reopened for a scope, with a reason and a window. */
export function useRequestReopen() {
  const client = useApiClient();
  return useCommand<RequestInput>((input, attempt) => client.command('requestPeriodReopen', { path: { id: input.periodId }, body: reopenBody(input.form), attempt }));
}

export interface DecideInput {
  id: string;
  /** The version of the request the screen showed: the server refuses the decision if it has changed since (If-Match). */
  version: number;
  form: DecisionForm;
}

/** Approves a request for the hours given, or rejects it, for a stated reason. */
export function useDecideReopen() {
  const client = useApiClient();
  return useCommand<DecideInput>((input, attempt) => client.command('decidePeriodReopen', { path: { id: input.id }, body: decisionBody(input.form), ifMatchVersion: input.version, attempt }));
}
