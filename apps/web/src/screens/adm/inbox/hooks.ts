import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../../api/ApiClientContext';
import { AttemptRegistry } from '../../../api/attempt-registry';
import { useSession } from '../../../session/SessionContext';
import { toInboxEvent } from './model';
import type { InboxEventView } from './model';

/** The queries of the sync monitor begin with this key: a replay refreshes all of them. */
export const syncKey = (tenantId: string | undefined) => ['adm', 'sync', tenantId] as const;

export interface ReplayInput {
  id: string;
  version: number;
  reason: string;
}

/** Takes a failed or dead event up again (versioned: a stale version is a 409); one idempotency attempt per intention. */
export function useReplayInboxEvent() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const { tenant } = useSession();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: (input: ReplayInput) =>
      client.command('replayInboxEvent', {
        path: { inboxEventId: input.id },
        body: { reason: input.reason },
        ifMatchVersion: input.version,
        attempt: attempts.current.forPayload(input),
      }),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: syncKey(tenant?.id) });
    },
    onError: (error) => attempts.current.ended(error),
  });
}

/** The inbound events of the tenant, newest first, without their payload (the filter by status and provider is the screen's own). */
export function useInboxEvents(enabled = true) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<InboxEventView[]>({
    queryKey: [...syncKey(tenant?.id), 'events'],
    queryFn: async () => (await client.readAll('get_resources_integration_event_inbox')).flatMap((raw) => toInboxEvent(raw) ?? []),
    enabled: enabled && tenant !== undefined,
    retry: false,
  });
}
