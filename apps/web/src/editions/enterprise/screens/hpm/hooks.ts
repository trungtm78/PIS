import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../../../api/ApiClientContext';
import { AttemptRegistry } from '../../../../api/attempt-registry';
import { useSession } from '../../../../session/SessionContext';
import { PAGE_SIZE, toConnection, toCorrectionPage, toPushPage, toPushResult } from './model';
import type { Connection, CorrectionBody, CorrectionPage, CorrectionState, PushBody, PushPage, PushResult, PushStatus } from './model';

// What the screens show depends on the places the signed-in membership reaches, not only on the tenant: the membership is part of every key.
function useScopeKey(): readonly ['hpm', string | undefined, string | undefined] {
  const { tenant } = useSession();
  return ['hpm', tenant?.id, tenant?.membershipId];
}

const q = (value: Record<string, string | number | undefined>): never => value as never;

/** The connection: status, freshness by the rule, accepted series, counts and what the caller may do. */
export function useHpmConnection() {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<Connection>({
    queryKey: [...key, 'connection'],
    queryFn: async () => toConnection(await client.read('getHpmConnection')),
    enabled: key[1] !== undefined,
    retry: false,
  });
}

/** The push log, newest first, a page at a time (the cursor of the server); a status narrows it. */
export function useHpmPushes(status: PushStatus | undefined) {
  const client = useApiClient();
  const key = useScopeKey();
  return useInfiniteQuery<PushPage, unknown, { pages: PushPage[] }, readonly unknown[], string | undefined>({
    queryKey: [...key, 'pushes', status ?? 'all'],
    initialPageParam: undefined,
    queryFn: async ({ pageParam }) => toPushPage(await client.read('listHpmPushes', { query: q({ ...(status === undefined ? {} : { status }), ...(pageParam === undefined ? {} : { cursor: pageParam }), limit: PAGE_SIZE }) })),
    getNextPageParam: (last) => last.next_cursor ?? undefined,
    enabled: key[1] !== undefined,
    retry: false,
  });
}

/** The corrections, newest first, a page at a time; a state narrows the list. */
export function useHpmCorrections(state: CorrectionState | undefined) {
  const client = useApiClient();
  const key = useScopeKey();
  return useInfiniteQuery<CorrectionPage, unknown, { pages: CorrectionPage[] }, readonly unknown[], string | undefined>({
    queryKey: [...key, 'corrections', state ?? 'all'],
    initialPageParam: undefined,
    queryFn: async ({ pageParam }) => toCorrectionPage(await client.read('listHpmCorrections', { query: q({ ...(state === undefined ? {} : { state }), ...(pageParam === undefined ? {} : { cursor: pageParam }), limit: PAGE_SIZE }) })),
    getNextPageParam: (last) => last.next_cursor ?? undefined,
    enabled: key[1] !== undefined,
    retry: false,
  });
}

/** Everything the HPM screens read is refreshed after a command (the log, the connection and the corrections). */
export function useRefresh(): () => Promise<void> {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ predicate: (query) => query.queryKey[0] === 'hpm' });
}

/** One command of the screens: one idempotency attempt per intention, the reads refreshed after it. */
function useHpmCommand<Input, Output = unknown>(send: (input: Input, attempt: ReturnType<AttemptRegistry['forPayload']>) => Promise<Output>) {
  const refresh = useRefresh();
  const attempts = useRef(new AttemptRegistry());
  return useMutation<Output, unknown, Input>({
    mutationFn: (input) => send(input, attempts.current.forPayload(input)),
    onSuccess: async () => {
      attempts.current.done();
      await refresh();
    },
    onError: (error) => attempts.current.ended(error),
  });
}

export interface SwitchInput {
  enabled: boolean;
  reason: string;
  /** The version of the connection the caller saw: the server refuses the change when it moved (409 VERSION_CONFLICT). */
  version: number;
}

export function useSetHpmConnectionState() {
  const client = useApiClient();
  return useHpmCommand<SwitchInput>((input, attempt) => client.command('setHpmConnectionState', { body: { enabled: input.enabled, reason: input.reason }, ifMatchVersion: input.version, attempt }));
}

export function useSubmitHpmPush() {
  const client = useApiClient();
  return useHpmCommand<PushBody, PushResult>(async (body, attempt) => toPushResult(await client.command('submitHpmPush', { body, attempt })));
}

export interface RetryInput {
  id: string;
  version: number;
}

export function useRetryHpmPush() {
  const client = useApiClient();
  return useHpmCommand<RetryInput, PushResult>(async (input, attempt) => toPushResult(await client.command('retryHpmPush', { path: { id: input.id }, body: {}, ifMatchVersion: input.version, attempt })));
}

export interface ReceiptInput {
  id: string;
  version: number;
  outcome: 'ACCEPTED' | 'REJECTED';
  reference: string;
  note: string;
}

export function useRecordHpmReceipt() {
  const client = useApiClient();
  return useHpmCommand<ReceiptInput>((input, attempt) =>
    client.command('recordHpmReceipt', { path: { id: input.id }, body: { outcome: input.outcome, reference: input.reference, ...(input.note.trim() === '' ? {} : { note: input.note.trim() }) }, ifMatchVersion: input.version, attempt }),
  );
}

export function useProposeHpmCorrection() {
  const client = useApiClient();
  return useHpmCommand<CorrectionBody>((body, attempt) => client.command('proposeHpmCorrection', { body, attempt }));
}

export interface DecideInput {
  id: string;
  version: number;
  decision: 'APPROVE' | 'REJECT';
  reason: string;
}

export function useDecideHpmCorrection() {
  const client = useApiClient();
  return useHpmCommand<DecideInput>((input, attempt) => client.command('decideHpmCorrection', { path: { id: input.id }, body: { decision: input.decision, reason: input.reason }, ifMatchVersion: input.version, attempt }));
}
