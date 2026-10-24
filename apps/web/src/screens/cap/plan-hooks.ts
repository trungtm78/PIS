import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../api/ApiClientContext';
import { AttemptRegistry } from '../../api/attempt-registry';
import { useSession } from '../../session/SessionContext';
import { toPlan, toPlanLines, toProjectOption, toUnitOption } from './plan-model';
import type { CreatePlanBody, DraftBody, PlanLines, PlanSummary, ProjectOption, UnitOption } from './plan-model';

const PAGE_SIZE = 200;

// What the plans show is the capital of the tenant for the member that is signed in: the membership is part of every key.
function useScopeKey(): readonly ['cap', string | undefined, string | undefined] {
  const { tenant } = useSession();
  return ['cap', tenant?.id, tenant?.membershipId];
}

/** Every plan revision the caller may see, newest first (a revision in work only for the people who draft and approve). */
export function usePlans() {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<PlanSummary[]>({
    queryKey: [...key, 'plans'],
    queryFn: async () => (await client.readAll('get_resources_plan_version')).flatMap((raw) => toPlan(raw) ?? []),
    enabled: key[1] !== undefined,
    retry: false,
  });
}

/** One plan with all its lines in the scope of the caller: the pages of `listCapitalPlanLines` are followed to the end. */
export function usePlanLines(planId: string | undefined) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<PlanLines | undefined>({
    queryKey: [...key, 'plan-lines', planId],
    queryFn: async () => {
      let first: PlanLines | undefined;
      let cursor: string | undefined;
      do {
        const page = toPlanLines(await client.read('listCapitalPlanLines', { path: { id: planId as string }, query: { limit: PAGE_SIZE, ...(cursor === undefined ? {} : { cursor }) } }));
        if (page === undefined) return undefined;
        first = first === undefined ? page : { ...first, lines: [...first.lines, ...page.lines] };
        cursor = page.nextCursor ?? undefined;
      } while (cursor !== undefined);
      return first;
    },
    enabled: key[1] !== undefined && planId !== undefined,
    retry: false,
  });
}

/** The projects of the register the caller may read, for the choice of the project a line is for. */
export function useProjects(enabled = true) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<ProjectOption[]>({
    queryKey: [...key, 'projects'],
    queryFn: async () => (await client.readAll('get_resources_project')).flatMap((raw) => toProjectOption(raw) ?? []),
    enabled: enabled && key[1] !== undefined,
    retry: false,
  });
}

/** The units of the tenant the caller may read, for the choice of the unit a plan belongs to. */
export function usePlanUnits(enabled = true) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<UnitOption[]>({
    queryKey: [...key, 'units'],
    queryFn: async () => (await client.readAll('get_resources_organization_unit')).flatMap((raw) => toUnitOption(raw) ?? []),
    enabled: enabled && key[1] !== undefined,
    retry: false,
  });
}

/** One mutation hook: one idempotency attempt per intention, the cached reads of the plans refreshed on success. */
function useCommand<Input>(send: (input: Input, attempt: ReturnType<AttemptRegistry['forPayload']>) => Promise<{ resource_id?: string; resource_version?: number }>) {
  const queryClient = useQueryClient();
  const key = useScopeKey();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: (input: Input) => send(input, attempts.current.forPayload(input)),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: key });
    },
    onError: (error) => attempts.current.ended(error),
  });
}

export function useCreatePlan() {
  const client = useApiClient();
  return useCommand<CreatePlanBody>((body, attempt) => client.command('createCapitalPlan', { body, attempt }));
}

export interface DraftInput {
  planId: string;
  /** The version of the plan the planner saw: the draft is refused if another planner saved since. */
  version: number;
  body: DraftBody;
}

export function useDraftAllocation() {
  const client = useApiClient();
  return useCommand<DraftInput>((input, attempt) => client.command('draftCapitalAllocation', { path: { id: input.planId }, body: input.body, ifMatchVersion: input.version, attempt }));
}
