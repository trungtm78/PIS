import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../../api/ApiClientContext';
import { AttemptRegistry } from '../../../api/attempt-registry';
import { useSession } from '../../../session/SessionContext';
import { toTask } from './model';
import type { MonitorTask } from './model';

const root = (tenantId: string | undefined) => ['adm', 'approvals', tenantId] as const;

/** The pending tasks of the tenant (every page), with the instance of each. */
export function useOpenTasks(enabled: boolean) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<MonitorTask[]>({
    queryKey: [...root(tenant?.id), 'pending'],
    queryFn: async () => {
      const now = Date.now();
      return (await client.readAll('get_resources_approval_task', { query: { status: 'Pending' } as never })).flatMap((raw) => toTask(raw, now) ?? []);
    },
    enabled: enabled && tenant !== undefined,
    retry: false,
  });
}

function useApprovalCommand<Input>(send: (input: Input, attempt: ReturnType<AttemptRegistry['forPayload']>) => Promise<unknown>) {
  const queryClient = useQueryClient();
  const { tenant } = useSession();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: (input: Input) => send(input, attempts.current.forPayload(input)),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: root(tenant?.id) });
    },
    onError: (error) => attempts.current.ended(error),
  });
}

export function useReassign() {
  const client = useApiClient();
  return useApprovalCommand<{ taskId: string; version: number; to: string; reason: string }>((input, attempt) =>
    client.command('reassignApprovalTask', { path: { taskId: input.taskId }, body: { new_assignee_membership_id: input.to, reason: input.reason } as never, ifMatchVersion: input.version, attempt }),
  );
}

export function useCancelInstance() {
  const client = useApiClient();
  return useApprovalCommand<{ instanceId: string; version: number; reason: string }>((input, attempt) => client.command('cancelWorkflowInstance', { path: { instanceId: input.instanceId }, body: { reason: input.reason } as never, ifMatchVersion: input.version, attempt }));
}
