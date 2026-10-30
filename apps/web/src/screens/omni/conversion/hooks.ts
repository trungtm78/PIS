import { useQuery } from '@tanstack/react-query';
import { useApiClient } from '../../../api/ApiClientContext';
import { useSession } from '../../../session/SessionContext';
import { THREAD_REFRESH_MS, threadKey, useThreadCommand } from '../thread/hooks';
import { toConvertible, toOptions } from './model';
import type { ConversionOptions, ConvertibleConversation } from './model';

/** One conversation with its links (`get_resources_conversation_id`), kept apart from the thread's copy of it: this one knows the issue the conversation became. */
export function useConvertible(conversationId: string | undefined, enabled: boolean) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<ConvertibleConversation | null>({
    queryKey: [...threadKey(tenant?.id, tenant?.membershipId, conversationId), 'convertible'],
    queryFn: async () => toConvertible(await client.read('get_resources_conversation_id', { path: { id: conversationId as string } })) ?? null,
    enabled: enabled && conversationId !== undefined && tenant !== undefined,
    refetchInterval: THREAD_REFRESH_MS,
    retry: false,
  });
}

/** The projects the agent may convert into and the categories of issues (`getConversionOptions`). */
export function useConversionOptions(enabled: boolean) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<ConversionOptions>({
    queryKey: ['omni', 'conversion-options', tenant?.id, tenant?.membershipId],
    queryFn: async () => toOptions(await client.read('getConversionOptions', {})),
    enabled: enabled && tenant !== undefined,
    retry: false,
  });
}

export interface ConvertInput {
  conversationId: string;
  version: number;
  body: Record<string, unknown>;
}

export function useConvert(conversationId: string | undefined) {
  return useThreadCommand<ConvertInput>(conversationId, (client, input, attempt) =>
    client.command('convertConversationToIssue', { path: { conversationId: input.conversationId }, body: input.body as never, ifMatchVersion: input.version, attempt }),
  );
}
