import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../../api/ApiClientContext';
import { AttemptRegistry } from '../../../api/attempt-registry';
import { useScopeKey } from '../hooks';
import { toComponentRegister, toMilestones } from './model';
import type { ComponentRegister, MilestoneView } from './model';

/** The work breakdown of a project, in the order of the tree. */
export function useComponents(projectId: string | undefined) {
  const client = useApiClient();
  const scope = useScopeKey();
  return useQuery<ComponentRegister>({
    queryKey: [...scope, 'plan', 'components', projectId ?? ''],
    queryFn: async () => toComponentRegister(await client.read('listProjectComponents', { path: { id: projectId ?? '' } })),
    enabled: scope[1] !== undefined && projectId !== undefined,
    retry: false,
  });
}

/** The milestones of a project, by planned day. */
export function useMilestones(projectId: string | undefined) {
  const client = useApiClient();
  const scope = useScopeKey();
  return useQuery<MilestoneView[]>({
    queryKey: [...scope, 'plan', 'milestones', projectId ?? ''],
    queryFn: async () => toMilestones(await client.read('listProjectMilestones', { path: { id: projectId ?? '' } })),
    enabled: scope[1] !== undefined && projectId !== undefined,
    retry: false,
  });
}

type Attempt = ReturnType<AttemptRegistry['forPayload']>;

function useCommand<Input, Result = unknown>(send: (input: Input, attempt: Attempt) => Promise<Result>) {
  const queryClient = useQueryClient();
  const scope = useScopeKey();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: async (input: Input) => send(input, attempts.current.forPayload(input)),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: [...scope, 'plan'] });
    },
    onError: (error) => attempts.current.ended(error),
  });
}

export interface ProjectWrite {
  projectId: string;
  body: Record<string, unknown>;
}

export function useAddComponent() {
  const client = useApiClient();
  return useCommand((input: ProjectWrite, attempt) => client.command('addProjectComponent', { path: { id: input.projectId }, body: input.body as never, attempt }));
}

export function useAddMilestone() {
  const client = useApiClient();
  return useCommand((input: ProjectWrite, attempt) => client.command('addProjectMilestone', { path: { id: input.projectId }, body: input.body as never, attempt }));
}

export interface MilestoneWrite {
  id: string;
  version: number;
  body: Record<string, unknown>;
}

export function useRecordProgress() {
  const client = useApiClient();
  return useCommand((input: MilestoneWrite, attempt) => client.command('recordMilestoneProgress', { path: { id: input.id }, body: input.body as never, ifMatchVersion: input.version, attempt }));
}

export function useSetDependency() {
  const client = useApiClient();
  return useCommand((input: MilestoneWrite, attempt) => client.command('setMilestoneDependency', { path: { id: input.id }, body: input.body as never, ifMatchVersion: input.version, attempt }));
}
