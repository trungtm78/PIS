import { ApiError } from '@machvon/api-client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useApiClient } from '../../../api/ApiClientContext';
import { AttemptRegistry } from '../../../api/attempt-registry';
import { useScopeKey } from '../hooks';
import { toManualOutcome } from './manual-confirm-model';
import type { ManualOutcome } from './manual-confirm-model';
import { toAnswer, toPaymentRequest } from './model';
import type { AttachBody, CreateBody, PaymentAnswer, PaymentRequest, ReviseBody } from './model';

export interface PaymentFilter {
  contractId?: string | null;
  status?: string | null;
}

/** The payment requests the caller may see, the newest first, narrowed by contract and status. */
export function usePayments(filter: PaymentFilter = {}, enabled = true) {
  const client = useApiClient();
  const key = useScopeKey();
  const query: Record<string, string> = {};
  if (filter.contractId) query.contract_id = filter.contractId;
  if (filter.status) query.status = filter.status;
  return useQuery<PaymentRequest[]>({
    queryKey: [...key, 'payments', filter.contractId ?? '', filter.status ?? ''],
    queryFn: async () => (await client.readAll('get_resources_payment_request', { query })).flatMap((raw) => toPaymentRequest(raw) ?? []),
    enabled: enabled && key[1] !== undefined,
    retry: false,
  });
}

/** What the detail of a payment request needs to open on a request: the one in the address, else the newest one of the list with the list to change it. */
export interface PaymentChoice {
  /** The request to read; null when the address names none and the list offers none. */
  requestId: string | null;
  /** True when the address names no request, so the screen shows the newest one and offers the list to change it. */
  defaulted: boolean;
  choices: readonly PaymentRequest[];
  isLoading: boolean;
  pick(requestId: string): void;
}

/** The request of the detail screen (the `request` parameter); nothing is read from the list when the address names a request. */
export function usePaymentChoice(): PaymentChoice {
  const [search] = useSearchParams();
  const named = search.get('request');
  const [picked, setPicked] = useState<string | null>(null);
  const list = usePayments({}, named === null);
  const choices = named === null ? (list.data ?? []) : [];
  return { requestId: named ?? picked ?? choices[0]?.id ?? null, defaulted: named === null, choices, isLoading: named === null && list.isLoading, pick: setPicked };
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

export interface SubmitInput {
  id: string;
  version: number;
  body: { expected_gross_vnd: string; expected_net_vnd: string };
}

/** Sends the request: the server takes the claim on the acceptance and puts the amounts on the ledger of the contract. */
export function useSubmitPayment() {
  const client = useApiClient();
  return useCommand<SubmitInput>((input, attempt) => client.command('post_payment_requests_id_submit', { path: { id: input.id }, body: input.body, ifMatchVersion: input.version, attempt }));
}

export interface VerifyInput {
  id: string;
  version: number;
  body: { note?: string };
}

export function useVerifyPayment() {
  const client = useApiClient();
  return useCommand<VerifyInput>((input, attempt) => client.command('verifyPaymentRequest', { path: { id: input.id }, body: input.body, ifMatchVersion: input.version, attempt }));
}

export interface ReturnReasons {
  items: Array<{ code: string; category: string; requiresNote: boolean }>;
  required: boolean;
}

/** The standard reasons to return a request and whether a code is required (rule PAYMENT_RETURN_REASON); read when the dialog opens. */
export function useReturnReasons(enabled = true) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<ReturnReasons>({
    queryKey: [...key, 'return-reasons'],
    queryFn: async () => {
      const answer = (await client.read('listPaymentReturnReasons' as never, {} as never)) as { items?: Array<{ code: string; category: string; requires_note: boolean; active: boolean }>; reason_code_required?: boolean };
      return { items: (answer.items ?? []).filter((item) => item.active !== false).map((item) => ({ code: item.code, category: item.category, requiresNote: item.requires_note })), required: answer.reason_code_required === true };
    },
    enabled: enabled && key[1] !== undefined,
    retry: false,
  });
}

export function useReturnPayment() {
  const client = useApiClient();
  return useCommand<CancelInput & { body: { reason: string; reason_code?: string } }>((input, attempt) => client.command('returnPaymentRequest', { path: { id: input.id }, body: input.body, ifMatchVersion: input.version, attempt }));
}

export interface ManualConfirmInput {
  body: { payment_request_id: string; document_no: string; document_date: string; amount_vnd: string; confirmed_at: string; evidence_document_version_id: string };
}

/** Confirms by hand that the Treasury paid a request (source manual-confirmed): the document, its day, the amount and the evidence in DOC; the person who sent the request to the Treasury cannot confirm it. */
export function useManualTreasuryConfirm() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const key = useScopeKey();
  const attempts = useRef(new AttemptRegistry());
  // The answer is read as it is (status EXCEPTION and the reconciliation item), not as the figures of a payment request.
  return useMutation<ManualOutcome, Error, ManualConfirmInput>({
    mutationFn: async (input) => toManualOutcome(await client.command('confirmTreasuryManually', { body: input.body, attempt: attempts.current.forPayload(input) })),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: key });
    },
    onError: (error) => attempts.current.ended(error),
  });
}
