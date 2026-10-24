import { useQuery } from '@tanstack/react-query';
import { useApiClient } from '../../api/ApiClientContext';
import { toAssignmentLine, toTaskForceLine } from './accountability-model';
import type { AssignmentLine, Option, TaskForceLine } from './accountability-model';
import { useScopeKey } from './hooks';

/** The assignments of the projects the caller may read (PRJ-17), the latest period of a project first. */
export function useAssignments() {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<AssignmentLine[]>({
    queryKey: [...key, 'assignments'],
    queryFn: async () => (await client.readAll('get_resources_project_accountability')).flatMap((raw) => toAssignmentLine(raw) ?? []),
    enabled: key[1] !== undefined,
    retry: false,
  });
}

/** The task forces whose scope unit lies in a subtree the caller may read, each with its terms (PRJ-18). */
export function useTaskForces() {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<TaskForceLine[]>({
    queryKey: [...key, 'task-forces'],
    queryFn: async () => (await client.readAll('get_resources_task_force')).flatMap((raw) => toTaskForceLine(raw) ?? []),
    enabled: key[1] !== undefined,
    retry: false,
  });
}

/** The active staff of the tenant that can be chosen as a leader or a member; `enabled: false` when the caller may not list members. */
export function useMemberOptions(enabled: boolean) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<Option[]>({
    queryKey: [...key, 'member-options'],
    queryFn: async () =>
      (await client.readAll('get_resources_membership')).flatMap((raw) => {
        const row = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
        if (typeof row.id !== 'string' || typeof row.display_name !== 'string' || row.status !== 'Active') return [];
        if (row.membership_type !== undefined && row.membership_type !== 'STAFF') return [];
        return [{ id: row.id, label: row.display_name }];
      }),
    enabled: enabled && key[1] !== undefined,
    retry: false,
  });
}
