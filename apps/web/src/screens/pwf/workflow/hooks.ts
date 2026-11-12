import { ApiError } from '@machvon/api-client';
import { useInfiniteQuery, useQueries, useQuery } from '@tanstack/react-query';
import { useApiClient } from '../../../api/ApiClientContext';
import { usePwfKey } from '../hooks';
import type { GateAssessment, GateTarget, Schedule, TaskPage, WorkflowDetail } from '../model';
import { taskQuery } from './model';
import type { TaskFilter } from './model';

const notThere = (error: unknown): boolean => error instanceof ApiError && error.status === 404;

/** The workflow of a project; null when the project has none yet (404), so the screen offers to start one instead of failing. */
export function useWorkflow(projectId: string) {
  const client = useApiClient();
  const key = usePwfKey();
  return useQuery<WorkflowDetail | null>({
    queryKey: [...key, 'workflow', projectId],
    queryFn: async () => {
      try {
        return await client.read('getProjectWorkflow', { path: { project_id: projectId } });
      } catch (error) {
        if (notThere(error)) return null;
        throw error;
      }
    },
    enabled: key[1] !== undefined,
    retry: false,
  });
}

/** The current schedule: dates, float, critical path, variance against the first baseline and the calendar versions behind them. */
export function useSchedule(projectId: string, enabled: boolean) {
  const client = useApiClient();
  const key = usePwfKey();
  return useQuery<Schedule>({
    queryKey: [...key, 'schedule', projectId],
    queryFn: () => client.read('getProjectSchedule', { path: { project_id: projectId } }),
    enabled: key[1] !== undefined && enabled,
    retry: false,
  });
}

/** The tasks of the workflow a page after another, for the filter chosen; every page carries the exact total of the filter. */
export function useTaskPages(projectId: string, filter: TaskFilter, enabled: boolean) {
  const client = useApiClient();
  const key = usePwfKey();
  return useInfiniteQuery<TaskPage, Error, { pages: TaskPage[] }, readonly unknown[], string | undefined>({
    queryKey: [...key, 'tasks', projectId, filter],
    initialPageParam: undefined,
    queryFn: ({ pageParam }) => client.read('listProjectTasks', { path: { project_id: projectId }, query: taskQuery(filter, pageParam) }),
    getNextPageParam: (page) => page.next_cursor ?? undefined,
    enabled: key[1] !== undefined && enabled,
    retry: false,
  });
}

/** One assessment for each gate target the workflow declares: whether the command may run and which required tasks still stand in the way. */
export function useGates(projectId: string, targets: readonly GateTarget[]) {
  const client = useApiClient();
  const key = usePwfKey();
  return useQueries({
    queries: targets.map((target) => ({
      queryKey: [...key, 'gate', projectId, target],
      queryFn: (): Promise<GateAssessment> => client.read('evaluateProjectGate', { path: { project_id: projectId, target } }),
      enabled: key[1] !== undefined,
      retry: false,
    })),
  });
}
