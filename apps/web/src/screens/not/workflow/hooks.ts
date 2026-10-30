import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../../api/ApiClientContext';
import { AttemptRegistry } from '../../../api/attempt-registry';
import { useSession } from '../../../session/SessionContext';
import { toEventTypes, toWorkflowPage } from './model';
import type { EventTypeView, WorkflowPage } from './model';

export const eventTypesKey = (tenantId: string | undefined) => ['not', 'event-types', tenantId] as const;
export const workflowsKey = (tenantId: string | undefined, eventType: string | undefined) => ['not', 'workflows', tenantId, eventType ?? 'none'] as const;

/** The catalogue of the event types that may reach people (`listNotificationEventTypes`). */
export function useEventTypes(enabled: boolean) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<EventTypeView[]>({
    queryKey: eventTypesKey(tenant?.id),
    queryFn: async () => toEventTypes(await client.read('listNotificationEventTypes')),
    enabled: enabled && tenant !== undefined,
    retry: false,
  });
}

/** The workflows of one event type, newest first (`listNotificationWorkflows`), a page at a time. */
export function useWorkflows(eventType: string | undefined, enabled: boolean) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useInfiniteQuery<WorkflowPage, Error, { pages: WorkflowPage[] }, ReturnType<typeof workflowsKey>, string | undefined>({
    queryKey: workflowsKey(tenant?.id, eventType),
    initialPageParam: undefined,
    queryFn: async ({ pageParam }) =>
      toWorkflowPage(await client.read('listNotificationWorkflows', { query: { event_type: eventType as string, ...(pageParam === undefined ? {} : { cursor: pageParam }) } })),
    getNextPageParam: (last) => last.nextCursor,
    enabled: enabled && tenant !== undefined && eventType !== undefined,
    retry: false,
  });
}

export interface DraftInput {
  eventType: string;
  definition: Record<string, unknown>;
}

export interface PublishInput {
  eventType: string;
  workflowId: string;
  version: number;
  reason: string;
}

function useWorkflowMutation<I extends { eventType: string }>(
  run: (client: ReturnType<typeof useApiClient>, input: I, attempt: ReturnType<AttemptRegistry['forPayload']>) => Promise<unknown>,
) {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const { tenant } = useSession();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: (input: I) => run(client, input, attempts.current.forPayload(input)),
    onSuccess: async (_result, input) => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: workflowsKey(tenant?.id, input.eventType) });
    },
    onError: (error) => attempts.current.ended(error),
  });
}

/** Writes a draft (`createNotificationWorkflowDraft`). */
export function useCreateDraft() {
  return useWorkflowMutation<DraftInput>((client, input, attempt) =>
    client.command('createNotificationWorkflowDraft', { body: { event_type: input.eventType, definition: input.definition } as never, attempt }),
  );
}

/** Publishes a draft at the version the person saw (`post_notification_workflows_id_publish`; the Decision body of the contract, as a go-ahead). */
export function usePublish() {
  return useWorkflowMutation<PublishInput>((client, input, attempt) =>
    client.command('post_notification_workflows_id_publish', {
      path: { id: input.workflowId },
      body: { decision: 'approve', reason: input.reason, evidence_ids: [] } as never,
      ifMatchVersion: input.version,
      attempt,
    }),
  );
}
