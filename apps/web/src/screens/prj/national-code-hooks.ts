import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../api/ApiClientContext';
import { AttemptRegistry } from '../../api/attempt-registry';
import { useScopeKey } from './hooks';
import type { AssignBody } from './national-code-model';

export interface AssignCodeInput {
  id: string;
  version: number;
  body: AssignBody;
}

/** The assignment of a code by hand: one idempotency attempt per intention, every cached read of the register and of the board refreshed on success. */
export function useAssignNationalCode() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const key = useScopeKey();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: (input: AssignCodeInput) => client.command('assignNationalProjectCode', { path: { id: input.id }, body: input.body, ifMatchVersion: input.version, attempt: attempts.current.forPayload(input) }),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: key });
    },
    onError: (error) => attempts.current.ended(error),
  });
}
