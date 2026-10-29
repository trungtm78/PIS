import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../../api/ApiClientContext';
import { AttemptRegistry } from '../../../api/attempt-registry';
import { useSession } from '../../../session/SessionContext';
import { WAITING_REFRESH_MS, isWaiting, toTenantInvoices } from './model';
import type { TenantInvoices } from './model';

export const invoicesKey = (sessionTenantId: string | undefined, tenantId: string | undefined) => ['sas', 'invoices', sessionTenantId, tenantId ?? 'none'] as const;

/** The invoices of a tenant with the state of its subscription (`listTenantInvoices`); while one waits for the provider the screen reads again every few seconds. */
export function useTenantInvoices(tenantId: string | undefined) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useInfiniteQuery<TenantInvoices, Error, { pages: TenantInvoices[] }, ReturnType<typeof invoicesKey>, string | undefined>({
    queryKey: invoicesKey(tenant?.id, tenantId),
    initialPageParam: undefined,
    queryFn: async ({ pageParam }) => toTenantInvoices(await client.read('listTenantInvoices', { path: { tenantId: tenantId ?? '' }, ...(pageParam === undefined ? {} : { query: { cursor: pageParam } }) })),
    getNextPageParam: (last) => last.nextCursor,
    enabled: tenant !== undefined && tenantId !== undefined,
    retry: false,
    refetchInterval: (query) => (isWaiting(query.state.data?.pages.flatMap((page) => page.items)) ? WAITING_REFRESH_MS : false),
  });
}

function useCommand<Input>(send: (input: Input, attempt: ReturnType<AttemptRegistry['forPayload']>) => Promise<unknown>) {
  const queryClient = useQueryClient();
  const { tenant } = useSession();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: (input: Input) => send(input, attempts.current.forPayload(input)),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: ['sas', 'invoices', tenant?.id] });
    },
    onError: (error) => attempts.current.ended(error),
  });
}

export interface RunInput {
  tenantId: string;
  periodStart: string;
  periodEnd: string;
}

export function useRunBilling() {
  const client = useApiClient();
  return useCommand<RunInput>((input, attempt) => client.command('runBillingCycle', { body: { period_start: input.periodStart, period_end: input.periodEnd, tenant_ids: [input.tenantId] } as never, attempt }));
}

export interface IssueInput {
  invoiceId: string;
  version: number;
  reason: string;
}

/** The outcome the command answers with: ISSUED, PENDING_ISSUE (the provider did not answer, the worker asks again) or ISSUE_FAILED. */
export function useIssueInvoice() {
  const client = useApiClient();
  return useCommand<IssueInput>(async (input, attempt) => client.command('issueEInvoice', { path: { invoiceId: input.invoiceId }, body: { reason: input.reason } as never, ifMatchVersion: input.version, attempt }));
}
