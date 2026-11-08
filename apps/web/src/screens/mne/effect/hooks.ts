import { ApiError } from '@machvon/api-client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../../api/ApiClientContext';
import { AttemptRegistry } from '../../../api/attempt-registry';
import { useSession } from '../../../session/SessionContext';
import { toCalendarResult, toEffectView } from './model';
import type { CalendarResult, EffectView } from './model';

/** What these screens show depends on the scope of the membership that is signed in, not only on the tenant: the membership is part of every key. */
export function useScopeKey(): readonly ['mne-effect', string | undefined, string | undefined] {
  const { tenant } = useSession();
  return ['mne-effect', tenant?.id, tenant?.membershipId];
}

/** The effectiveness of a project; null when it is not there for the caller (a 404), any other failure is the failure of the read, never "nothing". */
export function useEffectiveness(projectId: string | undefined) {
  const client = useApiClient();
  const scope = useScopeKey();
  return useQuery<EffectView | null>({
    queryKey: [...scope, 'view', projectId ?? ''],
    queryFn: async () => {
      try {
        return toEffectView(await client.read('getProjectEffectiveness' as never, { path: { id: projectId ?? '' } } as never)) ?? null;
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return null;
        throw error;
      }
    },
    enabled: scope[1] !== undefined && projectId !== undefined,
    retry: false,
  });
}

type Attempt = ReturnType<AttemptRegistry['forPayload']>;

/** One mutation hook: one idempotency attempt per intention, the reads of the project read again on success. */
function useCommand<Input, Answer = unknown>(send: (input: Input, attempt: Attempt) => Promise<unknown>, answer: (raw: unknown) => Answer) {
  const queryClient = useQueryClient();
  const scope = useScopeKey();
  const attempts = useRef(new AttemptRegistry());
  return useMutation<Answer, Error, Input>({
    mutationFn: async (input) => answer(await send(input, attempts.current.forPayload(input))),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: scope });
    },
    onError: (error) => attempts.current.ended(error),
  });
}

const same = (raw: unknown): unknown => raw;

export interface BodyInput {
  projectId: string;
  body: Record<string, unknown>;
}

export interface VersionedInput {
  id: string;
  version: number;
  body?: Record<string, unknown>;
}

export function useSaveDraft() {
  const client = useApiClient();
  return useCommand((input: BodyInput, attempt) => client.command('saveEffectTargetDraft' as never, { path: { id: input.projectId }, body: input.body, attempt } as never), same);
}

export function useFixTargets() {
  const client = useApiClient();
  return useCommand((input: VersionedInput, attempt) => client.command('fixEffectTargets' as never, { path: { id: input.id }, ifMatchVersion: input.version, attempt } as never), same);
}

export function useRecordMeasurement() {
  const client = useApiClient();
  return useCommand((input: BodyInput, attempt) => client.command('recordEffectMeasurement' as never, { path: { id: input.projectId }, body: input.body, attempt } as never), same);
}

export function useGenerateCalendar() {
  const client = useApiClient();
  return useCommand<{ projectId: string }, CalendarResult>((input, attempt) => client.command('generateEffectCalendar' as never, { path: { id: input.projectId }, attempt } as never), toCalendarResult);
}

export function useSubmitAssessment() {
  const client = useApiClient();
  return useCommand((input: BodyInput, attempt) => client.command('submitEffectAssessment' as never, { path: { id: input.projectId }, body: input.body, attempt } as never), same);
}

export function useDecideAssessment() {
  const client = useApiClient();
  return useCommand((input: VersionedInput, attempt) => client.command('decideEffectAssessment' as never, { path: { id: input.id }, body: input.body ?? {}, ifMatchVersion: input.version, attempt } as never), same);
}
