import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../../api/ApiClientContext';
import { AttemptRegistry } from '../../../api/attempt-registry';
import { useSession } from '../../../session/SessionContext';
import { toProposalPage } from './model';
import type { ProposalPage, Status } from './model';

const PAGE_SIZE = 25;

/** The cache is of the member as well as the tenant: what is listed depends on who asks. */
function useScope(): readonly ['cap', string | undefined, string | undefined, 'reallocation'] {
  const { tenant } = useSession();
  return ['cap', tenant?.id, tenant?.membershipId, 'reallocation'];
}

/** The proposals of the units the caller may read, newest first, a page at a time, narrowed by status. */
export function useProposals(status: string) {
  const client = useApiClient();
  const scope = useScope();
  return useInfiniteQuery<ProposalPage, Error, { pages: ProposalPage[] }, readonly unknown[], string | undefined>({
    queryKey: [...scope, 'list', status],
    initialPageParam: undefined,
    queryFn: async ({ pageParam }) =>
      toProposalPage(await client.read('listReallocationProposals', { query: { limit: PAGE_SIZE, ...(status === '' ? {} : { status: status as Status }), ...(pageParam === undefined ? {} : { cursor: pageParam }) } })),
    getNextPageParam: (last) => last.nextCursor,
    enabled: scope[1] !== undefined,
    retry: false,
  });
}

type Attempt = ReturnType<AttemptRegistry['forPayload']>;

/** One command: one idempotency attempt per intention; the proposals, and what the plans show, are read again when it succeeds (an application publishes a plan). */
function useCommand<Input>(send: (input: Input, attempt: Attempt) => Promise<unknown>) {
  const queryClient = useQueryClient();
  const { tenant } = useSession();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: async (input: Input) => send(input, attempts.current.forPayload(input)),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: ['cap', tenant?.id] });
    },
    onError: (error) => attempts.current.ended(error),
  });
}

export function useDraftProposal() {
  const client = useApiClient();
  return useCommand((body: Record<string, unknown>, attempt) => client.command('draftReallocationProposal', { body: body as never, attempt }));
}

export interface StepInput {
  id: string;
  version: number;
}

export function useSubmitProposal() {
  const client = useApiClient();
  return useCommand((input: StepInput, attempt) => client.command('submitReallocationProposal', { path: { id: input.id }, body: {} as never, ifMatchVersion: input.version, attempt }));
}

export interface DecideInput extends StepInput {
  decision: string;
  reason: string;
}

export function useDecideProposal() {
  const client = useApiClient();
  return useCommand((input: DecideInput, attempt) => client.command('decideReallocationProposal', { path: { id: input.id }, body: { decision: input.decision, reason: input.reason.trim() } as never, ifMatchVersion: input.version, attempt }));
}

export interface ApplyInput extends StepInput {
  documentId: string;
}

export function useApplyProposal() {
  const client = useApiClient();
  return useCommand((input: ApplyInput, attempt) => client.command('applyReallocationProposal', { path: { id: input.id }, body: { decision_document_id: input.documentId.trim() } as never, ifMatchVersion: input.version, attempt }));
}
