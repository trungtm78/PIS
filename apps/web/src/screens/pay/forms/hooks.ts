import { ApiError } from '@machvon/api-client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../../api/ApiClientContext';
import { AttemptRegistry } from '../../../api/attempt-registry';
import { useScopeKey } from '../hooks';
import { toAnswer } from '../payment/model';
import type { PaymentAnswer } from '../payment/model';
import { toForms, toFormsAnswer } from './model';
import type { AnswerOfForms, FormCode, PaymentForm, SendBody } from './model';

/** The forms of a request, the ones that stand first; null when the request is not there for the caller (another tenant, or outside the scope: a 404). */
export function useForms(requestId: string | null | undefined) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<PaymentForm[] | null>({
    queryKey: [...key, 'payment-forms', requestId ?? ''],
    queryFn: async () => {
      try {
        return toForms(await client.read('listPaymentForms', { path: { id: requestId ?? '' } }));
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return null;
        throw error;
      }
    },
    enabled: key[1] !== undefined && typeof requestId === 'string',
    retry: false,
  });
}

/** One mutation hook: one idempotency attempt per intention, the cached reads refreshed on success, and the answer of the server given back. */
function useCommand<Input, Answer>(send: (input: Input, attempt: ReturnType<AttemptRegistry['forPayload']>) => Promise<unknown>, read: (value: unknown) => Answer | undefined) {
  const queryClient = useQueryClient();
  const key = useScopeKey();
  const attempts = useRef(new AttemptRegistry());
  return useMutation<Answer | undefined, Error, Input>({
    mutationFn: async (input) => read(await send(input, attempts.current.forPayload(input))),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: key });
    },
    onError: (error) => attempts.current.ended(error),
  });
}

export interface GenerateInput {
  id: string;
  body: { form_codes: FormCode[]; place: string };
}

/** Draws the forms asked for; the server makes the payload from the figures of the request. */
export function useGenerateForms() {
  const client = useApiClient();
  return useCommand<GenerateInput, AnswerOfForms>((input, attempt) => client.command('generatePaymentForms', { path: { id: input.id }, body: input.body, attempt }), toFormsAnswer);
}

export interface SendInput {
  id: string;
  version: number;
  body: SendBody;
}

/** Records that the file went to the Treasury, on the day and under the number that were entered. */
export function useSendToTreasury() {
  const client = useApiClient();
  return useCommand<SendInput, PaymentAnswer>((input, attempt) => client.command('markPaymentSentToTreasury', { path: { id: input.id }, body: input.body, ifMatchVersion: input.version, attempt }), toAnswer);
}
