import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { QueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../../api/ApiClientContext';
import { AttemptRegistry } from '../../../api/attempt-registry';
import { useSession } from '../../../session/SessionContext';
import { toDocument, toQueuePage } from './types';
import type { QueuePage, QueueRow, RecallDocument } from './types';

export const QUEUE_LIMIT = 50;

export const queueKey = (tenantId: string | undefined, status: string) => ['doc', 'recall-queue', tenantId, status] as const;
export const documentKey = (tenantId: string | undefined, id: string | undefined) => ['doc', 'recall-document', tenantId, id ?? ''] as const;

/** A command moved a document: the queues, this screen's document and the documents of the other DOC screens are read again. */
async function refresh(queryClient: QueryClient, tenantId: string | undefined): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ['doc', 'recall-queue', tenantId] }),
    queryClient.invalidateQueries({ queryKey: ['doc', 'recall-document', tenantId] }),
    queryClient.invalidateQueries({ queryKey: ['doc', 'timeline', tenantId] }),
    queryClient.invalidateQueries({ queryKey: ['doc', 'distribution-queue', tenantId] }),
    queryClient.invalidateQueries({ queryKey: ['doc', 'distribution-document', tenantId] }),
    queryClient.invalidateQueries({ queryKey: ['doc', 'outgoing-queue', tenantId] }),
    queryClient.invalidateQueries({ queryKey: ['doc', 'outgoing-document', tenantId] }),
  ]);
}

/** The documents in one state, newest first, page by page. */
export function useRecallQueue(status: string) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useInfiniteQuery<QueuePage, Error, { pages: QueuePage[] }, ReturnType<typeof queueKey>, string | undefined>({
    queryKey: queueKey(tenant?.id, status),
    initialPageParam: undefined,
    queryFn: async ({ pageParam }) => toQueuePage(await client.read('listOutgoingDocuments', { query: { status, limit: QUEUE_LIMIT, ...(pageParam === undefined ? {} : { cursor: pageParam }) } })),
    getNextPageParam: (last) => last.nextCursor,
    enabled: tenant !== undefined,
    retry: false,
  });
}

export function queueRows(data: { pages: QueuePage[] } | undefined): QueueRow[] {
  return data?.pages.flatMap((page) => page.items) ?? [];
}

/** One document with the recall it carries and the notice each recipient got. */
export function useRecallDocument(id: string | undefined) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<RecallDocument>({
    queryKey: documentKey(tenant?.id, id),
    queryFn: async () => toDocument(await client.read('getOutgoingDocument', { path: { id: id ?? '' } })),
    enabled: tenant !== undefined && id !== undefined,
    retry: false,
  });
}

export interface RecallInput {
  documentId: string;
  /** The version of the document the screen showed: the server answers 409 when it moved on. */
  version: number;
  reason: string;
  basisDocumentId: string | undefined;
  notifyRecipients: boolean;
}

/** Recalls an issued document: it is no longer the one in force and its recipients are told. */
export function useRecall() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const { tenant } = useSession();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: (input: RecallInput) =>
      client.command('recallOutgoingDocument', {
        path: { id: input.documentId },
        body: {
          reason: input.reason,
          notify_recipients: input.notifyRecipients,
          ...(input.basisDocumentId === undefined ? {} : { recall_basis_document_id: input.basisDocumentId }),
        },
        ifMatchVersion: input.version,
        attempt: attempts.current.forPayload(input),
      }),
    onSuccess: async () => {
      attempts.current.done();
      await refresh(queryClient, tenant?.id);
    },
    onError: (error) => attempts.current.ended(error),
  });
}

export interface VoidInput {
  documentId: string;
  version: number;
  reason: string;
  approverId: string;
}

/** Voids the number of a document that cannot be sealed: the number stays in the ledger as voided and the document ends. */
export function useVoidNumber() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const { tenant } = useSession();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: (input: VoidInput) =>
      client.command('voidOutgoingDocumentNumber', {
        path: { id: input.documentId },
        body: { reason: input.reason, approver_user_id: input.approverId },
        ifMatchVersion: input.version,
        attempt: attempts.current.forPayload(input),
      }),
    onSuccess: async () => {
      attempts.current.done();
      await refresh(queryClient, tenant?.id);
    },
    onError: (error) => attempts.current.ended(error),
  });
}
