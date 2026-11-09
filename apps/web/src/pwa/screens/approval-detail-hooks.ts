import { ApiError, NETWORK_ERROR_CODE } from '@machvon/api-client';
import type { ApiClient } from '@machvon/api-client';
import { useQueries, useQuery } from '@tanstack/react-query';
import { useApiClient } from '../../api/ApiClientContext';
import { useSession } from '../../session/SessionContext';
import { queueKey } from './approval-hooks';
import { REPORT_ACCEPT, stepHistory, toReportFigures } from './approval-detail-model';
import type { ReportFigures, StepEntry } from './approval-detail-model';
import { toTaskRecord } from './approval-model';
import type { ApprovalTask } from './approval-model';

/**
 * The record of one task. It sits under the key of the queue, so a decision (which invalidates the queue) reads it again, and a switch of member starts it over.
 * A task that is not there for the reader is the failure of the read (404), which the screen says in words.
 */
export function useTaskDetail(taskId: string, enabled: boolean) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<ApprovalTask | null>({
    queryKey: [...queueKey(tenant?.id, tenant?.membershipId), 'task', taskId],
    queryFn: async () => toTaskRecord(await client.read('get_resources_approval_task_id' as never, { path: { id: taskId } } as never)) ?? null,
    enabled: enabled && tenant !== undefined && taskId !== '',
    retry: false,
  });
}

/** Why a part of the detail is not shown: the reader may not read it, it is not there, or the answer is not what the contract promises. */
export type Unavailable = 'denied' | 'notFound' | 'unreadable';

export type ReportRead = { kind: 'ready'; figures: ReportFigures } | { kind: 'unavailable'; reason: Unavailable };

/**
 * A report revision. Like MOB-24, a refusal leaves the part out (the report is a separate right from the task) and a lost connection fails the read,
 * so a copy is never mistaken for the figures. A revision never changes, so it is kept for the life of the page.
 */
export function useReportRevision(reportId: string | null, enabled = true) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<ReportRead>({
    queryKey: ['pwa', 'report', tenant?.id, tenant?.membershipId, reportId ?? ''],
    queryFn: () => readReport(client, reportId ?? ''),
    enabled: enabled && tenant !== undefined && reportId !== null && reportId !== '',
    retry: false,
    staleTime: Infinity,
  });
}

async function readReport(client: ApiClient, id: string): Promise<ReportRead> {
  try {
    const figures = toReportFigures(await client.read('getReportRevision', { path: { id } } as never));
    return figures === undefined ? { kind: 'unavailable', reason: 'unreadable' } : { kind: 'ready', figures };
  } catch (error) {
    if (error instanceof ApiError && error.code !== NETWORK_ERROR_CODE) return { kind: 'unavailable', reason: error.status === 403 ? 'denied' : error.status === 404 ? 'notFound' : 'unreadable' };
    throw error;
  }
}

/** The names of the projects of the reports the tasks are about, by resource id; a report that cannot be read has no name here and the card says what the record is instead. */
export function useReportNames(tasks: readonly ApprovalTask[]): ReadonlyMap<string, { project: string; period: string }> {
  const client = useApiClient();
  const { tenant } = useSession();
  const wanted = tasks.filter((task) => task.businessType === REPORT_ACCEPT && task.resourceId !== '');
  const answers = useQueries({
    queries: wanted.map((task) => ({
      queryKey: ['pwa', 'report', tenant?.id, tenant?.membershipId, task.resourceId],
      queryFn: () => readReport(client, task.resourceId),
      enabled: tenant !== undefined,
      retry: false,
      staleTime: Infinity,
    })),
  });
  const names = new Map<string, { project: string; period: string }>();
  wanted.forEach((task, index) => {
    const data = answers[index]?.data;
    if (data?.kind === 'ready') names.set(task.resourceId, { project: data.figures.projectName, period: data.figures.periodCode });
  });
  return names;
}

export interface StepRead {
  steps: StepEntry[];
  /** The reader is not allowed to see the other tasks of the instance, so only what the server showed is listed. */
  limited: boolean;
}

/** The tasks of the workflow instance the task belongs to, as the history of its steps; what the server scopes to the reader is all there is. */
export function useStepHistory(instanceId: string | null, enabled = true) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<StepRead>({
    queryKey: [...queueKey(tenant?.id, tenant?.membershipId), 'steps', instanceId ?? ''],
    queryFn: async () => {
      try {
        const rows = (await client.readAll('get_resources_approval_task' as never, { query: { workflow_instance_id: instanceId } } as never)) as unknown[];
        return { steps: stepHistory(rows), limited: false };
      } catch (error) {
        if (error instanceof ApiError && error.code !== NETWORK_ERROR_CODE) return { steps: [], limited: true };
        throw error;
      }
    },
    enabled: enabled && tenant !== undefined && instanceId !== null,
    retry: false,
  });
}
