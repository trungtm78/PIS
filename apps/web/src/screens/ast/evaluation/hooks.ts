import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../../api/ApiClientContext';
import { AttemptRegistry } from '../../../api/attempt-registry';
import { useSession } from '../../../session/SessionContext';
import { toHandoverList } from '../handover/model';
import { acceptedHandovers, toTrigger } from './model';
import type { AcceptedHandover, TriggerLine } from './model';

// What the screen shows depends on what the signed-in membership may see, not only on the tenant: the membership is part of every key.
function useScopeKey(): readonly ['ast-evaluation', string | undefined, string | undefined] {
  const { tenant } = useSession();
  return ['ast-evaluation', tenant?.id, tenant?.membershipId];
}

/** The triggers of a project in the scope of the caller, newest first. */
export function useTriggers(projectId: string | undefined, enabled: boolean) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<TriggerLine[]>({
    queryKey: [...key, 'triggers', projectId ?? ''],
    queryFn: async () => (await client.readAll('listEvaluationTriggers', { query: { project_id: projectId ?? '' } })).flatMap((raw) => toTrigger(raw) ?? []),
    enabled: enabled && key[1] !== undefined && projectId !== undefined,
    retry: false,
  });
}

/** The accepted handovers of a project: what a trigger after a handover follows. Every page of the handovers is read before the project's are picked out. Read only for someone who may set a trigger. */
export function useAcceptedHandovers(projectId: string | undefined, enabled: boolean) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<AcceptedHandover[]>({
    queryKey: [...key, 'handovers', projectId ?? ''],
    queryFn: async () => acceptedHandovers(toHandoverList({ items: await client.readAll('get_resources_handover') }), projectId ?? ''),
    enabled: enabled && key[1] !== undefined && projectId !== undefined,
    retry: false,
  });
}

/** One mutation hook: one idempotency attempt per intention, the triggers read again once it succeeds. */
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
    onError: async (error) => {
      attempts.current.ended(error);
      // A refusal can follow a change made by someone else (a trigger fired or acknowledged meanwhile): the list is read again.
      await queryClient.invalidateQueries({ queryKey: key });
    },
  });
}

export interface ScheduleInput {
  projectId: string;
  body: Record<string, unknown>;
}

export function useSchedule() {
  const client = useApiClient();
  return useCommand<ScheduleInput>((input, attempt) => client.command('scheduleEvaluationTrigger', { path: { id: input.projectId }, body: input.body as never, attempt }));
}

export interface AcknowledgeInput {
  triggerId: string;
  evaluationId: string;
}

export function useAcknowledge() {
  const client = useApiClient();
  return useCommand<AcknowledgeInput>((input, attempt) =>
    client.command('acknowledgeEvaluationTrigger', { path: { id: input.triggerId }, body: { mne_evaluation_id: input.evaluationId } as never, attempt }),
  );
}
