import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { QueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../../api/ApiClientContext';
import { AttemptRegistry } from '../../../api/attempt-registry';
import { useSession } from '../../../session/SessionContext';
import { toDocument, toQueuePage } from './types';
import type { DispatchChannel, DistributionDocument, QueuePage, QueueRow } from './types';

export const QUEUE_LIMIT = 50;

export const queueKey = (tenantId: string | undefined, status: string) => ['doc', 'distribution-queue', tenantId, status] as const;
export const documentKey = (tenantId: string | undefined, id: string | undefined) => ['doc', 'distribution-document', tenantId, id ?? ''] as const;

/** A command moved a document (and maybe the queues): the queues, this screen's document and the documents of the other DOC screens are read again. */
async function refresh(queryClient: QueryClient, tenantId: string | undefined): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ['doc', 'distribution-queue', tenantId] }),
    queryClient.invalidateQueries({ queryKey: ['doc', 'distribution-document', tenantId] }),
    queryClient.invalidateQueries({ queryKey: ['doc', 'outgoing-queue', tenantId] }),
    queryClient.invalidateQueries({ queryKey: ['doc', 'outgoing-document', tenantId] }),
  ]);
}

/** The documents in one state, newest first, page by page. */
export function useDistributionQueue(status: string) {
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

/** One document with its recipients and its distributions. */
export function useDistributionDocument(id: string | undefined) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<DistributionDocument>({
    queryKey: documentKey(tenant?.id, id),
    queryFn: async () => toDocument(await client.read('getOutgoingDocument', { path: { id: id ?? '' } })),
    enabled: tenant !== undefined && id !== undefined,
    retry: false,
  });
}

export interface IssueInput {
  documentId: string;
  /** The version of the document the screen showed: the server answers 409 when it moved on. */
  version: number;
  overrideReason: string | undefined;
  distributeNow: boolean;
}

/** Issues a sealed document after the server has verified both signatures again. */
export function useIssue() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const { tenant } = useSession();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: (input: IssueInput) =>
      client.command('issueOutgoingDocument', {
        path: { id: input.documentId },
        body: {
          ...(input.overrideReason === undefined ? {} : { unconfirmed_override_reason: input.overrideReason }),
          ...(input.distributeNow ? { distribute_now: true } : {}),
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

export interface DispatchEntry {
  kind: string;
  name: string;
  code: string | null;
  unitId: string | null;
  channel: DispatchChannel;
  acknowledgementRequired: boolean;
}

function recipientBody(entry: DispatchEntry): Record<string, unknown> {
  return {
    kind: entry.kind,
    name: entry.name,
    ...(entry.code === null ? {} : { code: entry.code }),
    ...(entry.unitId === null ? {} : { unit_id: entry.unitId }),
    channel: entry.channel,
    acknowledgement_required: entry.acknowledgementRequired,
  };
}

export interface DispatchInput {
  documentId: string;
  version: number;
  entries: DispatchEntry[];
}

/** Sends an issued document to the chosen recipients of its list; a recipient that already has a row on the channel gets no second one. */
export function useDispatch() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const { tenant } = useSession();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: (input: DispatchInput) =>
      client.command('dispatchOutgoingDocument', {
        path: { id: input.documentId },
        body: {
          // The contract types a recipient only as "object" (no members), so the generated type admits none; the server reads the members named here.
          recipients: input.entries.map(recipientBody) as unknown as Array<Record<string, never>>,
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

export interface AcknowledgeInput {
  distributionId: string;
  version: number;
  acknowledgedAt: string;
  externalRef: string | undefined;
}

/** Records the receipt of one recipient. */
export function useAcknowledge() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const { tenant } = useSession();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: (input: AcknowledgeInput) =>
      client.command('recordDistributionAcknowledgement', {
        path: { id: input.distributionId },
        body: { acknowledged_at: input.acknowledgedAt, ...(input.externalRef === undefined ? {} : { external_ref: input.externalRef }) },
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

export interface RetryInput {
  distributionId: string;
  version: number;
}

/** Sends a failed distribution again: the same row, one more attempt. */
export function useRetry() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const { tenant } = useSession();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: (input: RetryInput) =>
      client.command('retryDocumentDistribution', {
        path: { id: input.distributionId },
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
