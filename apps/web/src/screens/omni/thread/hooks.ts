import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../../api/ApiClientContext';
import { AttemptRegistry, isDefinitiveRefusal } from '../../../api/attempt-registry';
import { useSession } from '../../../session/SessionContext';
import { toConversation, toMessageText, toMessages } from './model';
import type { Conversation, ThreadMessage } from './model';

/** The thread is read again this often while it is open: a message goes out, is received and answered after the command that queued it has finished, and nothing else tells the screen. */
export const THREAD_REFRESH_MS = 15_000;

// Who reads is part of the key, as for every read that depends on the scope of the person.
export const threadKey = (tenantId: string | undefined, membershipId: string | undefined, conversationId: string | undefined) => ['omni', 'thread', tenantId, membershipId, conversationId ?? 'none'] as const;

/** One conversation (`get_resources_conversation_id`). */
export function useConversation(conversationId: string | undefined, enabled: boolean) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<Conversation | null>({
    queryKey: [...threadKey(tenant?.id, tenant?.membershipId, conversationId), 'conversation'],
    queryFn: async () => toConversation(await client.read('get_resources_conversation_id', { path: { id: conversationId as string } })) ?? null,
    enabled: enabled && conversationId !== undefined && tenant !== undefined,
    refetchInterval: THREAD_REFRESH_MS,
    retry: false,
  });
}

/** The messages of the conversation, oldest first, without their text (`get_resources_channel_message`). */
export function useMessages(conversationId: string | undefined, enabled: boolean) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<ThreadMessage[]>({
    queryKey: [...threadKey(tenant?.id, tenant?.membershipId, conversationId), 'messages'],
    queryFn: async () => toMessages(await client.readAll('get_resources_channel_message', { query: { conversation_id: conversationId as string } })),
    enabled: enabled && conversationId !== undefined && tenant !== undefined,
    refetchInterval: THREAD_REFRESH_MS,
    retry: false,
  });
}

/** The text of one message, read when the agent asks for it: the text is personal data and is not carried by the list. */
export function useMessageText(messageId: string, enabled: boolean) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<string>({
    queryKey: ['omni', 'message-text', tenant?.id, tenant?.membershipId, messageId],
    queryFn: async () => toMessageText(await client.read('get_resources_channel_message_id', { path: { id: messageId } })),
    enabled: enabled && tenant !== undefined,
    retry: false,
  });
}

/**
 * One command of the thread: keeps its idempotency attempt across retries and reads the thread again, also after a refusal, since it can follow a change made by someone else. The version the intention was first sent at is kept with it:
 * when an answer is lost after the command committed, the thread is read again and its version has moved, and the same retry must still be the same request (the server judges it by the key, the body and the version), or the message would
 * go twice. A final refusal, or a success, ends the intention.
 */
function useThreadCommand<Input extends { version: number }>(
  conversationId: string | undefined,
  run: (client: ReturnType<typeof useApiClient>, input: Input, attempt: { key: string }) => Promise<unknown>,
) {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const { tenant } = useSession();
  const attempts = useRef(new AttemptRegistry());
  const pinned = useRef<{ intent: string; version: number } | undefined>(undefined);
  const refresh = (): Promise<void> => queryClient.invalidateQueries({ queryKey: threadKey(tenant?.id, tenant?.membershipId, conversationId) });
  return useMutation({
    mutationFn: (input: Input) => {
      const { version, ...intent } = input;
      const key = JSON.stringify(intent);
      if (pinned.current?.intent !== key) pinned.current = { intent: key, version };
      const same = { ...input, version: pinned.current.version };
      return run(client, same, attempts.current.forPayload(same));
    },
    onSuccess: async () => {
      attempts.current.done();
      pinned.current = undefined;
      await refresh();
    },
    onError: async (error) => {
      attempts.current.ended(error);
      if (isDefinitiveRefusal(error)) pinned.current = undefined;
      await refresh();
    },
  });
}

export interface SendInput {
  conversationId: string;
  version: number;
  body: Record<string, unknown>;
}

export function useSendMessage(conversationId: string | undefined) {
  return useThreadCommand<SendInput>(conversationId, (client, input, attempt) =>
    client.command('sendConversationMessage', { path: { conversationId: input.conversationId }, body: input.body as never, ifMatchVersion: input.version, attempt }),
  );
}

export interface MoveInput {
  conversationId: string;
  version: number;
  reason: string;
  action: 'resolve' | 'reopen';
}

export function useMoveConversation(conversationId: string | undefined) {
  return useThreadCommand<MoveInput>(conversationId, (client, input, attempt) =>
    client.command(input.action === 'resolve' ? 'resolveConversation' : 'reopenConversation', { path: { conversationId: input.conversationId }, body: { reason: input.reason }, ifMatchVersion: input.version, attempt }),
  );
}
