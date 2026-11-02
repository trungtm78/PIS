import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../../api/ApiClientContext';
import { AttemptRegistry, isDefinitiveRefusal } from '../../../api/attempt-registry';
import { useSession } from '../../../session/SessionContext';
import { findingQuery, reviewBody, toRecorded, toReviewedList } from './model';
import type { Draft, FindingFilter, Recorded, ReviewedFinding, ReviewedList } from './model';

const PAGE_SIZE = 25;

// What the screen shows depends on what the signed-in membership may see, not only on the tenant: the membership is part of every key.
function useScopeKey(): readonly ['bid-review', string | undefined, string | undefined] {
  const { tenant } = useSession();
  return ['bid-review', tenant?.id, tenant?.membershipId];
}

/**
 * The findings of a run with their evidence and the history of their review, for a filter, a page at a time. Reading them is recorded on the server as the opening of the evidence, so it is made when the caller
 * may and not before.
 */
export function useReviewFindings(runId: string, filter: FindingFilter, enabled: boolean) {
  const client = useApiClient();
  const key = useScopeKey();
  return useInfiniteQuery<ReviewedList, Error, { pages: ReviewedList[] }, readonly unknown[], string | undefined>({
    queryKey: [...key, 'findings', runId, filter],
    initialPageParam: undefined,
    queryFn: async ({ pageParam }) =>
      toReviewedList(await client.read('listAnalysisFindings', { path: { id: runId }, query: { ...findingQuery(filter), limit: PAGE_SIZE, ...(pageParam === undefined ? {} : { cursor: pageParam }) } })),
    getNextPageParam: (last) => last.nextCursor,
    enabled: enabled && key[1] !== undefined && runId !== '',
    retry: false,
  });
}

export interface ReviewInput {
  finding: ReviewedFinding;
  draft: Draft;
}

/**
 * The decision of an expert about one finding. It names the version of the finding the person saw (If-Match), and each finding keeps the idempotency attempt of its own intention, so a retry after a lost answer is the
 * same request and a change of what was typed is a new one. A refusal ends the intention; the findings are read again whatever the answer was, so that a person who met a version conflict sees what stands now.
 */
export function useReviewFinding() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const key = useScopeKey();
  const attempts = useRef(new Map<string, AttemptRegistry>());
  // The version and the words of the request that is still open for a finding: a lost answer may hide a decision that was recorded, and the retry is the same request only if it names the version the first one did.
  const opened = useRef(new Map<string, { version: number; body: string }>());
  const registryOf = (findingId: string): AttemptRegistry => {
    const found = attempts.current.get(findingId) ?? new AttemptRegistry();
    attempts.current.set(findingId, found);
    return found;
  };
  const versionOf = (finding: ReviewedFinding, body: unknown): number => {
    const words = JSON.stringify(body);
    const open = opened.current.get(finding.id);
    if (open?.body === words) return open.version;
    opened.current.set(finding.id, { version: finding.version, body: words });
    return finding.version;
  };
  return useMutation<Recorded | undefined, unknown, ReviewInput>({
    mutationFn: async ({ finding, draft }) => {
      const body = reviewBody(draft);
      const version = versionOf(finding, body);
      return toRecorded(
        await client.command('reviewAnalysisFinding', {
          path: { id: finding.id },
          body,
          ifMatchVersion: version,
          attempt: registryOf(finding.id).forPayload({ id: finding.id, version, body }),
        }),
      );
    },
    onSuccess: (_recorded, { finding }) => {
      attempts.current.delete(finding.id);
      opened.current.delete(finding.id);
    },
    onError: (error, { finding }) => {
      registryOf(finding.id).ended(error);
      if (isDefinitiveRefusal(error)) opened.current.delete(finding.id);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: key }),
  });
}
