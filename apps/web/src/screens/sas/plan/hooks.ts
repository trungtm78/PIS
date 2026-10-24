import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../../api/ApiClientContext';
import { AttemptRegistry } from '../../../api/attempt-registry';
import { useSession } from '../../../session/SessionContext';
import { toPlan } from './model';
import type { PlanRow } from './model';

// The catalogue is read for the control-plane member that is signed in: switching between two memberships keeps the query client,
// so the membership is part of every key.
function useScopeKey(): readonly ['sas-plans', string | undefined, string | undefined] {
  const { tenant } = useSession();
  return ['sas-plans', tenant?.id, tenant?.membershipId];
}

/** Every plan version, by plan code and newest revision first, with its features. */
export function usePlans(enabled: boolean) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<PlanRow[]>({
    queryKey: [...key, 'list'],
    queryFn: async () => (await client.readAll('listPlanVersions')).flatMap((raw) => toPlan(raw) ?? []),
    enabled: enabled && key[1] !== undefined,
    retry: false,
  });
}

function useCommand<Input>(send: (input: Input, attempt: ReturnType<AttemptRegistry['forPayload']>) => Promise<unknown>) {
  const queryClient = useQueryClient();
  const key = useScopeKey();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: (input: Input) => send(input, attempts.current.forPayload(input)),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: key });
    },
    onError: (error) => attempts.current.ended(error),
  });
}

export function useCreatePlan() {
  const client = useApiClient();
  return useCommand<Record<string, unknown>>((body, attempt) => client.command('createPlanVersion', { body: body as never, attempt }));
}

export interface PublishInput {
  id: string;
  version: number;
  reason: string;
}

export function usePublishPlan() {
  const client = useApiClient();
  return useCommand<PublishInput>((input, attempt) => client.command('publishPlanVersion', { path: { planVersionId: input.id }, body: { reason: input.reason } as never, ifMatchVersion: input.version, attempt }));
}
