import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../api/ApiClientContext';
import { AttemptRegistry } from '../../api/attempt-registry';
import { useSession } from '../../session/SessionContext';
import { toPlanAsOf } from './revision-model';
import type { PlanAsOf } from './revision-model';

/** The plan a revision is made from and the version of it the person saw: the command is refused if the plan changed since. */
export interface ReviseInput {
  planId: string;
  version: number;
  reason: string;
}

/** The revision of a published plan: one idempotency attempt per intention, the cached reads of the capital refreshed on success. */
export function useCreateRevision() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const { tenant } = useSession();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: (input: ReviseInput) =>
      client.command('createCapitalPlanRevision', { path: { id: input.planId }, body: { reason: input.reason }, ifMatchVersion: input.version, attempt: attempts.current.forPayload(input) }),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: ['cap', tenant?.id, tenant?.membershipId] });
    },
    onError: (error) => attempts.current.ended(error),
  });
}

/** The plan as it stood on a day (the plan as it stands now when `at` is undefined), in the scope of the caller. */
export function usePlanAsOf(planId: string | undefined, at: string | undefined) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<PlanAsOf | undefined>({
    queryKey: ['cap', tenant?.id, tenant?.membershipId, 'plan-as-of', planId, at ?? 'now'],
    queryFn: async () => toPlanAsOf(await client.read('getCapitalPlanAsOf', { path: { id: planId as string }, query: at === undefined ? {} : { at } })),
    enabled: tenant?.id !== undefined && planId !== undefined,
    retry: false,
  });
}
