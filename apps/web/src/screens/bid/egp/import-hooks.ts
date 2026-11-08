import { uploadFile } from '@machvon/api-client';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../../api/ApiClientContext';
import { AttemptRegistry } from '../../../api/attempt-registry';
import { useSession } from '../../../session/SessionContext';
import { HISTORY_PAGE_SIZE, toApplied, toConnection, toPreview, toRunDetail, toRunPage, toUploadedFile } from './import-model';
import type { Applied, Connection, Kind, Preview, RunDetail, RunPage, UploadedFile } from './import-model';

// What the screen shows depends on the places the signed-in membership reaches, not only on the tenant: the membership is part of every key.
function useScopeKey(): readonly ['egp-import', string | undefined, string | undefined] {
  const { tenant } = useSession();
  return ['egp-import', tenant?.id, tenant?.membershipId];
}

const q = (value: Record<string, string | number | undefined>): never => value as never;

/** The connection of the tenant: which layouts exist, whether a dry run and an apply are allowed to the caller, whether the connection is switched on. */
export function useEgpConnection() {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<Connection | undefined>({
    queryKey: [...key, 'connection'],
    queryFn: async () => toConnection(await client.read('getEgpConnection')),
    enabled: key[1] !== undefined,
    retry: false,
  });
}

/** Puts the file into the shared upload pipeline (judged by its bytes, scanned): the answer names its key, its hash, its columns and the kinds it fits. */
export function useUploadEgpFile() {
  const client = useApiClient();
  const attempts = useRef(new AttemptRegistry());
  return useMutation<UploadedFile | undefined, unknown, File>({
    mutationFn: async (file) => toUploadedFile(await uploadFile(client, 'uploadEgpFile', { file, attempt: attempts.current.forPayload({ name: file.name, size: file.size, type: file.type, modified: file.lastModified }) })),
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
export function usePreviewEgpFile() {
  const client = useApiClient();
  const attempts = useRef(new AttemptRegistry());
  return useMutation<Preview | undefined, unknown, ImportInput>({
    mutationFn: async (input) => toPreview(await client.command('previewEgpFile', { body: bodyOf(input), attempt: attempts.current.forPayload(input) }), new Date().toISOString()),
    onSuccess: () => attempts.current.done(),
    onError: (error) => attempts.current.ended(error),
  });
}

/** The apply: once per file; a success refreshes the history and the connection (the last import it shows). */
export function useApplyEgpFile() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const key = useScopeKey();
  const attempts = useRef(new AttemptRegistry());
  return useMutation<Applied | undefined, unknown, ImportInput>({
    mutationFn: async (input) => toApplied(await client.command('importEgpFile', { body: bodyOf(input), attempt: attempts.current.forPayload(input) })),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: key });
    },
    onError: (error) => attempts.current.ended(error),
  });
}

/** The past runs, newest first, a page at a time (the cursor of the server); a kind narrows the list. */
export function useEgpImportHistory(kind: Kind | undefined) {
  const client = useApiClient();
  const key = useScopeKey();
  return useInfiniteQuery<RunPage, unknown, { pages: RunPage[] }, readonly unknown[], string | undefined>({
    queryKey: [...key, 'runs', kind ?? 'all'],
    queryFn: async ({ pageParam }) => toRunPage(await client.read('listEgpImports', { query: q({ ...(kind === undefined ? {} : { kind }), ...(pageParam === undefined ? {} : { cursor: pageParam }), limit: HISTORY_PAGE_SIZE }) })),
    initialPageParam: undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: key[1] !== undefined,
    retry: false,
  });
}

/** One run with the rows it refused (masked). */
export function useEgpImportDetail(id: string | undefined) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<RunDetail | undefined>({
    queryKey: [...key, 'run', id],
    queryFn: async () => toRunDetail(await client.read('getEgpImport', { path: { id } as never })),
    enabled: key[1] !== undefined && id !== undefined,
    retry: false,
  });
}
