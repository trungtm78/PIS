import { ApiError } from '@machvon/api-client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../../api/ApiClientContext';
import { AttemptRegistry } from '../../../api/attempt-registry';
import { useScopeKey } from '../hooks';
import { toAnswer, toPaymentRequest } from './model';
import type { AttachBody, CreateBody, PaymentAnswer, PaymentRequest, ReviseBody } from './model';

export interface PaymentFilter {
  contractId?: string | null;
  status?: string | null;
}

/** The payment requests the caller may see, the newest first, narrowed by contract and status. */
export function usePayments(filter: PaymentFilter = {}) {
  const client = useApiClient();
  const key = useScopeKey();
  const query: Record<string, string> = {};
  if (filter.contractId) query.contract_id = filter.contractId;
  if (filter.status) query.status = filter.status;
  return useQuery<PaymentRequest[]>({
    queryKey: [...key, 'payments', filter.contractId ?? '', filter.status ?? ''],
    queryFn: async () => (await client.readAll('get_resources_payment_request', { query })).flatMap((raw) => toPaymentRequest(raw) ?? []),
    enabled: key[1] !== undefined,
    retry: false,
  });
}

/** One request with its lines and documents; null when it is not there for the caller (another tenant, or outside the scope: a 404). */
export function usePayment(id: string | null | undefined) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<PaymentRequest | null>({
    queryKey: [...key, 'payment', id ?? ''],
    queryFn: async () => {
      try {
        return toPaymentRequest(await client.read('get_resources_payment_request_id', { path: { id: id ?? '' } })) ?? null;
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return null;
        throw error;
      }
    },
    enabled: key[1] !== undefined && typeof id === 'string',
    retry: false,
  });
}

/** One mutation hook: one idempotency attempt per intention, the cached reads refreshed on success, and the answer of the server (with the figures it computed) given back. */
function useCommand<Input>(send: (input: Input, attempt: ReturnType<AttemptRegistry['forPayload']>) => Promise<unknown>) {
  const queryClient = useQueryClient();
  const key = useScopeKey();
  const attempts = useRef(new AttemptRegistry());
  return useMutation<PaymentAnswer | undefined, Error, Input>({
    mutationFn: async (input) => toAnswer(await send(input, attempts.current.forPayload(input))),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: key });
    },
    onError: (error) => attempts.current.ended(error),
  });
}

/** Draws a request up from an approved acceptance; the server computes every figure. */
export function useCreatePayment() {
  const client = useApiClient();
  return useCommand<CreateBody>((body, attempt) => client.command('createPaymentRequest', { body, attempt }));
}

export interface ReviseInput {
  id: string;
  version: number;
  body: ReviseBody;
}

export function useRevisePayment() {
  const client = useApiClient();
  return useCommand<ReviseInput>((input, attempt) => client.command('revisePaymentDraft', { path: { id: input.id }, body: input.body, ifMatchVersion: input.version, attempt }));
}

export interface AttachInput {
  id: string;
  body: AttachBody;
}

export function useAttachDocument() {
  const client = useApiClient();
  return useCommand<AttachInput>((input, attempt) => client.command('attachPaymentDocument', { path: { id: input.id }, body: input.body, attempt }));
}

export interface CancelInput {
  id: string;
  version: number;
  body: { reason: string };
}

export function useCancelPayment() {
  const client = useApiClient();
  return useCommand<CancelInput>((input, attempt) => client.command('cancelPaymentRequest', { path: { id: input.id }, body: input.body, ifMatchVersion: input.version, attempt }));
}
