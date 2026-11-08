import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../../api/ApiClientContext';
import { AttemptRegistry } from '../../../api/attempt-registry';
import { useSession } from '../../../session/SessionContext';
import { llmRoot } from '../hooks';
import { filterQuery, toChecklist, toCriteriaSet, toEditionPolicy, toException, toProviderRow, toRun, toRunPage } from './assist-model';
import type {
  AssistRun,
  AttestBody,
  ChecklistBody,
  Checklist,
  CreateRunBody,
  CriteriaBody,
  CriteriaSet,
  DecisionBody,
  EditionPolicy,
  ExceptionDecisionBody,
  ExceptionRequestBody,
  ExceptionRevokeBody,
  ExceptionRow,
  ExceptionStatus,
  ProviderRow,
  RunFilter,
  RunPage,
} from './assist-model';

/** Every read and every command of the assistant screens lives under this key of the tenant and the membership (what a person sees depends on the places the membership reaches), so one command refreshes them all. */
export function useAssistKey(): readonly ['llm-assist', string | undefined, string | undefined] {
  const { tenant } = useSession();
  return ['llm-assist', tenant?.id, tenant?.membershipId];
}

export interface Permit {
  /** The membership holds the permission (an unknown set of permissions is treated as holding all: the server still decides). */
  has: (permission: string) => boolean;
  /** The membership holds the permission and the workspace may change data (a suspended tenant is read-only). */
  can: (permission: string) => boolean;
}

export function usePermit(): Permit {
  const { permissions, mode } = useSession();
  const has = (permission: string): boolean => permissions === undefined || permissions.includes(permission);
  return { has, can: (permission) => has(permission) && mode !== 'READ_ONLY' };
}

export const RUN_PAGE = 25;

/** The history of the questions a page at a time, newest first, narrowed by the filter; a new filter keeps the list on the screen until the new one is there. */
export function useAssistRuns(filter: RunFilter) {
  const client = useApiClient();
  const key = useAssistKey();
  return useInfiniteQuery<RunPage, Error, { pages: RunPage[] }, readonly unknown[], string | undefined>({
    queryKey: [...key, 'runs', filter],
    initialPageParam: undefined,
    queryFn: async ({ pageParam }) => toRunPage(await client.read('listAiAssistRuns', { query: { limit: RUN_PAGE, ...filterQuery(filter), ...(pageParam === undefined ? {} : { cursor: pageParam }) } })),
    getNextPageParam: (last) => last.next,
    placeholderData: keepPreviousData,
    enabled: key[1] !== undefined,
    retry: false,
  });
}

/** One run with its statements; a run just created is the starting value, so the screen shows it at once and a command on it refreshes it. */
export function useAssistRun(id: string | undefined, initial?: AssistRun) {
  const client = useApiClient();
  const key = useAssistKey();
  return useQuery<AssistRun>({
    queryKey: [...key, 'run', id],
    queryFn: async () => toRun(await client.read('getAiAssistRun', { path: { id: id as string } })),
    enabled: key[1] !== undefined && id !== undefined,
    ...(initial === undefined ? {} : { initialData: initial, initialDataUpdatedAt: Date.now(), staleTime: 60_000 }),
    retry: false,
  });
}

/** The checklists (a status narrows them to the published ones the review picks from). */
export function useChecklists(status?: 'PUBLISHED') {
  const client = useApiClient();
  const key = useAssistKey();
  return useQuery<Checklist[]>({
    queryKey: [...key, 'checklists', status ?? 'all'],
    queryFn: async () => (await client.readAll('listAiReviewChecklists', { query: status === undefined ? {} : { status } })).flatMap((raw) => toChecklist(raw) ?? []),
    enabled: key[1] !== undefined,
    retry: false,
  });
}

export function useCriteriaSets(status?: 'PUBLISHED') {
  const client = useApiClient();
  const key = useAssistKey();
  return useQuery<CriteriaSet[]>({
    queryKey: [...key, 'criteria', status ?? 'all'],
    queryFn: async () => (await client.readAll('listAiEvalCriteriaSets', { query: status === undefined ? {} : { status } })).flatMap((raw) => toCriteriaSet(raw) ?? []),
    enabled: key[1] !== undefined,
    retry: false,
  });
}

/** The providers with where their data rests and their no-training attestation. */
export function useAssistProviders() {
  const client = useApiClient();
  const key = useAssistKey();
  return useQuery<ProviderRow[]>({
    queryKey: [...key, 'providers'],
    queryFn: async () => (await client.readAll('listAiProviders')).flatMap((raw) => toProviderRow(raw) ?? []),
    enabled: key[1] !== undefined,
    retry: false,
  });
}

export function useEditionPolicy() {
  const client = useApiClient();
  const key = useAssistKey();
  return useQuery<EditionPolicy>({
    queryKey: [...key, 'edition-policy'],
    queryFn: async () => toEditionPolicy(await client.read('getAiEditionPolicy')),
    enabled: key[1] !== undefined,
    retry: false,
  });
}

export function useExceptions(status: ExceptionStatus | '') {
  const client = useApiClient();
  const key = useAssistKey();
  return useQuery<ExceptionRow[]>({
    queryKey: [...key, 'exceptions', status],
    queryFn: async () => (await client.readAll('listAiExternalExceptions', { query: status === '' ? {} : { status } })).flatMap((raw) => toException(raw) ?? []),
    enabled: key[1] !== undefined,
    placeholderData: keepPreviousData,
    retry: false,
  });
}

/** One exception with the log of its uses; nothing is read until one is chosen. */
export function useException(id: string | undefined) {
  const client = useApiClient();
  const key = useAssistKey();
  return useQuery<ExceptionRow>({
    queryKey: [...key, 'exception', id],
    queryFn: async () => {
      const found = toException(await client.read('getAiExternalException', { path: { id: id as string } }));
      if (found === undefined) throw new Error('unexpected exception');
      return found;
    },
    enabled: key[1] !== undefined && id !== undefined,
    retry: false,
  });
}

/** A command: one idempotency attempt for the same payload, and every read of the assistant (and of the AI registry, which shares the providers) refreshed when it succeeds. */
function useAssistCommand<Input, Output = unknown>(send: (client: ReturnType<typeof useApiClient>, input: Input, attempt: ReturnType<AttemptRegistry['forPayload']>) => Promise<Output>) {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const { tenant } = useSession();
  const key = useAssistKey();
  const attempts = useRef(new AttemptRegistry());
  return useMutation<Output, Error, Input>({
    mutationFn: (input: Input) => send(client, input, attempts.current.forPayload(input)),
    onSuccess: async () => {
      attempts.current.done();
      await Promise.all([queryClient.invalidateQueries({ queryKey: key }), queryClient.invalidateQueries({ queryKey: llmRoot(tenant?.id) })]);
    },
    onError: (error) => attempts.current.ended(error),
  });
}

export function useCreateRun() {
  return useAssistCommand<CreateRunBody, AssistRun>(async (client, body, attempt) => toRun(await client.command('createAiAssistRun', { body, attempt })));
}

export interface DecideInput {
  runId: string;
  body: DecisionBody;
}

export function useDecideRun() {
  return useAssistCommand<DecideInput>((client, input, attempt) => client.command('decideAiAssistRun', { path: { id: input.runId }, body: input.body, attempt }));
}

export function useCreateChecklist() {
  return useAssistCommand<ChecklistBody>((client, body, attempt) => client.command('createAiReviewChecklist', { body, attempt }));
}

export interface PublishInput {
  id: string;
  version: number;
}

export function usePublishChecklist() {
  return useAssistCommand<PublishInput>((client, input, attempt) => client.command('publishAiReviewChecklist', { path: { id: input.id }, ifMatchVersion: input.version, attempt }));
}

export function useCreateCriteria() {
  return useAssistCommand<CriteriaBody>((client, body, attempt) => client.command('createAiEvalCriteriaSet', { body, attempt }));
}

export function usePublishCriteria() {
  return useAssistCommand<PublishInput>((client, input, attempt) => client.command('publishAiEvalCriteriaSet', { path: { id: input.id }, ifMatchVersion: input.version, attempt }));
}

export interface AttestInput {
  providerId: string;
  version: number;
  body: AttestBody;
}

export function useAttestProvider() {
  return useAssistCommand<AttestInput>((client, input, attempt) => client.command('attestAiProvider', { path: { id: input.providerId }, ifMatchVersion: input.version, body: input.body, attempt }));
}

export function useRequestException() {
  return useAssistCommand<ExceptionRequestBody>((client, body, attempt) => client.command('requestAiExternalException', { body, attempt }));
}

export interface ExceptionDecideInput {
  id: string;
  version: number;
  body: ExceptionDecisionBody;
}

export function useDecideException() {
  return useAssistCommand<ExceptionDecideInput>((client, input, attempt) => client.command('decideAiExternalException', { path: { id: input.id }, ifMatchVersion: input.version, body: input.body, attempt }));
}

export interface ExceptionRevokeInput {
  id: string;
  version: number;
  body: ExceptionRevokeBody;
}

export function useRevokeException() {
  return useAssistCommand<ExceptionRevokeInput>((client, input, attempt) => client.command('revokeAiExternalException', { path: { id: input.id }, ifMatchVersion: input.version, body: input.body, attempt }));
}

/** Reads everything of the assistant again: what a person does when the record moved under them (a version conflict, a decision made by someone else). */
export function useReload(): () => void {
  const queryClient = useQueryClient();
  const key = useAssistKey();
  return () => {
    void queryClient.invalidateQueries({ queryKey: key });
  };
}
