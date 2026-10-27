import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../../api/ApiClientContext';
import { AttemptRegistry } from '../../../api/attempt-registry';
import { useScopeKey } from '../hooks';
import { toExplanationPage } from './model';
import type { ExplanationPage } from './model';

const PAGE_SIZE = 25;
const root = (scope: ReturnType<typeof useScopeKey>) => [...scope, 'explanations'] as const;

/** The requests in the scope of the caller and the ones addressed to them, newest first, a page at a time, narrowed by status. */
export function useExplanations(status: string) {
  const client = useApiClient();
  const scope = useScopeKey();
  return useInfiniteQuery<ExplanationPage, Error, { pages: ExplanationPage[] }, readonly unknown[], string | undefined>({
    queryKey: [...root(scope), 'list', status],
    initialPageParam: undefined,
    queryFn: async ({ pageParam }) =>
      toExplanationPage(await client.read('listExplanationRequests', { query: { limit: PAGE_SIZE, ...(status === '' ? {} : { status }), ...(pageParam === undefined ? {} : { cursor: pageParam }) } })),
    getNextPageParam: (last) => last.nextCursor,
    enabled: scope[1] !== undefined,
    retry: false,
  });
}

type Attempt = ReturnType<AttemptRegistry['forPayload']>;

/** One command: one idempotency attempt per intention, the list read again when it succeeds. */
function useCommand<Input>(send: (input: Input, attempt: Attempt) => Promise<unknown>) {
  const queryClient = useQueryClient();
  const scope = useScopeKey();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: async (input: Input) => send(input, attempts.current.forPayload(input)),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: root(scope) });
    },
    onError: (error) => attempts.current.ended(error),
  });
}

export function useRequestExplanation() {
  const client = useApiClient();
  return useCommand((body: Record<string, unknown>, attempt) => client.command('requestExplanation', { body: body as never, attempt }));
}

export interface AnswerInput {
  id: string;
  version: number;
  text: string;
}

export function useSubmitExplanation() {
  const client = useApiClient();
  return useCommand((input: AnswerInput, attempt) => client.command('submitExplanation', { path: { id: input.id }, body: { response_text: input.text.trim() }, ifMatchVersion: input.version, attempt }));
}

export interface ReviewInput {
  id: string;
  version: number;
  body: Record<string, unknown>;
}

export function useReviewExplanation() {
  const client = useApiClient();
  return useCommand((input: ReviewInput, attempt) => client.command('reviewExplanation', { path: { id: input.id }, body: input.body as never, ifMatchVersion: input.version, attempt }));
}
