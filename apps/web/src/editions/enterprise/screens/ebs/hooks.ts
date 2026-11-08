import { uploadFile } from '@machvon/api-client';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../../../api/ApiClientContext';
import { AttemptRegistry } from '../../../../api/attempt-registry';
import { useSession } from '../../../../session/SessionContext';
import { queryOf, toApplied, toConnection, toDifferencePage, toPreview, toReconciled, toUpload } from './model';
import type { Applied, Connection, DifferencePage, Filters, Preview, ReconcileBody, Reconciled, ResolveBody, Upload } from './model';

// What the screens show depends on the places the signed-in membership reaches, not only on the tenant: the membership is part of every key.
function useScopeKey(): readonly ['ebs', string | undefined, string | undefined] {
  const { tenant } = useSession();
  return ['ebs', tenant?.id, tenant?.membershipId];
}

const q = (value: Record<string, string | number | undefined>): never => value as never;

/** The connection: status, freshness by the rule, the layout, the runs, the counts of the differences and what the caller may do. */
export function useEbsConnection() {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<Connection>({
    queryKey: [...key, 'connection'],
    queryFn: async () => toConnection(await client.read('getEbsConnection')),
    enabled: key[1] !== undefined,
    retry: false,
  });
}

/** The differences by due time, a page at a time (the cursor of the server); the filters narrow the list. */
export function useEbsDifferences(filters: Filters) {
  const client = useApiClient();
  const key = useScopeKey();
  return useInfiniteQuery<DifferencePage, unknown, { pages: DifferencePage[] }, readonly unknown[], string | undefined>({
    queryKey: [...key, 'differences', filters],
    initialPageParam: undefined,
    queryFn: async ({ pageParam }) => toDifferencePage(await client.read('listEbsDifferences', { query: q(queryOf(filters, pageParam)) })),
    getNextPageParam: (last) => last.next_cursor ?? undefined,
    enabled: key[1] !== undefined,
    retry: false,
  });
}

/** Everything the EBS screens read is refreshed after a command (the connection, the runs and the differences). */
export function useRefresh(): () => Promise<void> {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ predicate: (query) => query.queryKey[0] === 'ebs' });
}

function useEbsCommand<Input, Output = unknown>(send: (input: Input, attempt: ReturnType<AttemptRegistry['forPayload']>) => Promise<Output>) {
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

export function useSetEbsConnectionState() {
  const client = useApiClient();
  return useEbsCommand<SwitchInput>((input, attempt) => client.command('setEbsConnectionState', { body: { enabled: input.enabled, reason: input.reason }, ifMatchVersion: input.version, attempt }));
}

/** Puts the file into the shared upload pipeline (judged by its bytes, scanned): the answer names its key, its hash and whether it has the columns of the layout. */
export function useUploadEbsFile() {
  const client = useApiClient();
  const attempts = useRef(new AttemptRegistry());
  return useMutation<Upload, unknown, File>({
    mutationFn: async (file) => toUpload(await uploadFile(client, 'uploadEbsFile', { file, attempt: attempts.current.forPayload({ name: file.name, size: file.size, type: file.type, modified: file.lastModified }) })),
    onSuccess: () => attempts.current.done(),
    onError: (error) => attempts.current.ended(error),
  });
}

export interface ImportInput {
  fileObjectKey: string;
  fileSha256: string;
}

const bodyOf = (input: ImportInput) => ({ file_object_key: input.fileObjectKey, file_sha256: input.fileSha256 });

/** The dry run: reads the stored file exactly as the apply will and writes nothing. */
export function usePreviewEbsFile() {
  const client = useApiClient();
  const attempts = useRef(new AttemptRegistry());
  return useMutation<Preview, unknown, ImportInput>({
    mutationFn: async (input) => toPreview(await client.command('previewEbsFile', { body: bodyOf(input), attempt: attempts.current.forPayload(input) })),
    onSuccess: () => attempts.current.done(),
    onError: (error) => attempts.current.ended(error),
  });
}

/** The apply: once per file; a success refreshes the connection (the last import it shows) and the differences. */
export function useApplyEbsFile() {
  const client = useApiClient();
  return useEbsCommand<ImportInput, Applied>(async (input, attempt) => toApplied(await client.command('importEbsFile', { body: bodyOf(input), attempt })));
}

export function useReconcileEbs() {
  const client = useApiClient();
  return useEbsCommand<ReconcileBody, Reconciled>(async (body, attempt) => toReconciled(await client.command('reconcileEbs', { body, attempt })));
}

export interface ResolveInput {
  id: string;
  version: number;
  body: ResolveBody;
}

export function useResolveEbsDifference() {
  const client = useApiClient();
  return useEbsCommand<ResolveInput>((input, attempt) => client.command('resolveEbsDifference', { path: { id: input.id }, body: input.body, ifMatchVersion: input.version, attempt }));
}

export interface ReassignInput {
  id: string;
  version: number;
  ownerId: string;
}

export function useReassignEbsDifference() {
  const client = useApiClient();
  return useEbsCommand<ReassignInput>((input, attempt) => client.command('reassignEbsDifference', { path: { id: input.id }, body: { owner_id: input.ownerId }, ifMatchVersion: input.version, attempt }));
}
