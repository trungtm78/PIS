import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../../api/ApiClientContext';
import { AttemptRegistry } from '../../../api/attempt-registry';
import { useSession } from '../../../session/SessionContext';
import { toEvaluation } from './model';
import type { Evaluation } from './model';

// What the screen shows depends on the projects the signed-in membership reaches, not only on the tenant: the membership is part of every key.
function useScopeKey(): readonly ['mne-evaluation', string | undefined, string | undefined] {
  const { tenant } = useSession();
  return ['mne-evaluation', tenant?.id, tenant?.membershipId];
}

/** The evaluations in the scope of the caller, the newest first; those of one project and one status when they are named. Every page is read. */
export function useEvaluations(projectId: string, status: string, enabled: boolean) {
  const client = useApiClient();
  const key = useScopeKey();
  const query: Record<string, string> = {};
  if (projectId !== '') query.project_id = projectId;
  if (status !== '') query.status = status;
  return useQuery<Evaluation[]>({
    queryKey: [...key, 'list', projectId, status],
    queryFn: async () => (await client.readAll('listMneEvaluations', { query })).flatMap((raw) => toEvaluation(raw) ?? []),
    enabled: enabled && key[1] !== undefined,
    retry: false,
  });
}

/** The projects the caller can be evaluated for, by code: the right to read the evaluations is enough (the register of projects is not asked). */
export interface ProjectChoice {
  id: string;
  code: string;
  name: string;
}

export function useEvaluationProjects(enabled: boolean) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<ProjectChoice[]>({
    queryKey: [...key, 'projects'],
    queryFn: async () =>
      (await client.readAll('listMneEvaluationProjects')).flatMap((raw): ProjectChoice[] => {
        const row = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
        return typeof row.id === 'string' && typeof row.code === 'string' ? [{ id: row.id, code: row.code, name: typeof row.name === 'string' ? row.name : '' }] : [];
      }),
    enabled: enabled && key[1] !== undefined,
    retry: false,
  });
}

/** One mutation hook: one idempotency attempt per intention, the evaluations read again after the command, also after a refusal (it can follow a step taken by somebody else). */
function useCommand<Input>(send: (input: Input, attempt: ReturnType<AttemptRegistry['forPayload']>) => Promise<unknown>) {
  const queryClient = useQueryClient();
  const key = useScopeKey();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: (input: Input) => send(input, attempts.current.forPayload(input)),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: key });
    },
    onError: async (error) => {
      attempts.current.ended(error);
      await queryClient.invalidateQueries({ queryKey: key });
    },
  });
}

export function usePlanEvaluation() {
  const client = useApiClient();
  return useCommand<Record<string, unknown>>((body, attempt) => client.command('planMneEvaluation', { body: body as never, attempt }));
}

export interface VersionedInput {
  id: string;
  version: number;
  body: Record<string, unknown>;
}

export function useSubmitEvaluation() {
  const client = useApiClient();
  return useCommand<VersionedInput>((input, attempt) => client.command('submitMneEvaluation', { path: { id: input.id }, body: input.body as never, ifMatchVersion: input.version, attempt }));
}

export function useDecideEvaluation() {
  const client = useApiClient();
  return useCommand<VersionedInput>((input, attempt) => client.command('decideMneEvaluation', { path: { id: input.id }, body: input.body as never, ifMatchVersion: input.version, attempt }));
}
