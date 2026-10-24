import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { QueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../../api/ApiClientContext';
import { AttemptRegistry } from '../../../api/attempt-registry';
import { useSession } from '../../../session/SessionContext';
import { toDetail, toPage } from './types';
import type { components } from '@machvon/contracts';
import { loose } from './rules';
import type { CreateBody, UpdateBodyShape } from './rules';
import type { CancelCode, ChecklistKey, DraftDetail, DraftPage, DraftRow } from './types';

export const PAGE_SIZE = 50;

export interface DraftFilter {
  status: string;
  docTypeCode: string;
  year: string;
}

export const draftsRoot = (tenantId: string | undefined) => ['doc', 'drafts', tenantId] as const;
export const draftsKey = (tenantId: string | undefined, filter: DraftFilter) => ['doc', 'drafts', tenantId, filter.status, filter.docTypeCode, filter.year] as const;
export const draftKey = (tenantId: string | undefined, id: string | undefined) => ['doc', 'draft', tenantId, id ?? ''] as const;
export const timelineKey = (tenantId: string | undefined, documentId: string | undefined) => ['doc', 'timeline', tenantId, documentId ?? ''] as const;
export const templateBodyKey = (tenantId: string | undefined, templateId: string | undefined) => ['doc', 'template-body', tenantId, templateId ?? ''] as const;

async function refresh(queryClient: QueryClient, tenantId: string | undefined): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: draftsRoot(tenantId) }),
    queryClient.invalidateQueries({ queryKey: ['doc', 'draft', tenantId] }),
    queryClient.invalidateQueries({ queryKey: ['doc', 'timeline', tenantId] }),
    // The signing and numbering screens read the same documents under their own keys.
    queryClient.invalidateQueries({ queryKey: ['doc', 'outgoing-queue', tenantId] }),
    queryClient.invalidateQueries({ queryKey: ['doc', 'outgoing-document', tenantId] }),
  ]);
}

/** The outgoing documents of the filter, newest first, page by page: the list of DOC-03 and the queue of DOC-04. */
export function useDraftList(filter: DraftFilter) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useInfiniteQuery<DraftPage, Error, { pages: DraftPage[] }, ReturnType<typeof draftsKey>, string | undefined>({
    queryKey: draftsKey(tenant?.id, filter),
    initialPageParam: undefined,
    queryFn: async ({ pageParam }) =>
      toPage(
        await client.read('listOutgoingDocuments', {
          query: {
            limit: PAGE_SIZE,
            ...(filter.status === '' ? {} : { status: filter.status }),
            ...(filter.docTypeCode === '' ? {} : { doc_type_code: filter.docTypeCode }),
            ...(filter.year === '' ? {} : { year: filter.year }),
            ...(pageParam === undefined ? {} : { cursor: pageParam }),
          },
        }),
      ),
    getNextPageParam: (last) => last.nextCursor,
    enabled: tenant !== undefined,
    retry: false,
  });
}

/** The documents of every page loaded so far. */
export function listItems(data: { pages: DraftPage[] } | undefined): DraftRow[] {
  return data?.pages.flatMap((page) => page.items) ?? [];
}

/** One document with its payload, recipients and the latest review. */
export function useDraft(id: string | undefined) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<DraftDetail>({
    queryKey: draftKey(tenant?.id, id),
    queryFn: async () => toDetail(await client.read('getOutgoingDocument', { path: { id: id ?? '' } })),
    enabled: tenant !== undefined && id !== undefined,
    retry: false,
  });
}

export interface TemplateBody {
  id: string;
  templateCode: string;
  title: string;
  blocks: Array<{ kind: string; text: string }>;
  required: string[];
  confirmed: boolean;
  watermarkText: string | null;
}

type Raw = Record<string, unknown>;
const isRecord = (value: unknown): value is Raw => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The body of a template, read for the placeholders the editor asks for. */
export function useTemplateBody(templateId: string | undefined) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<TemplateBody>({
    queryKey: templateBodyKey(tenant?.id, templateId),
    queryFn: async () => {
      const raw = await client.read('getDocumentTemplate', { path: { id: templateId ?? '' } });
      const body: Raw = isRecord(raw) ? raw : {};
      const blocks = isRecord(body.body_blocks) && Array.isArray(body.body_blocks.blocks) ? body.body_blocks.blocks : [];
      const schema = isRecord(body.placeholder_schema) ? body.placeholder_schema : {};
      return {
        id: typeof body.id === 'string' ? body.id : '',
        templateCode: typeof body.template_code === 'string' ? body.template_code : '',
        title: typeof body.title === 'string' ? body.title : '',
        blocks: blocks.flatMap((block) => (isRecord(block) && typeof block.text === 'string' ? [{ kind: typeof block.kind === 'string' ? block.kind : 'paragraph', text: block.text }] : [])),
        required: Array.isArray(schema.required) ? schema.required.filter((item): item is string => typeof item === 'string') : [],
        confirmed: body.confirmation_status === 'CONFIRMED',
        watermarkText: typeof body.watermark_text === 'string' ? body.watermark_text : null,
      };
    },
    enabled: tenant !== undefined && templateId !== undefined,
    retry: false,
  });
}

export interface TimelineEvent {
  id: string;
  kind: string;
  fromStatus: string | null;
  toStatus: string;
  actorId: string;
  comment: string | null;
  occurredAt: string;
}

export interface Timeline {
  events: TimelineEvent[];
}

/** The status history of a document. */
export function useTimeline(documentId: string | undefined) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<Timeline>({
    queryKey: timelineKey(tenant?.id, documentId),
    queryFn: async () => {
      const raw = await client.read('getDocumentTimeline', { path: { id: documentId ?? '' } });
      const body: Raw = isRecord(raw) ? raw : {};
      const events = Array.isArray(body.events) ? body.events : [];
      return {
        events: events.flatMap((event) => {
          if (!isRecord(event)) return [];
          return [
            {
              id: typeof event.id === 'string' ? event.id : '',
              kind: typeof event.kind === 'string' ? event.kind : '',
              fromStatus: typeof event.from_status === 'string' ? event.from_status : null,
              toStatus: typeof event.to_status === 'string' ? event.to_status : '',
              actorId: typeof event.actor_id === 'string' ? event.actor_id : '',
              comment: typeof event.comment === 'string' ? event.comment : null,
              occurredAt: typeof event.occurred_at === 'string' ? event.occurred_at : '',
            },
          ];
        }),
      };
    },
    enabled: tenant !== undefined && documentId !== undefined,
    retry: false,
  });
}

export interface SaveResult {
  id: string;
  version: number;
}

const savedOf = (raw: unknown): SaveResult => {
  const body: Raw = isRecord(raw) ? raw : {};
  return { id: typeof body.resource_id === 'string' ? body.resource_id : '', version: typeof body.resource_version === 'number' ? body.resource_version : 0 };
};

/** Creates a draft (one attempt per intention: a retry of the same request reuses its key). */
export function useCreateDraft() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const { tenant } = useSession();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: async (body: CreateBody): Promise<SaveResult> => savedOf(await client.command('createOutgoingDocument', { body, attempt: attempts.current.forPayload(body) })),
    onSuccess: async () => {
      attempts.current.done();
      await refresh(queryClient, tenant?.id);
    },
    onError: (error) => attempts.current.ended(error),
  });
}

export interface VersionedInput {
  documentId: string;
  version: number;
}

export interface UpdateInput extends VersionedInput {
  body: UpdateBodyShape;
}

/** Saves the draft under the version the screen showed: the server answers 409 when another editor was first. */
export function useUpdateDraft() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const { tenant } = useSession();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: async (input: UpdateInput): Promise<SaveResult> =>
      savedOf(await client.command('updateOutgoingDocumentDraft', { path: { id: input.documentId }, body: input.body, ifMatchVersion: input.version, attempt: attempts.current.forPayload(input) })),
    onSuccess: async () => {
      attempts.current.done();
      await refresh(queryClient, tenant?.id);
    },
    onError: (error) => attempts.current.ended(error),
  });
}

/** Sends the draft for review. */
export function useSubmitDraft() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const { tenant } = useSession();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: async (input: VersionedInput): Promise<SaveResult> =>
      savedOf(await client.command('submitOutgoingDocumentForReview', { path: { id: input.documentId }, ifMatchVersion: input.version, attempt: attempts.current.forPayload(input) })),
    onSuccess: async () => {
      attempts.current.done();
      await refresh(queryClient, tenant?.id);
    },
    onError: (error) => attempts.current.ended(error),
  });
}

export interface DecisionInput extends VersionedInput {
  decision: 'APPROVE' | 'RETURN';
  comment: string;
  checklist: Record<ChecklistKey, boolean> | undefined;
}

export interface DecisionResult extends SaveResult {
  status: string;
  fileSha256: string | undefined;
}

/** The review decision: approving locks the final PDF, returning sends the draft back with the comment. */
export function useDecideReview() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const { tenant } = useSession();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: async (input: DecisionInput): Promise<DecisionResult> => {
      const raw = await client.command('decideOutgoingDocumentReview', {
        path: { id: input.documentId },
        body: {
          decision: input.decision,
          ...(input.comment.trim() === '' ? {} : { comment: input.comment.trim() }),
          ...(input.decision === 'APPROVE' && input.checklist !== undefined ? { format_checklist: loose(input.checklist) } : {}),
        },
        ifMatchVersion: input.version,
        attempt: attempts.current.forPayload(input),
      });
      const body: Raw = isRecord(raw) ? raw : {};
      return { ...savedOf(raw), status: typeof body.status === 'string' ? body.status : '', fileSha256: typeof body.file_sha256 === 'string' ? body.file_sha256 : undefined };
    },
    onSuccess: async () => {
      attempts.current.done();
      await refresh(queryClient, tenant?.id);
    },
    onError: (error) => attempts.current.ended(error),
  });
}

export interface ReasonInput extends VersionedInput {
  reason: string;
}

/** Takes a document under review, or one waiting for the signature, back to the draft. */
export function useReturnDocument() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const { tenant } = useSession();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: async (input: ReasonInput): Promise<SaveResult> =>
      savedOf(await client.command('returnOutgoingDocument', { path: { id: input.documentId }, body: { reason: input.reason.trim() }, ifMatchVersion: input.version, attempt: attempts.current.forPayload(input) })),
    onSuccess: async () => {
      attempts.current.done();
      await refresh(queryClient, tenant?.id);
    },
    onError: (error) => attempts.current.ended(error),
  });
}

export interface CancelInput extends ReasonInput {
  rejectCode: CancelCode;
}

/** Cancels a document that has no number yet. */
export function useCancelDocument() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const { tenant } = useSession();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: async (input: CancelInput): Promise<SaveResult> =>
      savedOf(
        await client.command('cancelOutgoingDocument', {
          path: { id: input.documentId },
          body: { reason: input.reason.trim(), reject_code: input.rejectCode },
          ifMatchVersion: input.version,
          attempt: attempts.current.forPayload(input),
        }),
      ),
    onSuccess: async () => {
      attempts.current.done();
      await refresh(queryClient, tenant?.id);
    },
    onError: (error) => attempts.current.ended(error),
  });
}

export interface PreviewInput {
  templateCode: string;
  asOfDate: string;
  payload: Record<string, unknown>;
}

export interface PreviewResult {
  versionId: string;
  sha256: string;
  pageCount: number;
  watermarked: boolean;
  /** A short-lived address of the file, when the caller may download it. */
  url: string | undefined;
}

/** A watermarked preview of the draft as a PDF (nothing is kept on the document); the address lives at most five minutes. */
export function usePreview() {
  const client = useApiClient();
  return useMutation({
    mutationFn: async (input: PreviewInput): Promise<PreviewResult> => {
      const raw = await client.command('renderDocumentPreview', {
        body: { template_code: input.templateCode, as_of_date: input.asOfDate, payload: loose(input.payload), output: 'PDF' } satisfies components['schemas']['DocRenderRequest'],
      });
      const body: Raw = isRecord(raw) ? raw : {};
      const versionId = typeof body.version_id === 'string' ? body.version_id : '';
      let url: string | undefined;
      try {
        const link = (await client.read('getDocumentVersionDownload', { path: { id: versionId } })) as { url?: unknown };
        url = typeof link.url === 'string' ? link.url : undefined;
      } catch {
        url = undefined;
      }
      return { versionId, sha256: typeof body.sha256 === 'string' ? body.sha256 : '', pageCount: typeof body.page_count === 'number' ? body.page_count : 0, watermarked: body.watermarked === true, url };
    },
  });
}
