import { uploadFile } from '@machvon/api-client';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../../api/ApiClientContext';
import { AttemptRegistry } from '../../../api/attempt-registry';
import { useSession } from '../../../session/SessionContext';
import { filterQuery, reviewBody, toOcrListing, toUploadedCorrection } from './model';
import type { Decision, Draft, OcrListing, PageFilter } from './model';

const PAGE_SIZE = 25;

// What the screen shows depends on what the signed-in membership may see, not only on the tenant: the membership is part of every key.
function useScopeKey(): readonly ['bid-ocr', string | undefined, string | undefined] {
  const { tenant } = useSession();
  return ['bid-ocr', tenant?.id, tenant?.membershipId];
}

/** The pages of one proposal for a filter, a page of the list at a time; none is asked for until a proposal is chosen. The gate of the financial analysis comes with every page. */
export function useOcrPages(proposalId: string, filter: PageFilter) {
  const client = useApiClient();
  const key = useScopeKey();
  return useInfiniteQuery<OcrListing, Error, { pages: OcrListing[] }, readonly unknown[], string | undefined>({
    queryKey: [...key, 'pages', proposalId, filter],
    initialPageParam: undefined,
    queryFn: async ({ pageParam }) =>
      toOcrListing(
        await client.read('listProposalOcrPages', { path: { id: proposalId }, query: { ...filterQuery(filter), limit: PAGE_SIZE, ...(pageParam === undefined ? {} : { cursor: pageParam }) } }),
      ),
    getNextPageParam: (last) => last.nextCursor,
    enabled: key[1] !== undefined && proposalId !== '',
    retry: false,
  });
}

function registryOf(registries: Map<string, AttemptRegistry>, pageId: string): AttemptRegistry {
  let registry = registries.get(pageId);
  if (registry === undefined) {
    registry = new AttemptRegistry();
    registries.set(pageId, registry);
  }
  return registry;
}

export interface ReviewInput {
  pageId: string;
  decision: Decision;
  draft: Draft;
}

/**
 * The review of one page: a confirmation is one command; a correction first puts the text of the reviewer into the shared upload pipeline (plain text, scanned) and then names it. Each step has
 * one idempotency attempt per intention, so a retry after a lost answer is the same request. Every cached read of the screen is refreshed on success.
 */
export function useReviewPage() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const key = useScopeKey();
  // Reviews of different pages run side by side: each page keeps the attempts of its own intention, so neither the keys nor a retry after a lost answer are shared.
  const uploads = useRef(new Map<string, AttemptRegistry>());
  const attempts = useRef(new Map<string, AttemptRegistry>());
  return useMutation({
    mutationFn: async (input: ReviewInput) => {
      let correctedKey: string | undefined;
      if (input.decision === 'CORRECTED') {
        const file = new File([input.draft.text], 'page.txt', { type: 'text/plain' });
        const uploaded = toUploadedCorrection(await uploadFile(client, 'uploadOcrCorrectionFile', { file, attempt: registryOf(uploads.current, input.pageId).forPayload({ text: input.draft.text }) }));
        if (uploaded === undefined) throw new Error('the upload did not name the stored text');
        correctedKey = uploaded.key;
      }
      const body = reviewBody(input.decision, input.draft, correctedKey);
      return client.command('reviewOcrPage', { path: { id: input.pageId }, body, attempt: registryOf(attempts.current, input.pageId).forPayload({ id: input.pageId, body }) });
    },
    onSuccess: async (_done, input) => {
      uploads.current.delete(input.pageId);
      attempts.current.delete(input.pageId);
      await queryClient.invalidateQueries({ queryKey: key });
    },
    onError: (error, input) => {
      uploads.current.get(input.pageId)?.ended(error);
      attempts.current.get(input.pageId)?.ended(error);
    },
  });
}
