import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../api/ApiClientContext';
import { AttemptRegistry } from '../../api/attempt-registry';
import { useSession } from '../../session/SessionContext';
import { toScheduleItem } from './schedule-model';
import type { ScheduleItem, registrationBody } from './schedule-model';

/** The current monthly registrations of a project in a year, with the Treasury's payments of each month. */
export function useSchedules(projectId: string | undefined, year: number | undefined) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<ScheduleItem[]>({
    queryKey: ['cap', tenant?.id, tenant?.membershipId, 'schedules', projectId, year],
    queryFn: async () =>
      (await client.readAll('listDisbursementSchedules', { query: { project_id: projectId as string, plan_year: year as number, kind: 'REGISTERED', granularity: 'MONTH' } })).flatMap(
        (raw) => toScheduleItem(raw) ?? [],
      ),
    enabled: tenant?.id !== undefined && projectId !== undefined && year !== undefined,
    retry: false,
  });
}

/** The registration of a month: one idempotency attempt per intention, the cached reads of the capital refreshed on success. */
export function useRegisterSchedule() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const { tenant } = useSession();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: (body: ReturnType<typeof registrationBody>) => client.command('registerDisbursementSchedule', { body, attempt: attempts.current.forPayload(body) }),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: ['cap', tenant?.id, tenant?.membershipId] });
    },
    onError: (error) => attempts.current.ended(error),
  });
}
