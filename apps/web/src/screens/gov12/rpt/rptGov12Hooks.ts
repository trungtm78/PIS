import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../../api/ApiClientContext';
import { AttemptRegistry } from '../../../api/attempt-registry';
import { useSession } from '../../../session/SessionContext';
import type { Issue } from '../../rpt/model';
import type { CertificateRow, LockPage, SignatureFacts } from './rptGov12Model';

// What the screens show depends on the membership as well as the tenant: both are part of every key.
function useScopeKey(): readonly ['rpt-gov12', string | undefined, string | undefined] {
  const { tenant } = useSession();
  return ['rpt-gov12', tenant?.id, tenant?.membershipId];
}

const q = (value: Record<string, string | number | boolean | undefined>): never => value as never;
const path = (id: string): never => ({ id }) as never;

export interface LockFilter {
  layoutCode: string | undefined;
  openOnly: boolean;
}

export function useLocks(filter: LockFilter) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<LockPage>({
    queryKey: [...key, 'locks', filter.layoutCode ?? '', filter.openOnly],
    queryFn: () => client.read('listReportPeriodLocks', { query: q({ ...(filter.layoutCode === undefined ? {} : { layout_code: filter.layoutCode }), open_only: filter.openOnly, limit: 100 }) }) as unknown as Promise<LockPage>,
    enabled: key[1] !== undefined,
    retry: false,
  });
}

/**
 * The latest copy of every series of each form for the Ministry: one request for each layout (the list is cut by layout on the server), so a copy of a form is never pushed out of a page by the copies of the other
 * forms. `truncated` says that a layout has more series than one page holds; `failed` that a layout could not be read: the screen never says "no copies" in either case.
 */
export function useMofIssues(codes: readonly string[]) {
  const client = useApiClient();
  const key = useScopeKey();
  const results = useQueries({
    queries: codes.map((code) => ({
      queryKey: [...key, 'mof-issues', code],
      queryFn: () => client.read('listReportIssues', { query: q({ layout_code: code, heads_only: true, limit: 100 }) }) as unknown as Promise<{ items: Issue[]; truncated: boolean }>,
      enabled: key[1] !== undefined,
      retry: false,
    })),
  });
  return {
    items: results.flatMap((result) => result.data?.items ?? []),
    isLoading: results.some((result) => result.isLoading),
    failed: results.some((result) => result.isError),
    truncated: results.some((result) => result.data?.truncated === true),
    refetch: () => Promise.all(results.map((result) => result.refetch())),
    refreshing: results.some((result) => result.isError) && results.some((result) => result.data !== undefined),
  };
}

export function useSignature(issueId: string | undefined) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<SignatureFacts>({
    queryKey: [...key, 'signature', issueId ?? ''],
    queryFn: () => client.read('getReportSignature', { path: path(issueId as string) }) as unknown as Promise<SignatureFacts>,
    enabled: key[1] !== undefined && issueId !== undefined,
    retry: false,
  });
}

/** The certificates of the tenant; a refusal (the person may not read them) leaves the picker empty and the screen asks for the id by hand. */
export function useCertificates(enabled: boolean) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<{ items: CertificateRow[] }>({
    queryKey: [...key, 'certificates'],
    queryFn: () => client.read('get_resources_signing_certificate', { query: q({ limit: 100 }) }) as unknown as Promise<{ items: CertificateRow[] }>,
    enabled: key[1] !== undefined && enabled,
    retry: false,
  });
}

/** One command, one idempotency attempt per intention: the key is kept while the same request is retried and dropped when it ends. */
function useGov12Command<Input, Output = unknown>(send: (input: Input, attempt: ReturnType<AttemptRegistry['forPayload']>) => Promise<Output>) {
  const queryClient = useQueryClient();
  const key = useScopeKey();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: (input: Input) => send(input, attempts.current.forPayload(input)),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: key });
      await queryClient.invalidateQueries({ queryKey: ['rpt'] });
    },
    onError: (error) => attempts.current.ended(error),
  });
}

export function useStartSignature() {
  const client = useApiClient();
  return useGov12Command<{ issueId: string; certificateId: string }, { resource_id: string }>(
    (input, attempt) => client.command('startReportSignature', { path: { id: input.issueId } as never, body: { certificate_id: input.certificateId }, attempt }) as Promise<{ resource_id: string }>,
  );
}

export function useCompleteSignature() {
  const client = useApiClient();
  return useGov12Command<{ sessionId: string }, { status: string }>(
    (input, attempt) => client.command('completeReportSignature', { path: { id: input.sessionId } as never, attempt }) as Promise<{ status: string }>,
  );
}

export function useUnlock() {
  const client = useApiClient();
  return useGov12Command<{ lockId: string; version: number; reason: string }>((input, attempt) =>
    client.command('unlockReportPeriod', { path: { id: input.lockId } as never, body: { reason: input.reason }, ifMatchVersion: input.version, attempt }),
  );
}
