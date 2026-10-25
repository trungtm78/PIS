import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../../api/ApiClientContext';
import { AttemptRegistry } from '../../../api/attempt-registry';
import { useScopeKey } from '../hooks';
import { toReversal } from './model';
import type { Reversal } from './model';

export interface ReverseInput {
  id: string;
  version: number;
  body: { reason: string; approval_document_version_id: string; refund_treasury_transaction_id: string };
}

/** Reverses a payment that was settled: one idempotency attempt per intention, and every cached read of PAY (the request, its ledger, the transactions) read again on success. */
export function useReverse() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const key = useScopeKey();
  const attempts = useRef(new AttemptRegistry());
  return useMutation<Reversal | undefined, Error, ReverseInput>({
    mutationFn: async (input) => toReversal(await client.command('reversePayment', { path: { id: input.id }, body: input.body, ifMatchVersion: input.version, attempt: attempts.current.forPayload(input) })),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: key });
    },
    onError: (error) => attempts.current.ended(error),
  });
}
