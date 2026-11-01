import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../../api/ApiClientContext';
import { AttemptRegistry } from '../../../api/attempt-registry';
import type { CaptureBody } from './model';

/** Registers a photo (registerSitePhoto). The operation id inside the body makes a send repeated after a lost answer the same photo; the attempt is the idempotency key of the intention. */
export function useRegisterPhoto() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: async (body: CaptureBody): Promise<string | undefined> => {
      const answer = (await client.command('registerSitePhoto', { body, attempt: attempts.current.forPayload(body) })) as { resource_id?: unknown } | undefined;
      return typeof answer?.resource_id === 'string' ? answer.resource_id : undefined;
    },
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ predicate: (query) => query.queryKey[0] === 'qms-photos' });
    },
    onError: (error) => attempts.current.ended(error),
  });
}
