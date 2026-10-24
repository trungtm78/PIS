import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../../api/ApiClientContext';
import { AttemptRegistry } from '../../../api/attempt-registry';
import { useSession } from '../../../session/SessionContext';
import { toCalendar } from './model';
import type { CalendarView, calendarBody } from './model';

/** The queries that show calendar versions begin with this key: a command refreshes all of them. */
const calendarsKey = (tenantId: string | undefined) => ['adm', 'work-calendars', tenantId] as const;

/** Every version of every calendar of the tenant, keyed by tenant so a tenant switch never shows another tenant's calendars. */
export function useWorkCalendars() {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<CalendarView[]>({
    queryKey: calendarsKey(tenant?.id),
    queryFn: async () => (await client.readAll('get_resources_work_calendar_version')).flatMap((raw) => toCalendar(raw) ?? []),
    enabled: tenant !== undefined,
    retry: false,
  });
}

/** Writes the next draft revision of a calendar year; one idempotency attempt per intention. */
export function useCreateCalendarDraft() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const { tenant } = useSession();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: (body: ReturnType<typeof calendarBody>) => client.command('createWorkCalendarVersion', { body, attempt: attempts.current.forPayload(body) }),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: calendarsKey(tenant?.id) });
    },
    onError: (error) => attempts.current.ended(error),
  });
}

export interface PublishInput {
  id: string;
  version: number;
  reason: string;
}

/** Publishes a draft (versioned: a stale version is a 409). */
export function usePublishCalendar() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const { tenant } = useSession();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: (input: PublishInput) =>
      client.command('publishWorkCalendar', {
        path: { calendarId: input.id },
        body: { reason: input.reason },
        ifMatchVersion: input.version,
        attempt: attempts.current.forPayload(input),
      }),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: calendarsKey(tenant?.id) });
    },
    onError: (error) => attempts.current.ended(error),
  });
}
