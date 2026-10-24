import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../api/ApiClientContext';
import { AttemptRegistry } from '../../api/attempt-registry';
import { useScopeKey } from './hooks';
import type { assignBody, endBody, memberBody, taskForceBody } from './accountability-model';

type Attempt = ReturnType<AttemptRegistry['forPayload']>;

/** One command of PRJ-17 or PRJ-18: one idempotency attempt per intention, every cached read of the register and of the board refreshed on success. */
function useAccountabilityCommand<Input>(send: (input: Input, attempt: Attempt) => Promise<unknown>) {
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

export interface AssignLeaderInput {
  projectId: string;
  body: ReturnType<typeof assignBody>;
}

export function useAssignLeader() {
  const client = useApiClient();
  return useAccountabilityCommand((input: AssignLeaderInput, attempt) => client.command('assignProjectLeader', { path: { id: input.projectId }, body: input.body, attempt }));
}

export interface EndAssignmentInput {
  id: string;
  version: number;
  body: ReturnType<typeof endBody>;
}

export function useEndAssignment() {
  const client = useApiClient();
  return useAccountabilityCommand((input: EndAssignmentInput, attempt) => client.command('endProjectLeaderAssignment', { path: { id: input.id }, body: input.body, ifMatchVersion: input.version, attempt }));
}

export function useCreateTaskForce() {
  const client = useApiClient();
  return useAccountabilityCommand((input: ReturnType<typeof taskForceBody>, attempt) => client.command('createTaskForce', { body: input, attempt }));
}

export interface AddMemberInput {
  id: string;
  body: ReturnType<typeof memberBody>;
}

export function useAddTaskForceMember() {
  const client = useApiClient();
  return useAccountabilityCommand((input: AddMemberInput, attempt) => client.command('addTaskForceMember', { path: { id: input.id }, body: input.body, attempt }));
}

export interface DissolveInput {
  id: string;
  version: number;
  reason: string;
}

export function useDissolveTaskForce() {
  const client = useApiClient();
  return useAccountabilityCommand((input: DissolveInput, attempt) => client.command('dissolveTaskForce', { path: { id: input.id }, body: { reason: input.reason }, ifMatchVersion: input.version, attempt }));
}
