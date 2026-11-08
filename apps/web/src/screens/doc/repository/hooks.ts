import { uploadFile } from '@machvon/api-client';
import type { components } from '@machvon/contracts';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../../api/ApiClientContext';
import { AttemptRegistry } from '../../../api/attempt-registry';
import type { AttemptRegistry as Registry } from '../../../api/attempt-registry';
import { useSession } from '../../../session/SessionContext';
import {
  PAGE_SIZE,
  UNIT_PAGE_SIZE,
  toCommentList,
  toComparison,
  toDocumentDetail,
  toDocumentPage,
  toDownload,
  toLinkOption,
  toReviewDetail,
  toReviewPage,
  toUnitPage,
  toUploaded,
  toVersionDetail,
} from './model';
import type { CommentList, Comparison, DocumentDetail, DocumentPage, DownloadLink, LinkOption, ReviewDetail, ReviewPage, UnitPage, UploadedFile, VersionDetail } from './model';

type Schemas = components['schemas'];

// What the screens show depends on the places the signed-in membership reaches, not only on the tenant: the membership is part of every key.
function useScopeKey(): readonly ['doc-repo', string | undefined, string | undefined] {
  const { tenant } = useSession();
  return ['doc-repo', tenant?.id, tenant?.membershipId];
}

const q = (value: Record<string, string | number | undefined>): never => value as never;
const at = (path: Record<string, string>): never => path as never;
const defined = (value: Record<string, string | undefined>): Record<string, string> => Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => entry[1] !== undefined && entry[1] !== ''));

export interface DocumentFilter {
  projectId?: string | undefined;
  contractId?: string | undefined;
  packageId?: string | undefined;
  docClass?: string | undefined;
  status?: string | undefined;
  effective?: string | undefined;
  reviewStatus?: string | undefined;
  q?: string | undefined;
}

/** The documents of the scope, newest first, a page at a time (the cursor of the server). */
export function useDocuments(filter: DocumentFilter, enabled: boolean) {
  const client = useApiClient();
  const key = useScopeKey();
  return useInfiniteQuery<DocumentPage, unknown, { pages: DocumentPage[] }, readonly unknown[], string | undefined>({
    queryKey: [...key, 'documents', filter],
    queryFn: async ({ pageParam }) =>
      toDocumentPage(
        await client.read('listProjectDocuments', {
          query: q({
            ...defined({ project_id: filter.projectId, contract_id: filter.contractId, package_id: filter.packageId, doc_class: filter.docClass, status: filter.status, effective: filter.effective, review_status: filter.reviewStatus, q: filter.q, cursor: pageParam }),
            limit: PAGE_SIZE,
          }),
        }),
      ),
    initialPageParam: undefined,
    getNextPageParam: (last) => last.next_cursor ?? undefined,
    enabled: enabled && key[1] !== undefined,
    retry: false,
  });
}

export function useDocument(id: string | undefined) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<DocumentDetail>({
    queryKey: [...key, 'document', id],
    queryFn: async () => toDocumentDetail(await client.read('getProjectDocument', { path: at({ id: id ?? '' }) })),
    enabled: key[1] !== undefined && id !== undefined,
    retry: false,
  });
}

export function useVersion(id: string | undefined) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<VersionDetail>({
    queryKey: [...key, 'version', id],
    queryFn: async () => toVersionDetail(await client.read('getProjectDocumentVersion', { path: at({ id: id ?? '' }) })),
    enabled: key[1] !== undefined && id !== undefined,
    retry: false,
  });
}

export interface UnitFilter {
  page?: number | undefined;
  sheet?: string | undefined;
  q?: string | undefined;
}

/** The units of a version in reading order, a page at a time. */
export function useUnits(versionId: string | undefined, filter: UnitFilter) {
  const client = useApiClient();
  const key = useScopeKey();
  return useInfiniteQuery<UnitPage, unknown, { pages: UnitPage[] }, readonly unknown[], string | undefined>({
    queryKey: [...key, 'units', versionId, filter],
    queryFn: async ({ pageParam }) =>
      toUnitPage(
        await client.read('listDocumentTextUnits', {
          path: at({ id: versionId ?? '' }),
          query: q({ ...(filter.page === undefined ? {} : { page: filter.page }), ...defined({ sheet: filter.sheet, q: filter.q, cursor: pageParam }), limit: UNIT_PAGE_SIZE }),
        }),
      ),
    initialPageParam: undefined,
    getNextPageParam: (last) => last.next_cursor ?? undefined,
    enabled: key[1] !== undefined && versionId !== undefined,
    retry: false,
  });
}

export function useComments(versionId: string | undefined) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<CommentList>({
    queryKey: [...key, 'comments', versionId],
    queryFn: async () => toCommentList(await client.read('listDocumentComments', { path: at({ id: versionId ?? '' }) })),
    enabled: key[1] !== undefined && versionId !== undefined,
    retry: false,
  });
}

export function useComparison(documentId: string | undefined, from: string | undefined, to: string | undefined) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<Comparison>({
    queryKey: [...key, 'comparison', documentId, from, to],
    queryFn: async () => toComparison(await client.read('compareDocumentVersions', { path: at({ id: documentId ?? '' }), query: q({ from_version_id: from, to_version_id: to }) })),
    enabled: key[1] !== undefined && documentId !== undefined && from !== undefined && to !== undefined && from !== to,
    retry: false,
  });
}

export interface ReviewFilter {
  projectId?: string | undefined;
  documentId?: string | undefined;
  status?: string | undefined;
}

export function useReviews(filter: ReviewFilter, enabled: boolean) {
  const client = useApiClient();
  const key = useScopeKey();
  return useInfiniteQuery<ReviewPage, unknown, { pages: ReviewPage[] }, readonly unknown[], string | undefined>({
    queryKey: [...key, 'reviews', filter],
    queryFn: async ({ pageParam }) =>
      toReviewPage(await client.read('listDocumentReviews', { query: q({ ...defined({ project_id: filter.projectId, document_id: filter.documentId, status: filter.status, cursor: pageParam }), limit: PAGE_SIZE }) })),
    initialPageParam: undefined,
    getNextPageParam: (last) => last.next_cursor ?? undefined,
    enabled: enabled && key[1] !== undefined,
    retry: false,
  });
}

export function useReview(id: string | undefined) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<ReviewDetail>({
    queryKey: [...key, 'review', id],
    queryFn: async () => toReviewDetail(await client.read('getDocumentReview', { path: at({ id: id ?? '' }) })),
    enabled: key[1] !== undefined && id !== undefined,
    retry: false,
  });
}

/** The projects, contracts or packages a document can be filed under (what the register of each lists; the server judges the link again). */
export function useLinkOptions(kind: 'project' | 'contract' | 'package', enabled: boolean) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<LinkOption[]>({
    queryKey: [...key, 'links', kind],
    queryFn: async () => {
      const operation = kind === 'project' ? 'get_resources_project' : kind === 'contract' ? 'get_resources_contract' : 'get_resources_procurement_package';
      return (await client.readAll(operation)).flatMap((raw) => toLinkOption(raw, kind === 'project' ? 'name' : 'title') ?? []);
    },
    enabled: enabled && key[1] !== undefined,
    retry: false,
  });
}

/** The link to download a version: asked for at the moment of the download, because the server judges the person again and the link lives minutes. */
export function useDownloadLink() {
  const client = useApiClient();
  return useMutation<DownloadLink, unknown, string>({
    mutationFn: async (versionId) => toDownload(await client.read('getProjectDocumentVersionDownload', { path: at({ id: versionId }) })),
  });
}

/** Puts a file into the shared upload pipeline (judged by its bytes, scanned, stored under the tenant): the answer names its key, its hash and its format. */
export function useUploadFile() {
  const client = useApiClient();
  const attempts = useRef(new AttemptRegistry());
  return useMutation<UploadedFile, unknown, File>({
    mutationFn: async (file) => toUploaded(await uploadFile(client, 'uploadProjectDocumentFile', { file, attempt: attempts.current.forPayload({ name: file.name, size: file.size, type: file.type, modified: file.lastModified }) })),
    onSuccess: () => attempts.current.done(),
    onError: (error) => attempts.current.ended(error),
  });
}

function useCommand<Input>(send: (input: Input, attempt: ReturnType<Registry['forPayload']>) => Promise<unknown>) {
  const queryClient = useQueryClient();
  const key = useScopeKey();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: (input: Input) => send(input, attempts.current.forPayload(input)),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: key });
    },
    onError: (error) => attempts.current.ended(error),
  });
}

export function useCreateDocument() {
  const client = useApiClient();
  return useCommand<Schemas['ProjectDocumentCreate']>((body, attempt) => client.command('createProjectDocument', { body, attempt }));
}

export function useUpdateDocument() {
  const client = useApiClient();
  return useCommand<{ id: string; version: number; body: Schemas['ProjectDocumentUpdate'] }>((input, attempt) =>
    client.command('updateProjectDocument', { path: at({ id: input.id }), body: input.body, ifMatchVersion: input.version, attempt }),
  );
}

export function useAddVersion() {
  const client = useApiClient();
  return useCommand<{ id: string; body: Schemas['ProjectDocumentVersionCreate'] }>((input, attempt) => client.command('addProjectDocumentVersion', { path: at({ id: input.id }), body: input.body, attempt }));
}

export function useArchive() {
  const client = useApiClient();
  return useCommand<{ id: string; version: number; reason: string }>((input, attempt) => client.command('archiveProjectDocument', { path: at({ id: input.id }), body: { reason: input.reason }, ifMatchVersion: input.version, attempt }));
}

export function useRestore() {
  const client = useApiClient();
  return useCommand<{ id: string; version: number }>((input, attempt) => client.command('restoreProjectDocument', { path: at({ id: input.id }), ifMatchVersion: input.version, attempt }));
}

export function useRerunExtraction() {
  const client = useApiClient();
  return useCommand<{ versionId: string }>((input, attempt) => client.command('rerunDocumentExtraction', { path: at({ id: input.versionId }), attempt }));
}

export function useAddComment() {
  const client = useApiClient();
  return useCommand<{ versionId: string; citationId: string | null; parentId: string | null; body: string }>((input, attempt) =>
    client.command('addDocumentComment', {
      path: at({ id: input.versionId }),
      body: { body: input.body, ...(input.citationId === null ? {} : { citation_id: input.citationId }), ...(input.parentId === null ? {} : { parent_id: input.parentId }) },
      attempt,
    }),
  );
}

export function useResolveComment() {
  const client = useApiClient();
  return useCommand<{ id: string; note: string }>((input, attempt) => client.command('resolveDocumentComment', { path: at({ id: input.id }), body: input.note === '' ? {} : { note: input.note }, attempt }));
}

export function useReopenComment() {
  const client = useApiClient();
  return useCommand<{ id: string }>((input, attempt) => client.command('reopenDocumentComment', { path: at({ id: input.id }), attempt }));
}

export function useSubmitReview() {
  const client = useApiClient();
  return useCommand<{ documentId: string; versionId: string; note: string }>((input, attempt) =>
    client.command('submitDocumentForReview', { path: at({ id: input.documentId }), body: { version_id: input.versionId, ...(input.note === '' ? {} : { note: input.note }) }, attempt }),
  );
}

export function useWithdrawReview() {
  const client = useApiClient();
  return useCommand<{ id: string; version: number; reason: string }>((input, attempt) => client.command('withdrawDocumentReview', { path: at({ id: input.id }), body: { reason: input.reason }, ifMatchVersion: input.version, attempt }));
}

/** A reviewer's decision on the task the board gives them: the approval engine of ADM judges it (the maker is never the checker). */
export function useDecideTask() {
  const client = useApiClient();
  return useCommand<{ taskId: string; version: number; decision: 'approve' | 'return' | 'reject'; reason: string }>((input, attempt) =>
    client.command('decideApprovalTask', { path: at({ taskId: input.taskId }), body: { decision: input.decision, ...(input.reason === '' ? {} : { reason: input.reason }) }, ifMatchVersion: input.version, attempt }),
  );
}
