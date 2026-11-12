import { useQuery } from '@tanstack/react-query';
import { useApiClient } from '../../../api/ApiClientContext';
import { usePwfCommand, usePwfKey } from '../hooks';
import type { AssignmentPage } from '../model';
import type { AssignmentInput } from './model';

/** The ledger of one task: who is assigned in which role, over which days and with which share. */
export function useAssignments(taskId: string | null) {
  const client = useApiClient();
  const key = usePwfKey();
  return useQuery<AssignmentPage>({
    queryKey: [...key, 'assignments', taskId ?? ''],
    queryFn: () => client.read('listProjectTaskAssignments', { path: { task_id: taskId ?? '' } }),
    enabled: key[1] !== undefined && taskId !== null,
    retry: false,
  });
}

export interface AssignInput {
  taskId: string;
  body: AssignmentInput;
}

export function useAssign() {
  const client = useApiClient();
  return usePwfCommand<AssignInput>((input, attempt) => client.command('assignProjectTask', { path: { task_id: input.taskId }, body: input.body, attempt }));
}
