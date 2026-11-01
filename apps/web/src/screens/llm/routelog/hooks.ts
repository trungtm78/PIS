import { keepPreviousData, useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../../api/ApiClientContext';
import { AttemptRegistry } from '../../../api/attempt-registry';
import { useSession } from '../../../session/SessionContext';
import { PAGE_SIZE, runBody, toReconciliationPage } from './model';
import type { ReconciliationPage, RunForm } from './model';

// What the list holds depends on the membership that is signed in, not only on the tenant.
const root = (tenantId: string | undefined, membershipId: string | undefined) => ['llm', 'reconciliations', tenantId, membershipId] as const;

/** The reconciliations of invoices, newest first, narrowed to one state when one is asked for ('' is all). */
export function useReconciliations(status: string) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useInfiniteQuery<ReconciliationPage, Error, { pages: ReconciliationPage[] }, readonly unknown[], string | undefined>({
    queryKey: [...root(tenant?.id, tenant?.membershipId), 'list', status],
    initialPageParam: undefined,
    queryFn: async ({ pageParam }) =>
      toReconciliationPage(
        await client.read('listAiInvoiceReconciliations', {
          query: {
            limit: PAGE_SIZE,
            ...(status === '' ? {} : { status: status as 'VARIANCE' | 'RECONCILED' }),
            ...(pageParam === undefined ? {} : { cursor: pageParam }),
          },
        }),
      ),
    getNextPageParam: (last) => last.next,
    // A new filter keeps the list that is on the screen until the new one is there.
    placeholderData: keepPreviousData,
    enabled: tenant !== undefined,
    retry: false,
  });
}

/** Sets an invoice of a provider against the attempts of the period. The same figures asked again are one run: the attempt is kept until the answer is in. */
export function useRunReconciliation() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const { tenant } = useSession();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: (form: RunForm) =>
      client.command('reconcileAiInvoice', {
        body: runBody(form) as never,
        attempt: attempts.current.forPayload(form),
      }),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({
        queryKey: root(tenant?.id, tenant?.membershipId),
      });
    },
    onError: (error) => attempts.current.ended(error),
  });
}
