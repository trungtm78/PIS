import { ApiError, uploadFile } from '@machvon/api-client';
import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../../api/ApiClientContext';
import { AttemptRegistry } from '../../../api/attempt-registry';
import { useSession } from '../../../session/SessionContext';
import { filterQuery, toIncomingLine, toIncomingPage } from './model';
import type { AssignBody, IncomingFilter, IncomingLine, IncomingPage, ReceiveBody } from './model';

export const INCOMING_PAGE = 50;

// What the screen shows depends on what the signed-in membership may see, not only on the tenant: the membership is part of every key.
function useScopeKey(): readonly ['doc-incoming', string | undefined, string | undefined] {
  const { tenant } = useSession();
  return ['doc-incoming', tenant?.id, tenant?.membershipId];
}

/** The letters in the scope of the caller, the latest first, a page at a time; a new filter keeps the list on the screen until the new one is there. */
export function useIncomings(filter: IncomingFilter) {
  const client = useApiClient();
  const key = useScopeKey();
  return useInfiniteQuery<IncomingPage, Error, { pages: IncomingPage[] }, readonly unknown[], string | undefined>({
    queryKey: [...key, 'list', filter],
    initialPageParam: undefined,
    queryFn: async ({ pageParam }) => toIncomingPage(await client.read('listIncomingDocuments', { query: { limit: INCOMING_PAGE, ...filterQuery(filter), ...(pageParam === undefined ? {} : { cursor: pageParam }) } })),
    getNextPageParam: (last) => last.next,
    placeholderData: keepPreviousData,
    enabled: key[1] !== undefined,
    retry: false,
  });
}

/** One letter with its history; nothing is read until one is named. */
export function useIncoming(id: string | undefined) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<IncomingLine | null>({
    queryKey: [...key, 'one', id],
    queryFn: async () => toIncomingLine(await client.read('getIncomingDocument', { path: { id: id as string } })) ?? null,
    enabled: key[1] !== undefined && id !== undefined,
    retry: false,
  });
}

/** One mutation hook: one idempotency attempt per intention, the reads of the letters refreshed once it succeeds. */
function useCommand<Input, Output = unknown>(send: (input: Input, attempt: ReturnType<AttemptRegistry['forPayload']>) => Promise<Output>) {
  const queryClient = useQueryClient();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: (input: Input) => send(input, attempts.current.forPayload(input)),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ predicate: (query) => query.queryKey[0] === 'doc-incoming' });
    },
    onError: async (error) => {
      attempts.current.ended(error);
      // The letter changed meanwhile (another person, the hourly job): read it again, so that the next try is made under the version that is there.
      if (error instanceof ApiError && error.code === 'VERSION_CONFLICT') await queryClient.invalidateQueries({ predicate: (query) => query.queryKey[0] === 'doc-incoming' });
    },
  });
}

export interface UploadedFile {
  key: string;
  sha256: string;
}

/** Puts the PDF into the shared upload pipeline of DOC; one attempt per file, so a retry of the same file reuses its key. */
export function useUploadLetter() {
  const client = useApiClient();
  const attempts = useRef(new AttemptRegistry());
  return useMutation<UploadedFile | undefined, unknown, File>({
    mutationFn: async (file) => {
      const answer = await uploadFile(client, 'uploadDocumentFile', { file, attempt: attempts.current.forPayload({ name: file.name, size: file.size, type: file.type, modified: file.lastModified }) });
      const body = answer as unknown as { file_object_key?: unknown; file_sha256?: unknown } | undefined;
      return typeof body?.file_object_key === 'string' && typeof body.file_sha256 === 'string' ? { key: body.file_object_key, sha256: body.file_sha256 } : undefined;
    },
    onSuccess: () => attempts.current.done(),
    onError: (error) => attempts.current.ended(error),
  });
}

export function useReceiveLetter() {
  const client = useApiClient();
  return useCommand<ReceiveBody, { resource_id?: string }>(async (body, attempt) => (await client.command('receiveIncomingDocument', { body, attempt })) as { resource_id?: string });
}

export interface VersionedInput<Body = undefined> {
  id: string;
  version: number;
  body?: Body;
}

/** Registers a letter; with no register named, the server takes the only open one of the caller. */
export function useRegisterLetter() {
  const client = useApiClient();
  return useCommand<VersionedInput<{ register_id?: string }>>((input, attempt) => client.command('registerIncomingDocument', { path: { id: input.id }, body: input.body ?? {}, ifMatchVersion: input.version, attempt }));
}

export function useAssignLetter() {
  const client = useApiClient();
  return useCommand<VersionedInput<AssignBody>>((input, attempt) => client.command('assignIncomingDocument', { path: { id: input.id }, body: input.body as AssignBody, ifMatchVersion: input.version, attempt }));
}

export function useStartLetter() {
  const client = useApiClient();
  return useCommand<VersionedInput>((input, attempt) => client.command('startIncomingDocumentProcessing', { path: { id: input.id }, ifMatchVersion: input.version, attempt }));
}

export function useResolveLetter() {
  const client = useApiClient();
  return useCommand<VersionedInput<{ resolution_summary: string }>>((input, attempt) => client.command('resolveIncomingDocument', { path: { id: input.id }, body: input.body as { resolution_summary: string }, ifMatchVersion: input.version, attempt }));
}

export function useRejectLetter() {
  const client = useApiClient();
  return useCommand<VersionedInput<{ rejection_reason: string; duplicate_of_id?: string }>>((input, attempt) => client.command('rejectIncomingDocument', { path: { id: input.id }, body: input.body as { rejection_reason: string; duplicate_of_id?: string }, ifMatchVersion: input.version, attempt }));
}
