import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../api/ApiClientContext';
import { AttemptRegistry } from '../../api/attempt-registry';
import { useSession } from '../../session/SessionContext';
import { queryOf } from './int-model';
import type { BiReaderDetail, BiReaderPage, ExportDatasetList, MachineAccount, MachineAccountPage, OpenAccessLogPage, ProjectCodePage, SourceSystemList } from './int-model';

const ROOT = 'int';

// What the screens show depends on the places the signed-in membership reaches, not only on the tenant: the membership is part of every key.
function useScopeKey(): readonly [string, string | undefined, string | undefined] {
  const { tenant } = useSession();
  return [ROOT, tenant?.id, tenant?.membershipId];
}

const q = (value: Record<string, string | number | undefined>): never => value as never;

type Filters = Readonly<Record<string, string | undefined>>;

export function useMachineAccounts(filters: Filters) {
  const client = useApiClient();
  const key = useScopeKey();
  return useInfiniteQuery<MachineAccountPage, Error, { pages: MachineAccountPage[] }, readonly unknown[], string | undefined>({
    queryKey: [...key, 'accounts', filters],
    initialPageParam: undefined,
    queryFn: async ({ pageParam }) => (await client.read('listMachineAccounts', { query: q(queryOf(filters, pageParam)) })) as MachineAccountPage,
    getNextPageParam: (last) => last.next_cursor ?? undefined,
    enabled: key[1] !== undefined,
    retry: false,
  });
}

export function useMachineAccount(id: string | undefined) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<MachineAccount>({
    queryKey: [...key, 'account', id],
    queryFn: async () => (await client.read('getMachineAccount', { path: { id: id as string } })) as MachineAccount,
    enabled: key[1] !== undefined && id !== undefined,
    retry: false,
  });
}

export function useAccessLog(filters: Filters) {
  const client = useApiClient();
  const key = useScopeKey();
  return useInfiniteQuery<OpenAccessLogPage, Error, { pages: OpenAccessLogPage[] }, readonly unknown[], string | undefined>({
    queryKey: [...key, 'log', filters],
    initialPageParam: undefined,
    queryFn: async ({ pageParam }) => (await client.read('listOpenAccessLog', { query: q(queryOf(filters, pageParam)) })) as OpenAccessLogPage,
    getNextPageParam: (last) => last.next_cursor ?? undefined,
    enabled: key[1] !== undefined,
    retry: false,
  });
}

export function useExportDatasets() {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<ExportDatasetList>({ queryKey: [...key, 'datasets'], queryFn: async () => (await client.read('listExportDatasets')) as ExportDatasetList, enabled: key[1] !== undefined, retry: false });
}

export function useBiReaders() {
  const client = useApiClient();
  const key = useScopeKey();
  return useInfiniteQuery<BiReaderPage, Error, { pages: BiReaderPage[] }, readonly unknown[], string | undefined>({
    queryKey: [...key, 'readers'],
    initialPageParam: undefined,
    queryFn: async ({ pageParam }) => (await client.read('listBiReaders', { query: q(queryOf({}, pageParam)) })) as BiReaderPage,
    getNextPageParam: (last) => last.next_cursor ?? undefined,
    enabled: key[1] !== undefined,
    retry: false,
  });
}

export function useBiReader(id: string | undefined) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<BiReaderDetail>({
    queryKey: [...key, 'reader', id],
    queryFn: async () => (await client.read('getBiReader', { path: { id: id as string } })) as BiReaderDetail,
    enabled: key[1] !== undefined && id !== undefined,
    retry: false,
  });
}

export function useSourceSystems() {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<SourceSystemList>({ queryKey: [...key, 'systems'], queryFn: async () => (await client.read('listSourceSystems')) as SourceSystemList, enabled: key[1] !== undefined, retry: false });
}

export function useProjectCodes(filters: Filters) {
  const client = useApiClient();
  const key = useScopeKey();
  return useInfiniteQuery<ProjectCodePage, Error, { pages: ProjectCodePage[] }, readonly unknown[], string | undefined>({
    queryKey: [...key, 'codes', filters],
    initialPageParam: undefined,
    queryFn: async ({ pageParam }) => (await client.read('listProjectCodes', { query: q(queryOf(filters, pageParam)) })) as ProjectCodePage,
    getNextPageParam: (last) => last.next_cursor ?? undefined,
    enabled: key[1] !== undefined,
    retry: false,
  });
}

/** Everything the integration screens read is refreshed after a command changed something. */
export function useRefresh(): () => Promise<void> {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ predicate: (query) => query.queryKey[0] === ROOT });
}

/** One command of the screens: one idempotency attempt per intention, the reads refreshed after it. The answer goes to the caller only (a secret in it is never kept here). */
function useIntCommand<Input, Output>(send: (input: Input, attempt: ReturnType<AttemptRegistry['forPayload']>) => Promise<Output>) {
  const refresh = useRefresh();
  const attempts = useRef(new AttemptRegistry());
  return useMutation<Output, unknown, Input>({
    mutationFn: (input) => send(input, attempts.current.forPayload(input)),
    onSuccess: async () => {
      attempts.current.done();
      await refresh();
    },
    onError: (error) => attempts.current.ended(error),
    // The answer of a command may hold a secret shown once: the cache keeps nothing of it.
    gcTime: 0,
  });
}

export interface Versioned {
  id: string;
  version: number;
}

export function useCreateAccount() {
  const client = useApiClient();
  return useIntCommand((body: { name: string; description?: string; scopes: string[]; rate_limit_per_minute?: number; expires_on?: string }, attempt) => client.command('createMachineAccount', { body, attempt }));
}

export function useUpdateAccount() {
  const client = useApiClient();
  return useIntCommand((input: Versioned & { body: { description?: string | null; scopes?: string[]; rate_limit_per_minute?: number; expires_on?: string | null; reason: string } }, attempt) =>
    client.command('updateMachineAccount', { path: { id: input.id }, body: input.body, ifMatchVersion: input.version, attempt }),
  );
}

export function useDecideAccount() {
  const client = useApiClient();
  return useIntCommand((input: Versioned & { decision: 'SUSPEND' | 'REACTIVATE' | 'REVOKE'; reason: string }, attempt) =>
    client.command('decideMachineAccount', { path: { id: input.id }, body: { decision: input.decision, reason: input.reason }, ifMatchVersion: input.version, attempt }),
  );
}

export function useRotateAccount() {
  const client = useApiClient();
  return useIntCommand((input: Versioned & { reason: string; graceHours: number }, attempt) =>
    client.command('rotateMachineCredential', { path: { id: input.id }, body: { reason: input.reason, grace_hours: input.graceHours }, ifMatchVersion: input.version, attempt }),
  );
}

export function useSetDataset() {
  const client = useApiClient();
  return useIntCommand((input: { version: number; datasetCode: 'DS-DISB' | 'DS-CTR' | 'DS-ENT'; enabled: boolean; productId: string | undefined; reason: string }, attempt) =>
    client.command('setExportDataset', {
      body: { dataset_code: input.datasetCode, enabled: input.enabled, ...(input.productId === undefined ? {} : { product_id: input.productId }), reason: input.reason },
      ifMatchVersion: input.version,
      attempt,
    }),
  );
}

export function useCreateReader() {
  const client = useApiClient();
  return useIntCommand((body: { name: string; tool?: string; connection_limit?: number }, attempt) => client.command('createBiReader', { body, attempt }));
}

export function useRotateReader() {
  const client = useApiClient();
  return useIntCommand((input: Versioned & { reason: string }, attempt) => client.command('rotateBiReaderPassword', { path: { id: input.id }, body: { reason: input.reason }, ifMatchVersion: input.version, attempt }));
}

export function useDecideReader() {
  const client = useApiClient();
  return useIntCommand((input: Versioned & { decision: 'SUSPEND' | 'REACTIVATE' | 'RETIRE'; reason: string }, attempt) =>
    client.command('decideBiReader', { path: { id: input.id }, body: { decision: input.decision, reason: input.reason }, ifMatchVersion: input.version, attempt }),
  );
}

export function useRegisterSystem() {
  const client = useApiClient();
  return useIntCommand((body: { code: string; name: string; kind: 'PMIS' | 'ERP' | 'FINANCE' | 'LAKEHOUSE' | 'GOV_PORTAL' | 'OTHER'; code_pattern?: string }, attempt) => client.command('registerSourceSystem', { body, attempt }));
}

export function useRetireSystem() {
  const client = useApiClient();
  return useIntCommand((input: Versioned & { reason: string }, attempt) => client.command('retireSourceSystem', { path: { id: input.id }, body: { reason: input.reason }, ifMatchVersion: input.version, attempt }));
}

export function useProposeCode() {
  const client = useApiClient();
  return useIntCommand((body: { source_system: string; our_code: string; external_code: string; valid_from?: string; valid_until?: string; reason: string }, attempt) => client.command('proposeProjectCode', { body, attempt }));
}

export function useDecideCode() {
  const client = useApiClient();
  return useIntCommand((input: Versioned & { decision: 'APPROVE' | 'REJECT'; reason: string }, attempt) =>
    client.command('decideProjectCode', { path: { id: input.id }, body: { decision: input.decision, reason: input.reason }, ifMatchVersion: input.version, attempt }),
  );
}

export function useRetireCode() {
  const client = useApiClient();
  return useIntCommand((input: Versioned & { reason: string }, attempt) => client.command('retireProjectCode', { path: { id: input.id }, body: { reason: input.reason }, ifMatchVersion: input.version, attempt }));
}
