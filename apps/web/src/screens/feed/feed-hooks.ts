import { uploadFile } from '@machvon/api-client';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../api/ApiClientContext';
import { AttemptRegistry } from '../../api/attempt-registry';
import { useSession } from '../../session/SessionContext';
import { differenceQueryOf, mappingQueryOf, runQueryOf, toApplied, toConnection, toDifferencePage, toGeneratorReceipt, toMappingPage, toPreview, toReconciliation, toRunDetail, toRunPage, toUnmappedList, toUploadedFile } from './feed-model';
import type {
  Applied,
  Connection,
  DifferenceFilters,
  DifferencePage,
  GeneratorBody,
  GeneratorReceipt,
  Kind,
  MappingFilters,
  MappingPage,
  Preview,
  ProposeBody,
  Reconciliation,
  ResolutionBody,
  RunDetail,
  RunFilters,
  RunPage,
  UnmappedList,
  UploadedFile,
} from './feed-model';

// What a screen shows depends on the places the signed-in membership reaches, not only on the tenant: the membership is part of every key. One root for the five screens, so that a command on one refreshes the others.
export const FEED_ROOT = 'finance-feed';

function useScopeKey(): readonly [typeof FEED_ROOT, string | undefined, string | undefined] {
  const { tenant } = useSession();
  return [FEED_ROOT, tenant?.id, tenant?.membershipId];
}

type Query = Record<string, string | number | undefined>;
const q = (value: Query): never => value as never;

/** The connection of the tenant: status, channels, health, quality, generator and what the caller may do. Read by every screen for the rights of the caller. */
export function useFeedConnection() {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<Connection>({
    queryKey: [...key, 'connection'],
    queryFn: async () => toConnection(await client.read('getFinanceFeedConnection')),
    enabled: key[1] !== undefined,
    retry: false,
  });
}

/** Everything the feed screens read is refreshed after a command (the lists, their counts, the connection). */
export function useReload(): () => Promise<void> {
  const queryClient = useQueryClient();
  const key = useScopeKey();
  return () => queryClient.invalidateQueries({ queryKey: [key[0], key[1], key[2]] });
}

/** One command of a screen: one idempotency attempt per intention, the reads refreshed after it, a lost answer retried under the same key. */
function useFeedCommand<Input, Output = unknown>(send: (input: Input, attempt: ReturnType<AttemptRegistry['forPayload']>) => Promise<Output>) {
  const reload = useReload();
  const attempts = useRef(new AttemptRegistry());
  return useMutation<Output, unknown, Input>({
    mutationFn: (input) => send(input, attempts.current.forPayload(input)),
    onSuccess: async () => {
      attempts.current.done();
      await reload();
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

export function useSetState() {
  const client = useApiClient();
  return useFeedCommand<SwitchInput>((input, attempt) => client.command('setFinanceFeedConnectionState', { body: { enabled: input.enabled, reason: input.reason }, ifMatchVersion: input.version, attempt }));
}

export interface GeneratorInput {
  body: GeneratorBody;
  version: number;
}

export function useControlGenerator() {
  const client = useApiClient();
  return useFeedCommand<GeneratorInput, GeneratorReceipt | undefined>(async (input, attempt) => toGeneratorReceipt(await client.command('controlFinanceFeedGenerator', { body: input.body, ifMatchVersion: input.version, attempt })));
}

// ---- files and runs ---------------------------------------------------------------------------------------------------------------------------------------------------

/** Puts the file into the shared upload pipeline (judged by its bytes, scanned): the answer names its key, its hash, its columns and the kinds it fits. */
export function useUploadFeedFile() {
  const client = useApiClient();
  const attempts = useRef(new AttemptRegistry());
  return useMutation<UploadedFile | undefined, unknown, File>({
    mutationFn: async (file) => toUploadedFile(await uploadFile(client, 'uploadFinanceFeedFile', { file, attempt: attempts.current.forPayload({ name: file.name, size: file.size, type: file.type, modified: file.lastModified }) })),
    onSuccess: () => attempts.current.done(),
    onError: (error) => attempts.current.ended(error),
  });
}

export interface ImportInput {
  kind: Kind;
  fileObjectKey: string;
  fileSha256: string;
}

const bodyOf = (input: ImportInput) => ({ kind: input.kind, file_object_key: input.fileObjectKey, file_sha256: input.fileSha256 });

/** The dry run: reads the stored file exactly as the apply will and writes nothing. */
export function usePreviewFeedFile() {
  const client = useApiClient();
  const attempts = useRef(new AttemptRegistry());
  return useMutation<Preview | undefined, unknown, ImportInput>({
    mutationFn: async (input) => toPreview(await client.command('previewFinanceFeedFile', { body: bodyOf(input), attempt: attempts.current.forPayload(input) }), new Date().toISOString()),
    onSuccess: () => attempts.current.done(),
    onError: (error) => attempts.current.ended(error),
  });
}

/** The apply: once per file; a success refreshes the runs and the connection. */
export function useApplyFeedFile() {
  const client = useApiClient();
  return useFeedCommand<ImportInput, Applied | undefined>(async (input, attempt) => toApplied(await client.command('importFinanceFeedFile', { body: bodyOf(input), attempt })));
}

/** The runs, newest first, a page at a time (the cursor of the server); the channel and the kind narrow the list. */
export function useFeedRuns(filters: RunFilters) {
  const client = useApiClient();
  const key = useScopeKey();
  return useInfiniteQuery<RunPage, Error, { pages: RunPage[] }, readonly unknown[], string | undefined>({
    queryKey: [...key, 'runs', filters],
    initialPageParam: undefined,
    queryFn: async ({ pageParam }) => toRunPage(await client.read('listFinanceFeedRuns', { query: q(runQueryOf(filters, pageParam)) })),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: key[1] !== undefined,
    retry: false,
  });
}

/** One run with the rows it refused (masked). */
export function useFeedRun(id: string | undefined) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<RunDetail>({
    queryKey: [...key, 'run', id],
    queryFn: async () => toRunDetail(await client.read('getFinanceFeedRun', { path: { id } as never })),
    enabled: key[1] !== undefined && id !== undefined,
    retry: false,
  });
}

// ---- the code mapping -------------------------------------------------------------------------------------------------------------------------------------------------

export function useFeedMappings(filters: MappingFilters) {
  const client = useApiClient();
  const key = useScopeKey();
  return useInfiniteQuery<MappingPage, Error, { pages: MappingPage[] }, readonly unknown[], string | undefined>({
    queryKey: [...key, 'mappings', filters],
    initialPageParam: undefined,
    queryFn: async ({ pageParam }) => toMappingPage(await client.read('listFinanceFeedMappings', { query: q(mappingQueryOf(filters, pageParam)) })),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: key[1] !== undefined,
    retry: false,
  });
}

/** The project codes of the feed that no mapping holds yet: the work waiting for a person. */
export function useUnmapped() {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<UnmappedList>({
    queryKey: [...key, 'unmapped'],
    queryFn: async () => toUnmappedList(await client.read('listFinanceFeedUnmapped', { query: q({ limit: 50 }) })),
    enabled: key[1] !== undefined,
    retry: false,
  });
}

export function usePropose() {
  const client = useApiClient();
  return useFeedCommand<ProposeBody>((body, attempt) => client.command('proposeFinanceFeedMapping', { body, attempt }));
}

export interface DecideInput {
  id: string;
  version: number;
  decision: 'APPROVE' | 'REJECT';
  reason: string;
}

export function useDecide() {
  const client = useApiClient();
  return useFeedCommand<DecideInput>((input, attempt) => client.command('decideFinanceFeedMapping', { path: { id: input.id }, body: { decision: input.decision, reason: input.reason }, ifMatchVersion: input.version, attempt }));
}

export interface RetireInput {
  id: string;
  version: number;
  reason: string;
}

export function useRetire() {
  const client = useApiClient();
  return useFeedCommand<RetireInput>((input, attempt) => client.command('retireFinanceFeedMapping', { path: { id: input.id }, body: { reason: input.reason }, ifMatchVersion: input.version, attempt }));
}

// ---- the differences --------------------------------------------------------------------------------------------------------------------------------------------------

export function useFeedDifferences(filters: DifferenceFilters) {
  const client = useApiClient();
  const key = useScopeKey();
  return useInfiniteQuery<DifferencePage, Error, { pages: DifferencePage[] }, readonly unknown[], string | undefined>({
    queryKey: [...key, 'differences', filters],
    initialPageParam: undefined,
    queryFn: async ({ pageParam }) => toDifferencePage(await client.read('listFinanceFeedDifferences', { query: q(differenceQueryOf(filters, pageParam)) })),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: key[1] !== undefined,
    retry: false,
  });
}

export interface ReconcileInput {
  fiscal_year: number;
  owner_id?: string;
}

export function useReconcile() {
  const client = useApiClient();
  return useFeedCommand<ReconcileInput, Reconciliation | undefined>(async (body, attempt) => toReconciliation(await client.command('runFinanceFeedReconciliation', { body, attempt })));
}

export interface ResolveInput {
  id: string;
  version: number;
  body: ResolutionBody;
}

export function useResolve() {
  const client = useApiClient();
  return useFeedCommand<ResolveInput>((input, attempt) => client.command('resolveFinanceFeedDifference', { path: { id: input.id }, body: input.body, ifMatchVersion: input.version, attempt }));
}
