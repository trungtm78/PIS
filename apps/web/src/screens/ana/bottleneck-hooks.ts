import { useMutation, useQuery, keepPreviousData, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../api/ApiClientContext';
import { AttemptRegistry } from '../../api/attempt-registry';
import { useSession } from '../../session/SessionContext';
import { HALT_STATUSES, toAnalysis, toDossier, toHaltedList } from './bottleneck-model';
import type { Analysis, Dossier, HaltedList } from './bottleneck-model';

const root = (tenantId: string | undefined, membershipId: string | undefined) => ['ana', tenantId, membershipId, 'halt'] as const;
const base = { retry: false, staleTime: 0, refetchOnWindowFocus: false } as const;

export interface BottleneckFilter {
  cause: string;
  bucket: string;
}

export function useBottlenecks(filter: BottleneckFilter) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<Analysis>({
    queryKey: [...root(tenant?.id, tenant?.membershipId), 'analysis', filter.cause, filter.bucket],
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const analysis = toAnalysis(await client.read('getBottleneckAnalysis', { query: { ...(filter.cause === '' ? {} : { cause: filter.cause }), ...(filter.bucket === '' ? {} : { bucket: filter.bucket }) } }));
      if (analysis === undefined) throw new Error('the bottlenecks could not be read');
      return analysis;
    },
    enabled: tenant !== undefined,
    ...base,
  });
}

export function useHaltedProjects(status: string) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<HaltedList>({
    queryKey: [...root(tenant?.id, tenant?.membershipId), 'list', status],
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const known = HALT_STATUSES.find((one) => one === status);
      const result = toHaltedList(await client.read('listHaltedProjects', { query: known === undefined ? {} : { status: known } }));
      if (result === undefined) throw new Error('the halted projects could not be read');
      return result;
    },
    enabled: tenant !== undefined,
    ...base,
  });
}

export function useHaltedProject(id: string) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<Dossier>({
    queryKey: [...root(tenant?.id, tenant?.membershipId), 'one', id],
    queryFn: async () => {
      const dossier = toDossier(await client.read('getHaltedProject', { path: { id } }));
      if (dossier === undefined) throw new Error('the halted project could not be read');
      return dossier;
    },
    enabled: tenant !== undefined && id !== '',
    ...base,
  });
}

export interface HaltInput {
  projectId: string;
  reasonCode: string;
  reasonText: string;
  haltedOn: string;
  orderRef: string;
  expectedRestartOn: string;
}
export interface PlanInput {
  id: string;
  steps: Array<{ title: string; ownerUnitId: string; dueOn: string }>;
  expectedRestartOn: string;
}
export interface PlanDecisionInput {
  id: string;
  decision: 'APPROVE' | 'RETURN';
  note: string;
}
export interface StepInput {
  id: string;
  stepId: string;
  status: 'DONE' | 'DROPPED';
  note: string;
}
export interface CloseInput {
  id: string;
  outcome: 'RESTARTED' | 'CANCELLED';
  note: string;
  restartedOn: string;
}

/** The five commands of the halt dossier; each intention keeps one idempotency attempt across retries and the lists and the open dossier are read again after a success so the server stays the truth. */
export function useHaltCommands() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const { tenant } = useSession();
  const attempts = { record: useRef(new AttemptRegistry()), plan: useRef(new AttemptRegistry()), decide: useRef(new AttemptRegistry()), step: useRef(new AttemptRegistry()), close: useRef(new AttemptRegistry()) };
  const refresh = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: root(tenant?.id, tenant?.membershipId) });
  };
  const record = useMutation({
    mutationFn: (input: HaltInput) => {
      const body = { project_id: input.projectId, reason_code: input.reasonCode, reason_text: input.reasonText.trim(), halted_on: input.haltedOn, ...(input.orderRef.trim() === '' ? {} : { order_ref: input.orderRef.trim() }), ...(input.expectedRestartOn === '' ? {} : { expected_restart_on: input.expectedRestartOn }) };
      return client.command('recordProjectHalt', { body, attempt: attempts.record.current.forPayload(body) });
    },
    onSuccess: async () => {
      attempts.record.current.done();
      await refresh();
    },
    onError: (error) => attempts.record.current.ended(error),
  });
  const plan = useMutation({
    mutationFn: (input: PlanInput) => {
      const body = { steps: input.steps.map((step) => ({ title: step.title.trim(), owner_unit_id: step.ownerUnitId, due_on: step.dueOn })), ...(input.expectedRestartOn === '' ? {} : { expected_restart_on: input.expectedRestartOn }) };
      return client.command('saveRestartPlan', { path: { id: input.id }, body, attempt: attempts.plan.current.forPayload({ id: input.id, ...body }) });
    },
    onSuccess: async () => {
      attempts.plan.current.done();
      await refresh();
    },
    onError: (error) => attempts.plan.current.ended(error),
  });
  const decide = useMutation({
    mutationFn: (input: PlanDecisionInput) => {
      const body = { decision: input.decision, note: input.note.trim() };
      return client.command('decideRestartPlan', { path: { id: input.id }, body, attempt: attempts.decide.current.forPayload({ id: input.id, ...body }) });
    },
    onSuccess: async () => {
      attempts.decide.current.done();
      await refresh();
    },
    onError: (error) => attempts.decide.current.ended(error),
  });
  const step = useMutation({
    mutationFn: (input: StepInput) => {
      const body = { status: input.status, note: input.note.trim() };
      return client.command('closeRestartStep', { path: { id: input.id, step_id: input.stepId }, body, attempt: attempts.step.current.forPayload({ id: input.id, stepId: input.stepId, ...body }) });
    },
    onSuccess: async () => {
      attempts.step.current.done();
      await refresh();
    },
    onError: (error) => attempts.step.current.ended(error),
  });
  const close = useMutation({
    mutationFn: (input: CloseInput) => {
      const body = { outcome: input.outcome, note: input.note.trim(), ...(input.outcome === 'RESTARTED' ? { restarted_on: input.restartedOn } : {}) };
      return client.command('closeProjectHalt', { path: { id: input.id }, body, attempt: attempts.close.current.forPayload({ id: input.id, ...body }) });
    },
    onSuccess: async () => {
      attempts.close.current.done();
      await refresh();
    },
    onError: (error) => attempts.close.current.ended(error),
  });
  return { record, plan, decide, step, close };
}
