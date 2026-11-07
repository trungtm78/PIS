import { ApiError } from '@machvon/api-client';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../../api/ApiClientContext';
import { AttemptRegistry } from '../../../api/attempt-registry';
import { useSession } from '../../../session/SessionContext';
import { toChecks, toExceptionPage, toFindingPage } from './model';
import type { Checks, ExceptionPage, FindingPage } from './model';

// What these screens show depends on the scope of the membership that is signed in, not only on the tenant: the membership is part of every key (as for the other screens of the pay module).
export function useScopeKey(): readonly ['pay-integrity', string | undefined, string | undefined] {
  const { tenant } = useSession();
  return ['pay-integrity', tenant?.id, tenant?.membershipId];
}

/** The latest checks of a request with its findings and exceptions; null when the request is not there for the caller (another tenant, or outside the scope: a 404), never "no findings". */
export function useChecks(requestId: string | undefined) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<Checks | null>({
    queryKey: [...key, 'checks', requestId ?? ''],
    queryFn: async () => {
      try {
        return toChecks(await client.read('getPaymentIntegrityChecks', { path: { id: requestId ?? '' } })) ?? null;
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return null;
        throw error;
      }
    },
    enabled: key[1] !== undefined && requestId !== undefined,
    retry: false,
  });
}

export interface ExceptionFilter {
  status?: string | undefined;
  contractId?: string | undefined;
}

/** The register of exceptions in the scope of the reader (all pages, newest first). */
export function useExceptions(filter: ExceptionFilter = {}) {
  const client = useApiClient();
  const key = useScopeKey();
  const query: Record<string, string> = {};
  if (filter.status) query.status = filter.status;
  if (filter.contractId) query.contract_id = filter.contractId;
  return useQuery<ExceptionPage>({
    queryKey: [...key, 'exceptions', filter.status ?? '', filter.contractId ?? ''],
    queryFn: async () => {
      const items = await client.readAll('listDisbursementExceptions', { query });
      return toExceptionPage({ items, expiring_within_days: 7, as_of: new Date().toISOString() });
    },
    enabled: key[1] !== undefined,
    retry: false,
  });
}

export interface FindingFilter {
  code?: string | undefined;
  kind?: string | undefined;
  contractId?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
}

/** The findings for the auditor, a page at a time (the server's cursor), narrowed by code, kind, contract and day. */
export function useFindings(filter: FindingFilter = {}) {
  const client = useApiClient();
  const key = useScopeKey();
  const query: Record<string, string> = { limit: '50' };
  for (const [name, value] of [['code', filter.code], ['kind', filter.kind], ['contract_id', filter.contractId], ['from', filter.from], ['to', filter.to]] as const) if (value) query[name] = value;
  return useInfiniteQuery<FindingPage>({
    queryKey: [...key, 'findings', JSON.stringify(query)],
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }) => toFindingPage(await client.read('listPaymentIntegrityFindings', { query: pageParam === undefined ? query : { ...query, cursor: pageParam } } as never)),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: key[1] !== undefined,
    retry: false,
  });
}

/** One mutation hook: one idempotency attempt per intention, the cached reads of the module and of the payment refreshed on success. */
function useCommand<Input>(send: (input: Input, attempt: ReturnType<AttemptRegistry['forPayload']>) => Promise<unknown>) {
  const queryClient = useQueryClient();
  const key = useScopeKey();
  const attempts = useRef(new AttemptRegistry());
  return useMutation<unknown, Error, Input>({
    mutationFn: (input) => send(input, attempts.current.forPayload(input)),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: key });
      // The payment screens (PAY-01..03) keep their own keys: what the checks changed is read again there too.
      await queryClient.invalidateQueries({ predicate: (query) => query.queryKey[0] === 'pay' || query.queryKey[0] === 'payments' });
    },
    onError: (error) => attempts.current.ended(error),
  });
}

export const useCheckIntegrity = () => {
  const client = useApiClient();
  return useCommand<{ requestId: string }>((input, attempt) => client.command('checkPaymentIntegrity', { path: { id: input.requestId }, body: {}, attempt }));
};

export interface RequestExceptionInput {
  requestId: string;
  body: { ceiling: 'EXCEEDS_PLAN' | 'EXCEEDS_CONTRACT'; allowed_amount_vnd: string; valid_to: string; reason: string };
}
export const useRequestException = () => {
  const client = useApiClient();
  return useCommand<RequestExceptionInput>((input, attempt) => client.command('requestDisbursementException', { path: { id: input.requestId }, body: input.body, attempt }));
};

export interface DecideExceptionInput {
  id: string;
  version: number;
  move: 'approve' | 'reject' | 'revoke';
  /** The note of an approval (optional) or the reason of a rejection or a revocation (required). */
  text: string;
}
export const useDecideException = () => {
  const client = useApiClient();
  return useCommand<DecideExceptionInput>((input, attempt) => {
    if (input.move === 'approve') return client.command('approveDisbursementException', { path: { id: input.id }, body: input.text === '' ? {} : { note: input.text }, ifMatchVersion: input.version, attempt });
    return client.command(input.move === 'reject' ? 'rejectDisbursementException' : 'revokeDisbursementException', { path: { id: input.id }, body: { reason: input.text }, ifMatchVersion: input.version, attempt });
  });
};
