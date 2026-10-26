import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../../api/ApiClientContext';
import { AttemptRegistry } from '../../../api/attempt-registry';
import { useScopeKey } from '../hooks';
import { toPaymentLine } from './model';
import type { ConfirmBody, PaymentLine, ScheduleBody } from './model';

/** The payments of one plan inside the units of the caller. */
export function usePayments(planId: string | undefined) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<PaymentLine[]>({
    queryKey: [...key, 'payments', planId ?? ''],
    queryFn: async () => (await client.readAll('listCompensationPayments', { path: { id: planId ?? '' } })).flatMap((raw) => toPaymentLine(raw) ?? []),
    enabled: key[1] !== undefined && planId !== undefined,
    retry: false,
  });
}

export interface ScheduleInput {
  id: string;
  version: number;
  payments: ScheduleBody[];
}

/** Payments scheduled on a plan, under the version of the plan the caller saw: one idempotency attempt per intention, every cached read of the land screens refreshed on success. */
export function useSchedulePayments() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const key = useScopeKey();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: (input: ScheduleInput) =>
      client.command('scheduleCompensationPayments', { path: { id: input.id }, body: { payments: input.payments }, ifMatchVersion: input.version, attempt: attempts.current.forPayload(input) }),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: key });
    },
    onError: (error) => attempts.current.ended(error),
  });
}

export interface ConfirmInput {
  id: string;
  version: number;
  body: ConfirmBody;
}

/** The confirmation of a payment, under the version of the payment the caller saw. */
export function useConfirmPayment() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const key = useScopeKey();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: (input: ConfirmInput) => client.command('confirmCompensationPayment', { path: { id: input.id }, body: input.body, ifMatchVersion: input.version, attempt: attempts.current.forPayload(input) }),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: key });
    },
    onError: (error) => attempts.current.ended(error),
  });
}

export interface DepositInput {
  id: string;
  version: number;
  body: { paid_on: string; deposit_reason: string; voucher_document_version_id: string };
}

/** The deposit of the money of a payment that the household did not take. */
export function useDepositPayment() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const key = useScopeKey();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: (input: DepositInput) => client.command('depositCompensationPayment', { path: { id: input.id }, body: input.body, ifMatchVersion: input.version, attempt: attempts.current.forPayload(input) }),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: key });
    },
    onError: (error) => attempts.current.ended(error),
  });
}
