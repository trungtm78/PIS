import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../../api/ApiClientContext';
import { AttemptRegistry } from '../../../api/attempt-registry';
import { useSession } from '../../../session/SessionContext';
import { toForecast } from '../../dis/forecast/model';
import type { Forecast } from '../../dis/forecast/model';
import { toScheduleLine } from './model';
import type { ScheduleLine, forecastBody } from './model';

// Every key starts with the root the registration of CAP-08 refreshes, so a registration made on either screen reaches both.
const root = (tenantId: string | undefined, membershipId: string | undefined) => ['cap', tenantId, membershipId, 'forecast'] as const;

/** The monthly registrations and estimates in force for a project in a year, with what the Treasury paid against each registration. */
export function useScheduleLines(projectId: string | undefined, year: number | undefined, enabled: boolean) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<ScheduleLine[]>({
    queryKey: [...root(tenant?.id, tenant?.membershipId), 'lines', projectId, year],
    queryFn: async () =>
      (await client.readAll('listDisbursementSchedules', { query: { project_id: projectId as string, plan_year: year as number, granularity: 'MONTH' } })).flatMap((raw) => toScheduleLine(raw) ?? []),
    enabled: enabled && tenant?.id !== undefined && projectId !== undefined && year !== undefined,
    retry: false,
  });
}

/** The year-end estimate of one project over the latest frozen snapshot, as DIS works it out from the estimates in force; null when DIS has none to give. */
export function useProjectEstimate(projectId: string | undefined, enabled: boolean) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<Forecast | null>({
    queryKey: [...root(tenant?.id, tenant?.membershipId), 'estimate', projectId],
    queryFn: async () => toForecast(await client.read('getDisbursementForecast', { query: { project_id: projectId as string } })) ?? null,
    enabled: enabled && tenant?.id !== undefined && projectId !== undefined,
    retry: false,
  });
}

/** The entry of an estimate: one idempotency attempt per intention, the cached reads of the capital and of the estimate refreshed on success. */
export function useRegisterForecast() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const { tenant } = useSession();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: (body: ReturnType<typeof forecastBody>) => client.command('registerDisbursementSchedule', { body, attempt: attempts.current.forPayload(body) }),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: ['cap', tenant?.id, tenant?.membershipId] });
    },
    onError: (error) => attempts.current.ended(error),
  });
}
