import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import type { components } from '@machvon/contracts';
import { useApiClient } from '../../../../api/ApiClientContext';
import { AttemptRegistry } from '../../../../api/attempt-registry';
import { useSession } from '../../../../session/SessionContext';

export type MailSchedulePage = components['schemas']['RptMailSchedulePage'];
export type MailSchedule = components['schemas']['RptMailSchedule'];
export type MailingPage = components['schemas']['RptMailingPage'];
export type Mailing = components['schemas']['RptMailing'];
export type MailScheduleCreate = components['schemas']['RptMailScheduleCreate'];

function useScopeKey(): readonly ['rml', string | undefined, string | undefined] {
  const { tenant } = useSession();
  return ['rml', tenant?.id, tenant?.membershipId];
}

const q = (value: Record<string, string | number | undefined>): never => value as never;

export function useMailSchedules() {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<MailSchedulePage>({
    queryKey: [...key, 'schedules'],
    queryFn: async () => (await client.read('listReportMailSchedules', { query: q({ limit: 100 }) })) as MailSchedulePage,
    enabled: key[1] !== undefined,
    retry: false,
  });
}

export function useMailings(scheduleId: string | undefined) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<MailingPage>({
    queryKey: [...key, 'mailings', scheduleId ?? 'all'],
    queryFn: async () => (await client.read('listReportMailings', { query: q({ limit: 100, ...(scheduleId === undefined ? {} : { schedule_id: scheduleId }) }) })) as MailingPage,
    enabled: key[1] !== undefined,
    retry: false,
  });
}

function useMailCommand<Input>(send: (input: Input, attempt: ReturnType<AttemptRegistry['forPayload']>) => Promise<unknown>) {
  const queryClient = useQueryClient();
  const attempts = useRef(new AttemptRegistry());
  return useMutation<unknown, unknown, Input>({
    mutationFn: (input) => send(input, attempts.current.forPayload(input)),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ predicate: (query) => query.queryKey[0] === 'rml' });
    },
    onError: (error) => attempts.current.ended(error),
  });
}

export function useCreateMailSchedule() {
  const client = useApiClient();
  return useMailCommand<MailScheduleCreate>((body, attempt) => client.command('createReportMailSchedule', { body, attempt }));
}

export function useRetireMailSchedule() {
  const client = useApiClient();
  return useMailCommand<{ id: string; version: number; reason: string }>((input, attempt) => client.command('retireReportMailSchedule', { path: { id: input.id }, body: { reason: input.reason }, ifMatchVersion: input.version, attempt }));
}
