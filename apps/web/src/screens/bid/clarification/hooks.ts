import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useApiClient } from '../../../api/ApiClientContext';
import { AttemptRegistry } from '../../../api/attempt-registry';
import { useSession } from '../../../session/SessionContext';
import { toClarificationList } from './model';
import type { Clarification, SendBody } from './model';

// What the screen shows depends on what the signed-in membership may see, not only on the tenant: the membership is part of every key.
function useScopeKey(): readonly ['bid-clarifications', string | undefined, string | undefined] {
  const { tenant } = useSession();
  return ['bid-clarifications', tenant?.id, tenant?.membershipId];
}

/**
 * The requests the caller reaches, the newest first: all of a contractor's own for a guest, and those of the projects of the caller for the staff. A package narrows them. The read is made when the caller may
 * and not before.
 */
export function useClarifications(packageId: string, enabled: boolean) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<Clarification[]>({
    queryKey: [...key, 'list', packageId],
    queryFn: async () =>
      toClarificationList(await client.read('listBidClarifications', { query: packageId === '' ? {} : { package_id: packageId } })),
    enabled: enabled && key[1] !== undefined,
    retry: false,
  });
}

/** Asking a question: one idempotency attempt for each intention. The requests are read again whatever the answer was. */
export function useSendClarification() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const key = useScopeKey();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: (body: SendBody) => client.command('sendBidClarification', { body, attempt: attempts.current.forPayload(body) }),
    onSuccess: () => attempts.current.done(),
    onError: (error) => attempts.current.ended(error),
    onSettled: () => queryClient.invalidateQueries({ queryKey: key }),
  });
}

export interface AnswerInput {
  line: Clarification;
  /** The document that answers, as it was typed. */
  body: { answer_document_id: string };
}

/**
 * The answer to one request. It names the version of the request the person saw (If-Match), and each request keeps the idempotency attempt of its own intention, so a retry after a lost answer is the same
 * request and a different document is a new one. A refusal ends the intention; the requests are read again whatever the answer was, so that a person who met a deadline or a version conflict sees what stands now.
 */
export function useAnswerClarification() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const key = useScopeKey();
  const attempts = useRef(new Map<string, AttemptRegistry>());
  const registryOf = (id: string): AttemptRegistry => {
    const found = attempts.current.get(id) ?? new AttemptRegistry();
    attempts.current.set(id, found);
    return found;
  };
  return useMutation<unknown, unknown, AnswerInput>({
    mutationFn: ({ line, body }) =>
      client.command('recordClarificationAnswer', { path: { id: line.id }, body, ifMatchVersion: line.version, attempt: registryOf(line.id).forPayload({ id: line.id, version: line.version, body }) }),
    onSuccess: (_answer, { line }) => attempts.current.delete(line.id),
    onError: (error, { line }) => registryOf(line.id).ended(error),
    onSettled: () => queryClient.invalidateQueries({ queryKey: key }),
  });
}

/** A timer longer than this fires at once, so a deadline far ahead is waited for in steps. */
const LONGEST_WAIT_MS = 60 * 60_000;

/**
 * Renders the screen again at the moment the next deadline of the given ones passes, so that a request whose time is up while the screen stays open stops being offered for an answer and shows as expired without
 * a read in between. Returns nothing: the screen samples the clock as it renders.
 */
export function useDeadlineClock(deadlines: readonly string[]): void {
  const [tick, setTick] = useState(0);
  const key = deadlines.join('|');
  useEffect(() => {
    const at = Date.now();
    const next = key === '' ? [] : key.split('|').map((moment) => Date.parse(moment)).filter((moment) => moment > at);
    if (next.length === 0) return undefined;
    const timer = setTimeout(() => setTick((current) => current + 1), Math.min(Math.min(...next) - at + 1, LONGEST_WAIT_MS));
    return () => clearTimeout(timer);
  }, [key, tick]);
}
