import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../../api/ApiClientContext';
import { AttemptRegistry } from '../../../api/attempt-registry';
import { useScopeKey } from '../hooks';
import { toPlanItem, toPlanLine } from './model';
import type { DraftBody, ItemBody, PlanItem, PlanLine } from './model';

/** The plans of a project, every revision of them, by code. */
export function usePlans(projectId: string | undefined) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<PlanLine[]>({
    queryKey: [...key, 'plans', projectId ?? ''],
    queryFn: async () => (await client.readAll('listCompensationPlans', { query: { project_id: projectId ?? '' } })).flatMap((raw) => toPlanLine(raw) ?? []),
    enabled: key[1] !== undefined && projectId !== undefined,
    retry: false,
  });
}

/** The items of one plan inside the units of the caller. */
export function usePlanItems(planId: string | undefined) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<PlanItem[]>({
    queryKey: [...key, 'plan-items', planId ?? ''],
    queryFn: async () => (await client.readAll('listCompensationPlanItems', { path: { id: planId ?? '' } })).flatMap((raw) => toPlanItem(raw) ?? []),
    enabled: key[1] !== undefined && planId !== undefined,
    retry: false,
  });
}

/** The drafting of a plan: one idempotency attempt per intention, every cached read of the land screens refreshed on success. */
export function useDraftPlan() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const key = useScopeKey();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: (body: DraftBody) => client.command('draftCompensationPlan', { body, attempt: attempts.current.forPayload(body) }),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: key });
    },
    onError: (error) => attempts.current.ended(error),
  });
}

export interface AddItemsInput {
  id: string;
  version: number;
  items: ItemBody[];
}

/** Items added to a draft, under the version of the plan the caller saw. */
export function useAddItems() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const key = useScopeKey();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: (input: AddItemsInput) =>
      client.command('addCompensationPlanItems', { path: { id: input.id }, body: { items: input.items }, ifMatchVersion: input.version, attempt: attempts.current.forPayload(input) }),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: key });
    },
    onError: (error) => attempts.current.ended(error),
  });
}

export interface ReviseInput {
  id: string;
  version: number;
  reason: string;
}

/** A new revision of a plan that was posted or approved, under the version the caller saw. */
export function useRevisePlan() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const key = useScopeKey();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: (input: ReviseInput) =>
      client.command('revisePlan', { path: { id: input.id }, body: { reason: input.reason.trim() }, ifMatchVersion: input.version, attempt: attempts.current.forPayload(input) }),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: key });
    },
    onError: (error) => attempts.current.ended(error),
  });
}
