import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../../api/ApiClientContext';
import { AttemptRegistry } from '../../../api/attempt-registry';
import { useSession } from '../../../session/SessionContext';
import { toScenarioPage } from './model';
import type { ScenarioPage } from './model';

const PAGE_SIZE = 25;

/** The cache is of the member as well as the tenant: what is listed, and what may be done with it, depends on who asks. */
function useScope(): readonly ['cap', string | undefined, string | undefined, 'scenario'] {
  const { tenant } = useSession();
  return ['cap', tenant?.id, tenant?.membershipId, 'scenario'];
}

/** The scenarios on plans of the units the caller may read, newest first, a page at a time, narrowed by status. */
export function useScenarios(status: string, enabled: boolean) {
  const client = useApiClient();
  const scope = useScope();
  return useInfiniteQuery<ScenarioPage, Error, { pages: ScenarioPage[] }, readonly unknown[], string | undefined>({
    queryKey: [...scope, 'list', status],
    initialPageParam: undefined,
    queryFn: async ({ pageParam }) =>
      toScenarioPage(await client.read('listAllocationScenarios', { query: { limit: PAGE_SIZE, ...(status === '' ? {} : { status }), ...(pageParam === undefined ? {} : { cursor: pageParam }) } })),
    getNextPageParam: (last) => last.nextCursor,
    enabled: enabled && scope[1] !== undefined,
    retry: false,
  });
}

type Attempt = ReturnType<AttemptRegistry['forPayload']>;

/** One command: one idempotency attempt per intention; the scenarios are read again whatever the answer (a refusal can follow a step taken by somebody else), and the proposals when one was promoted. */
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
    onError: async (error) => {
      attempts.current.ended(error);
      await queryClient.invalidateQueries({ queryKey: ['cap', tenant?.id, tenant?.membershipId, 'scenario'] });
    },
  });
}

export function useCreateScenario() {
  const client = useApiClient();
  return useCommand((body: Record<string, unknown>, attempt) => client.command('createAllocationScenario', { body: body as never, attempt }));
}

export interface StepInput {
  id: string;
  version: number;
}

export function useRunScenario() {
  const client = useApiClient();
  return useCommand((input: StepInput, attempt) => client.command('runAllocationScenario', { path: { id: input.id }, body: {} as never, ifMatchVersion: input.version, attempt }));
}

export function usePromoteScenario() {
  const client = useApiClient();
  return useCommand((input: StepInput, attempt) => client.command('promoteAllocationScenario', { path: { id: input.id }, body: {} as never, ifMatchVersion: input.version, attempt }));
}
