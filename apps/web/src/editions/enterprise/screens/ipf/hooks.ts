import { useQuery } from '@tanstack/react-query';
import { useApiClient } from '../../../../api/ApiClientContext';
import { useSession } from '../../../../session/SessionContext';
import { toProfile } from './model';
import type { Profile } from './model';

// What the profile shows depends on the places the signed-in membership reaches, not only on the tenant: the membership is part of every key.
function useScopeKey(): readonly ['ipf', string | undefined, string | undefined] {
  const { tenant } = useSession();
  return ['ipf', tenant?.id, tenant?.membershipId];
}

export interface ProjectOption {
  id: string;
  code: string;
  name: string;
}

/** The projects the caller may read, for the choice of the project whose profile is shown. */
export function useProjectOptions() {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<ProjectOption[]>({
    queryKey: [...key, 'projects'],
    queryFn: async () =>
      (await client.readAll('get_resources_project')).flatMap((raw): ProjectOption[] => {
        const row = raw as { id?: unknown; code?: unknown; name?: unknown };
        return typeof row.id === 'string' && typeof row.code === 'string' ? [{ id: row.id, code: row.code, name: typeof row.name === 'string' ? row.name : row.code }] : [];
      }),
    enabled: key[1] !== undefined,
    retry: false,
  });
}

/** The investment profile of one project in one plan year (the year of today when none is named). */
export function useInvestmentProfile(projectId: string | undefined, planYear: number | undefined) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<Profile>({
    queryKey: [...key, 'profile', projectId ?? '', planYear ?? 'current'],
    queryFn: async () =>
      toProfile(await client.read('getProjectInvestmentProfile', { path: { id: projectId as string }, ...(planYear === undefined ? {} : { query: { plan_year: planYear } as never }) })),
    enabled: key[1] !== undefined && projectId !== undefined,
    retry: false,
  });
}
