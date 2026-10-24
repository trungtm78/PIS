import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../api/ApiClientContext';
import { AttemptRegistry } from '../../api/attempt-registry';
import { useSession } from '../../session/SessionContext';
import { toMasterOption, toProjectLine, toProjectView, toUnitOption } from './model';
import type { CreateBody, MasterOption, ProfileBody, ProjectLine, ProjectView, UnitOption } from './model';

// What the register shows depends on the scope of the membership that is signed in, not only on the tenant: switching between two
// memberships of one tenant keeps the query client, so the membership is part of every key.
export function useScopeKey(): readonly ['prj', string | undefined, string | undefined] {
  const { tenant } = useSession();
  return ['prj', tenant?.id, tenant?.membershipId];
}

/** The register in the scope of the caller, in the order of the read (by internal code). */
export function useProjects() {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<ProjectLine[]>({
    queryKey: [...key, 'projects'],
    queryFn: async () => (await client.readAll('get_resources_project')).flatMap((raw) => toProjectLine(raw) ?? []),
    enabled: key[1] !== undefined,
    retry: false,
  });
}

/** One project with its workspace data; null when none is named. */
export function useProject(projectId: string | null | undefined) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<ProjectView | null>({
    queryKey: [...key, 'project', projectId ?? ''],
    queryFn: async () => toProjectView(await client.read('get_resources_project_id', { path: { id: projectId ?? '' } })) ?? null,
    enabled: key[1] !== undefined && typeof projectId === 'string',
    retry: false,
  });
}

/** The units the caller may read: the form offers them as owner, investor and deciding authority. */
export function useUnits(enabled = true) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<UnitOption[]>({
    queryKey: [...key, 'units'],
    queryFn: async () => (await client.readAll('get_resources_organization_unit')).flatMap(toUnitOption),
    enabled: enabled && key[1] !== undefined,
    retry: false,
  });
}

/** The entries in force of some master types, by the id of the version a project stores. */
export function useMasterOptions(masterTypes: readonly string[], enabled = true) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<MasterOption[]>({
    queryKey: [...key, 'master', ...masterTypes],
    queryFn: async () => {
      const lists = await Promise.all(masterTypes.map((masterType) => client.readAll('searchMasterRecords', { query: { master_type: masterType } })));
      return lists.flat().flatMap(toMasterOption);
    },
    enabled: enabled && key[1] !== undefined,
    retry: false,
  });
}

/** One mutation hook: one idempotency attempt per intention, the cached reads of the register refreshed on success. */
function useCommand<Input>(send: (input: Input, attempt: ReturnType<AttemptRegistry['forPayload']>) => Promise<{ resource_id?: string; resource_version?: number }>) {
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

export function useCreateProject() {
  const client = useApiClient();
  return useCommand<CreateBody>((body, attempt) => client.command('createProject', { body, attempt }));
}

export interface UpdateProfileInput {
  id: string;
  version: number;
  body: ProfileBody;
}

export function useUpdateProfile() {
  const client = useApiClient();
  return useCommand<UpdateProfileInput>((input, attempt) => client.command('updateProjectProfile', { path: { id: input.id }, body: input.body, ifMatchVersion: input.version, attempt }));
}
