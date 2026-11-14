import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../api/ApiClientContext';
import { AttemptRegistry } from '../../api/attempt-registry';
import { useSession } from '../../session/SessionContext';
import { pendingCommand, toPendingDecision } from './pending-model';
import type { PendingAction, PendingDecision } from './pending-model';

export const pendingKey = (tenantId: string | undefined, membershipId: string | undefined) => ['pwa', 'pending-decisions', tenantId, membershipId] as const;

export interface PendingInbox {
  items: PendingDecision[];
  /** The modules whose records could not be read: named on the screen, never shown as "nothing waits". */
  unavailable: string[];
  truncated: boolean;
}

/**
 * The records of the modules that wait for the signed-in person outside the approval engine (`listMyPendingDecisions`, PWF 20.9): the completion of a task, an exception, a proposal of a new schedule, an adjustment
 * of a score. The server lists only what the command of each would accept from this person. Read beside the tasks of the engine, never kept beyond the memory of the page.
 */
export function usePendingDecisions(enabled: boolean) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<PendingInbox>({
    queryKey: pendingKey(tenant?.id, tenant?.membershipId),
    queryFn: async () => {
      const page = (await client.read('listMyPendingDecisions', {})) as unknown as { items?: unknown[]; unavailable_sources?: unknown[]; truncated?: unknown };
      return {
        items: (page.items ?? []).flatMap((raw) => toPendingDecision(raw) ?? []),
        unavailable: (page.unavailable_sources ?? []).filter((one): one is string => typeof one === 'string'),
        truncated: page.truncated === true,
      };
    },
    enabled: enabled && tenant !== undefined,
    retry: false,
  });
}

export interface DecidePendingInput {
  item: PendingDecision;
  action: PendingAction;
  comment: string;
}

/**
 * Sends the decision of a pending record through the command of the module that owns it (the operation the item names), under the version the screen saw. There is no other way of deciding it: the permission, the
 * scope, the rule that nobody approves their own request and the audit row are those of that command. A repeat of the same intention reuses the idempotency key, so the server records it once.
 */
export function useDecidePending() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const { tenant } = useSession();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: (input: DecidePendingInput) => {
      const request = pendingCommand(input.item, input.action, input.comment);
      const attempt = attempts.current.forPayload({ id: input.item.id, version: input.item.version, operation: request.operationId, ...request.body });
      return client.command(request.operationId, { path: request.path as never, body: request.body as never, ifMatchVersion: input.item.version, attempt });
    },
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: pendingKey(tenant?.id, tenant?.membershipId) });
    },
    onError: (error) => attempts.current.ended(error),
  });
}
