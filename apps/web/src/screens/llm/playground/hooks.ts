import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../../api/ApiClientContext';
import { AttemptRegistry } from '../../../api/attempt-registry';
import { useSession } from '../../../session/SessionContext';
import { llmRoot } from '../hooks';
import { requestBody, sha256Hex, toAnswer } from './model';
import type { Answer, PlaygroundForm } from './model';

export interface TryInput {
  form: PlaygroundForm;
  taskType: string;
}

/**
 * Sends a try to the gateway as a request: the text is hashed here and only the hash and a reference to it travel, so the gateway never holds what was typed. The same try sent again is one request (the attempt is kept until
 * the answer is in); a try that was answered refreshes the records of the gateway.
 */
export function useTryPrompt() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const { tenant } = useSession();
  const attempts = useRef(new AttemptRegistry());
  return useMutation<Answer, Error, TryInput>({
    mutationFn: async ({ form, taskType }) => {
      const body = requestBody(form, taskType, await sha256Hex(form.input));
      const answer = toAnswer(await client.command('requestAiCompletion', { body: body as never, attempt: attempts.current.forPayload(body) }));
      if (answer === undefined) throw new Error('requestAiCompletion answered nothing that can be read');
      return answer;
    },
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: llmRoot(tenant?.id) });
    },
    onError: (error) => attempts.current.ended(error),
  });
}
