import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../api/ApiClientContext';
import { AttemptRegistry } from '../../api/attempt-registry';
import { useSession } from '../../session/SessionContext';
import { byUrgency, decisionBody, toApprovalTask } from './approval-model';
import type { ApprovalTask, Decision } from './approval-model';

// What the queue holds depends on the member that is signed in, not only on the tenant.
export const queueKey = (tenantId: string | undefined, membershipId: string | undefined) => ['pwa', 'approvals', tenantId, membershipId] as const;

/**
 * The approval tasks waiting for the signed-in person (the same list as the phone's inbox: `mine`, `Pending`). The answer is read, never kept
 * beyond the memory of the page: the service worker does not store it and a logout clears it.
 */
export function useApprovalQueue(enabled: boolean) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<ApprovalTask[]>({
    queryKey: queueKey(tenant?.id, tenant?.membershipId),
    queryFn: async () => byUrgency((await client.readAll('get_resources_approval_task', { query: { mine: 'true', status: 'Pending' } as never })).flatMap((raw) => toApprovalTask(raw) ?? [])),
    enabled: enabled && tenant !== undefined,
    retry: false,
  });
}

export interface DecideInput {
  task: Pick<ApprovalTask, 'id' | 'version'>;
  decision: Decision;
  comment: string;
}

/**
 * Sends one decision: approve or return, with the comment, under the version of the task the screen saw. It is never queued and never retried by the
 * page on its own: a repeat of the same intention (a second tap after a lost answer) reuses the idempotency key, so the server records it once.
 */
export function useDecideTask() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const { tenant } = useSession();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: (input: DecideInput) => {
      const body = decisionBody(input.decision, input.comment);
      const attempt = attempts.current.forPayload({ id: input.task.id, version: input.task.version, ...body });
      return client.command('decideApprovalTask', { path: { taskId: input.task.id }, body: body as never, ifMatchVersion: input.task.version, attempt });
    },
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: queueKey(tenant?.id, tenant?.membershipId) });
    },
    onError: (error) => attempts.current.ended(error),
  });
}
