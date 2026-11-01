import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../../api/ApiClientContext';
import { AttemptRegistry } from '../../../api/attempt-registry';
import { useSession } from '../../../session/SessionContext';
import { collectionBody, toCollection } from './model';
import type { Collection, CollectionForm } from './model';

// What the list holds depends on the membership that is signed in, not only on the tenant.
const root = (tenantId: string | undefined, membershipId: string | undefined) => ['llm', 'knowledge', tenantId, membershipId] as const;

/** The collections, newest first. */
export function useCollections() {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<Collection[]>({
    queryKey: [...root(tenant?.id, tenant?.membershipId), 'list'],
    queryFn: async () => (await client.readAll('listAiKnowledgeCollections')).flatMap((raw) => toCollection(raw) ?? []),
    enabled: tenant !== undefined,
    retry: false,
  });
}

/** One collection with its items, the ones that wait to be indexed again marked. */
export function useCollection(id: string | undefined) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<Collection | undefined>({
    queryKey: [...root(tenant?.id, tenant?.membershipId), 'one', id],
    queryFn: async () => toCollection(await client.read('getAiKnowledgeCollection', { path: { id: id as string } })),
    enabled: id !== undefined && tenant !== undefined,
    retry: false,
  });
}

function useKnowledgeCommand<Input>(send: (input: Input, attempt: ReturnType<AttemptRegistry['forPayload']>) => Promise<unknown>) {
  const queryClient = useQueryClient();
  const { tenant } = useSession();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: (input: Input) => send(input, attempts.current.forPayload(input)),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: root(tenant?.id, tenant?.membershipId) });
    },
    onError: (error) => attempts.current.ended(error),
  });
}

export function useCreateCollection() {
  const client = useApiClient();
  return useKnowledgeCommand<CollectionForm>((form, attempt) => client.command('createAiKnowledgeCollection', { body: collectionBody(form) as never, attempt }));
}

export interface IndexInput {
  collectionId: string;
  documentVersionId: string;
}

/** Indexes a document version into a collection, or indexes it again. */
export function useIndexItem() {
  const client = useApiClient();
  return useKnowledgeCommand<IndexInput>((input, attempt) =>
    client.command('indexAiKnowledgeItem', { path: { id: input.collectionId }, body: { document_version_id: input.documentVersionId.trim().toLowerCase() } as never, attempt }),
  );
}
