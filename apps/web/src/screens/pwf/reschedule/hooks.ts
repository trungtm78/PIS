import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../../api/ApiClientContext';
import { AttemptRegistry } from '../../../api/attempt-registry';
import { usePwfCommand, usePwfKey } from '../hooks';
import type { VersionedInput } from '../hooks';
import type { ReschedulePreview, Schedule, WorkflowDetail } from '../model';
import type { DecisionBody, RescheduleBody } from './model';

/** The workflow of a project: its schedule version is the `If-Match` of a proposal. */
export function useWorkflow(projectId: string | undefined) {
  const client = useApiClient();
  const key = usePwfKey();
  return useQuery<WorkflowDetail>({
    queryKey: [...key, 'workflow', projectId ?? ''],
    queryFn: () => client.read('getProjectWorkflow', { path: { project_id: projectId ?? '' } }),
    enabled: key[1] !== undefined && projectId !== undefined,
    retry: false,
  });
}

/** The schedule in force: the "before" of every proposal, with the variance against the first baseline. */
export function useSchedule(projectId: string | undefined) {
  const client = useApiClient();
  const key = usePwfKey();
  return useQuery<Schedule>({
    queryKey: [...key, 'schedule', projectId ?? ''],
    queryFn: () => client.read('getProjectSchedule', { path: { project_id: projectId ?? '' } }),
    enabled: key[1] !== undefined && projectId !== undefined,
    retry: false,
  });
}

/** The stored proposal named in the address (a second person opens it from a link): its preview, reason and status, read from the server so that nobody decides on what they cannot see. */
export function useProposal(id: string | undefined) {
  const client = useApiClient();
  const key = usePwfKey();
  return useQuery<ReschedulePreview>({
    queryKey: [...key, 'proposal', id ?? ''],
    queryFn: () => client.read('getProjectReschedule', { path: { id: id ?? '' } }),
    enabled: key[1] !== undefined && id !== undefined,
    retry: false,
  });
}

/** Proposes a reschedule: the server answers with the preview it computed and stored. One idempotency attempt per intention; what the module reads is read again on success. */
export function usePropose(projectId: string) {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const key = usePwfKey();
  const attempts = useRef(new AttemptRegistry());
  return useMutation<ReschedulePreview, Error, VersionedInput<RescheduleBody>>({
    mutationFn: (input) => client.command('proposeProjectReschedule', { path: { project_id: projectId }, body: input.body, ifMatchVersion: input.version, attempt: attempts.current.forPayload(input) }),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: key });
    },
    onError: (error) => attempts.current.ended(error),
  });
}

/** Decides a proposal (approve publishes a new schedule version; reject keeps the schedule). */
export function useDecide() {
  const client = useApiClient();
  return usePwfCommand<VersionedInput<DecisionBody>>((input, attempt) => client.command('decideProjectReschedule', { path: { id: input.id }, body: input.body, ifMatchVersion: input.version, attempt }));
}
