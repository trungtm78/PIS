import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../api/ApiClientContext';
import { AttemptRegistry } from '../../api/attempt-registry';
import { useSession } from '../../session/SessionContext';
import { decisionBody, planBody, toLineOption, toPackageLine, toPlanLine, toProjectRef } from './plan-model';
import type { DecisionForm, LineOption, PackageLine, PlanForm, PlanLine, ProjectRef } from './plan-model';

// What the plans show depends on who is signed in (a plan in work is for those who plan and approve), so the membership is part of every key.
function useScopeKey(): readonly ['bid-plans', string | undefined, string | undefined] {
  const { tenant } = useSession();
  return ['bid-plans', tenant?.id, tenant?.membershipId];
}

/** The plans the caller may see, the newest first. */
export function usePlans() {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<PlanLine[]>({
    queryKey: [...key, 'plans'],
    queryFn: async () => (await client.readAll('listProcurementPlans')).flatMap((raw) => toPlanLine(raw) ?? []),
    enabled: key[1] !== undefined,
    retry: false,
  });
}

/** The packages the caller may see. */
export function usePackages() {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<PackageLine[]>({
    queryKey: [...key, 'packages'],
    queryFn: async () => (await client.readAll('get_resources_procurement_package')).flatMap((raw) => toPackageLine(raw) ?? []),
    enabled: key[1] !== undefined,
    retry: false,
  });
}

/** The projects of the scope of the caller, as suggestions for the editor; a caller who may not read them gets none and types the identifier. */
export function useProjectChoices() {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<ProjectRef[]>({
    queryKey: [...key, 'projects'],
    queryFn: async () => (await client.readAll('get_resources_project')).flatMap((raw) => toProjectRef(raw) ?? []),
    enabled: key[1] !== undefined,
    retry: false,
  });
}

/** The published lines of capital, as suggestions for the editor. */
export function useLineChoices() {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<LineOption[]>({
    queryKey: [...key, 'lines'],
    queryFn: async () => (await client.readAll('get_resources_allocation_line')).flatMap((raw) => toLineOption(raw) ?? []),
    enabled: key[1] !== undefined,
    retry: false,
  });
}

/** The contract types the items of the packages as an open object (TODOS.md, ST-BID-001: the item schema is staged for the contract), so the typed body takes the allowlisted items through this one cast. */
function contractBodyOf(form: PlanForm): { project_id: string; title: string; legal_basis: string; packages: Array<Record<string, never>> } {
  const body = planBody(form);
  return { ...body, packages: body.packages as unknown as Array<Record<string, never>> };
}

/** One mutation hook: one idempotency attempt per intention, the cached reads of the plans refreshed on success. */
function useCommand<Input>(send: (input: Input, attempt: ReturnType<AttemptRegistry['forPayload']>) => Promise<{ resource_id?: string; resource_version?: number; status?: string }>) {
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
  return useCommand<PlanForm>((form, attempt) => client.command('createProcurementPlan', { body: contractBodyOf(form), attempt }));
}

export interface SubmitInput {
  id: string;
  version: number;
}

export function useSubmitPlan() {
  const client = useApiClient();
  return useCommand<SubmitInput>((input, attempt) => client.command('submitProcurementPlan', { path: { id: input.id }, ifMatchVersion: input.version, attempt }));
}

export interface DecideInput {
  id: string;
  version: number;
  form: DecisionForm;
}

export function useDecidePlan() {
  const client = useApiClient();
  return useCommand<DecideInput>((input, attempt) =>
    client.command('decideProcurementPlan', { path: { id: input.id }, body: decisionBody(input.form), ifMatchVersion: input.version, attempt }),
  );
}
