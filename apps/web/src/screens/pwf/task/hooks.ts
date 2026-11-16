import { useQuery } from '@tanstack/react-query';
import type { components } from '@machvon/contracts';
import { useApiClient } from '../../../api/ApiClientContext';
import { usePwfCommand, usePwfKey } from '../hooks';
import type { VersionedInput } from '../hooks';
import type { TaskDetail } from '../model';
import type { KpiResultPage } from './model';

type Schemas = components['schemas'];

/** One task with its checklist, evidence, exceptions, ledger, history and what the caller may do next. */
export function useTask(taskId: string | null) {
  const client = useApiClient();
  const key = usePwfKey();
  return useQuery<TaskDetail>({
    queryKey: [...key, 'task', taskId ?? ''],
    queryFn: () => client.read('getProjectTask', { path: { task_id: taskId ?? '' } }),
    enabled: key[1] !== undefined && taskId !== null,
    retry: false,
  });
}

/** How many results of the KPI of a task one read asks for: a set holds at most twenty KPIs, and the corrections of one are few. */
export const KPI_RESULTS_LIMIT = 100;

/**
 * The results of the KPI of one task, from the read that owns them (`listTaskKpiResults`): the detail of a task does not carry them, so the tab asks when it is opened. A 403 is "may not see", an empty page is "no
 * result yet"; the two are never the same answer.
 */
export function useTaskKpiResults(taskId: string, enabled: boolean) {
  const client = useApiClient();
  const key = usePwfKey();
  return useQuery<KpiResultPage>({
    queryKey: [...key, 'task-kpi', taskId],
    queryFn: () => client.read('listTaskKpiResults', { path: { task_id: taskId }, query: { limit: KPI_RESULTS_LIMIT } }),
    enabled: enabled && key[1] !== undefined,
    retry: false,
  });
}

export function useStartTask() {
  const client = useApiClient();
  return usePwfCommand<VersionedInput<Schemas['PwfTaskStart']>>((input, attempt) => client.command('startProjectTask', { path: { task_id: input.id }, body: input.body, ifMatchVersion: input.version, attempt }));
}

export function useCompleteTask() {
  const client = useApiClient();
  return usePwfCommand<VersionedInput<Schemas['PwfTaskComplete']>>((input, attempt) => client.command('completeProjectTask', { path: { task_id: input.id }, body: input.body, ifMatchVersion: input.version, attempt }));
}

export function useApproveTask() {
  const client = useApiClient();
  return usePwfCommand<VersionedInput<Schemas['PwfDecisionInput']>>((input, attempt) => client.command('approveProjectTaskCompletion', { path: { task_id: input.id }, body: input.body, ifMatchVersion: input.version, attempt }));
}

export function useReturnTask() {
  const client = useApiClient();
  return usePwfCommand<VersionedInput<Schemas['PwfReturnInput']>>((input, attempt) => client.command('returnProjectTask', { path: { task_id: input.id }, body: input.body, ifMatchVersion: input.version, attempt }));
}

/** "Nhận việc" (R71): the person who belongs to the receiving unit and holds the role takes the task; one transaction on the server, never an overwrite. */
export function useClaimTask() {
  const client = useApiClient();
  return usePwfCommand<{ id: string; body?: Schemas['PwfTaskClaim'] }>((input, attempt) => client.command('claimProjectTask', { path: { task_id: input.id }, body: input.body ?? {}, attempt }));
}

export function useResumeTask() {
  const client = useApiClient();
  return usePwfCommand<{ id: string; version: number }>((input, attempt) => client.command('resumeProjectTask', { path: { task_id: input.id }, ifMatchVersion: input.version, attempt }));
}

export function useCompleteChecklistItem() {
  const client = useApiClient();
  return usePwfCommand<VersionedInput<Schemas['PwfChecklistComplete']> & { itemCode: string }>((input, attempt) =>
    client.command('completeProjectTaskChecklistItem', { path: { task_id: input.id, item_code: input.itemCode }, body: input.body, ifMatchVersion: input.version, attempt }),
  );
}

export function useAttachEvidence() {
  const client = useApiClient();
  return usePwfCommand<{ taskId: string; body: Schemas['PwfEvidenceInput'] }>((input, attempt) => client.command('attachProjectTaskEvidence', { path: { task_id: input.taskId }, body: input.body, attempt }));
}

export function useRequestException() {
  const client = useApiClient();
  return usePwfCommand<{ taskId: string; body: Schemas['PwfExceptionRequest'] }>((input, attempt) => client.command('requestProjectTaskException', { path: { task_id: input.taskId }, body: input.body, attempt }));
}

export function useDecideException() {
  const client = useApiClient();
  return usePwfCommand<VersionedInput<Schemas['PwfDecisionInput']>>((input, attempt) => client.command('decideProjectTaskException', { path: { id: input.id }, body: input.body, ifMatchVersion: input.version, attempt }));
}
