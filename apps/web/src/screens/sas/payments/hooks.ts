import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../../api/ApiClientContext';
import { AttemptRegistry } from '../../../api/attempt-registry';
import { useSession } from '../../../session/SessionContext';
import { toPaymentPage } from './model';
import type { PaymentPage } from './model';

export const paymentsKey = (sessionTenantId: string | undefined) => ['sas', 'payments', sessionTenantId] as const;

/** The payments that wait for a person, the latest first, page by page (`listBillingPayments`). */
export function usePaymentQueue(enabled = true) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useInfiniteQuery<PaymentPage, Error, { pages: PaymentPage[] }, ReturnType<typeof paymentsKey>, string | undefined>({
    queryKey: paymentsKey(tenant?.id),
    initialPageParam: undefined,
    queryFn: async ({ pageParam }) => toPaymentPage(await client.read('listBillingPayments', { query: pageParam === undefined ? {} : { cursor: pageParam } })),
    getNextPageParam: (last) => last.nextCursor,
    enabled: enabled && tenant !== undefined,
    retry: false,
  });
}

export interface MatchInput {
  paymentId: string;
  invoiceId: string;
  version: number;
  reason: string;
}

export function useMatchPayment() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const { tenant } = useSession();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: (input: MatchInput) => client.command('matchBillingPayment', { path: { paymentId: input.paymentId }, body: { invoice_id: input.invoiceId, reason: input.reason } as never, ifMatchVersion: input.version, attempt: attempts.current.forPayload(input) }),
    onSuccess: async () => {
      attempts.current.done();
      // The queue loses the payment and the invoices of the tenants show it matched.
      await Promise.all([queryClient.invalidateQueries({ queryKey: paymentsKey(tenant?.id) }), queryClient.invalidateQueries({ queryKey: ['sas', 'invoices', tenant?.id] })]);
    },
    onError: (error) => attempts.current.ended(error),
  });
}
