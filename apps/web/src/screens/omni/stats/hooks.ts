import { useQuery } from '@tanstack/react-query';
import { useApiClient } from '../../../api/ApiClientContext';
import { useSession } from '../../../session/SessionContext';
import { toStatConversation } from './model';
import type { StatConversation } from './model';

export const statsKey = (tenantId: string | undefined, membershipId: string | undefined) => ['omni', 'stats', tenantId, membershipId] as const;

/** The conversations the reader may see, read to the end and cut down to what the statistics count (`get_resources_conversation`): no contact, no message, no assignee. What a reader sees depends on their queues, so the membership is part of the key. */
export function useStatConversations(enabled: boolean) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<StatConversation[]>({
    queryKey: statsKey(tenant?.id, tenant?.membershipId),
    queryFn: async () => (await client.readAll('get_resources_conversation')).flatMap((raw) => toStatConversation(raw) ?? []),
    enabled: enabled && tenant !== undefined,
    retry: false,
  });
}
