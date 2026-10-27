import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../../api/ApiClientContext';
import { AttemptRegistry } from '../../../api/attempt-registry';
import { useScopeKey } from '../hooks';
import { toImpact, toTransferPage } from './model';
import type { Impact, Scope, Status, TransferPage } from './model';

const PAGE_SIZE = 25;
const root = (scope: ReturnType<typeof useScopeKey>) => [...scope, 'transfers'] as const;

/** The requests for the projects in the scope of the caller, newest first, a page at a time, narrowed by status. */
export function useTransfers(status: string) {
  const client = useApiClient();
  const scope = useScopeKey();
  return useInfiniteQuery<TransferPage, Error, { pages: TransferPage[] }, readonly unknown[], string | undefined>({
    queryKey: [...root(scope), 'list', status],
    initialPageParam: undefined,
    queryFn: async ({ pageParam }) =>
      toTransferPage(await client.read('listProjectTransfers', { query: { limit: PAGE_SIZE, ...(status === '' ? {} : { status: status as Status }), ...(pageParam === undefined ? {} : { cursor: pageParam }) } })),
    getNextPageParam: (last) => last.nextCursor,
    enabled: scope[1] !== undefined,
    retry: false,
  });
}

/** What a transfer would change, read when the project, the unit and the scope are chosen. */
export function useImpact(projectId: string, toUnitId: string, scope: Scope) {
  const client = useApiClient();
  const key = useScopeKey();
  const ready = projectId !== '' && toUnitId !== '';
  return useQuery<Impact | undefined>({
    queryKey: [...root(key), 'impact', projectId, toUnitId, scope],
    queryFn: async () => toImpact(await client.read('getProjectTransferImpact', { path: { id: projectId }, query: { to_unit_id: toUnitId, transfer_scope: scope } })),
    enabled: ready && key[1] !== undefined,
    retry: false,
  });
}

type Attempt = ReturnType<AttemptRegistry['forPayload']>;

function useCommand<Input>(send: (input: Input, attempt: Attempt) => Promise<unknown>) {
  const queryClient = useQueryClient();
  const scope = useScopeKey();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: async (input: Input) => send(input, attempts.current.forPayload(input)),
    onSuccess: async () => {
      attempts.current.done();
      // A transfer changes the unit of a project: the register and the lists that name the unit are read again as well.
      await queryClient.invalidateQueries({ queryKey: scope });
    },
    onError: (error) => attempts.current.ended(error),
  });
}

export interface RequestInput {
  projectId: string;
  version: number;
  body: Record<string, unknown>;
}

export function useRequestTransfer() {
  const client = useApiClient();
  return useCommand((input: RequestInput, attempt) => client.command('requestProjectTransfer', { path: { id: input.projectId }, body: input.body as never, ifMatchVersion: input.version, attempt }));
}

export interface DecideInput {
  id: string;
  version: number;
  decision: string;
  reason: string;
}

export function useDecideTransfer() {
  const client = useApiClient();
  return useCommand((input: DecideInput, attempt) => client.command('decideProjectTransfer', { path: { id: input.id }, body: { decision: input.decision, reason: input.reason.trim() } as never, ifMatchVersion: input.version, attempt }));
}
