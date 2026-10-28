import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../api/ApiClientContext';
import { AttemptRegistry } from '../../api/attempt-registry';
import { useSession } from '../../session/SessionContext';
import { filterQuery, toRequestPage, toRouteDecision } from './gateway-model';
import type { RequestFilter, RequestPage, RouteDecision } from './gateway-model';
import { datasetBody, profileBody, promptBody, toDataset, toProfile, toPrompt, toRun } from './eval-model';
import type { DatasetEntry, DatasetValues, ProfileEntry, ProfileValues, PromptEntry, PromptValues, RunEntry } from './eval-model';
import { budgetBody, keyBody, modelBody, policyBody, priceBody, providerBody, toBudget, toKey, toModel, toPolicyBook, toPrice, toProvider, toReservationPage, toSpend } from './llm-model';
import type { BudgetEntry, BudgetValues, KeyEntry, KeyValues, ModelEntry, ModelValues, PolicyBook, PolicyValues, PriceEntry, PriceValues, Provider, ProviderValues, ReservationPage, ReservationStatus, Route, Spend } from './llm-model';

/** Every read and every mutation of the AI registry screens lives under this key of the tenant, so one command refreshes them all. */
export const llmRoot = (tenantId: string | undefined) => ['llm', tenantId] as const;

export function useProviders() {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<Provider[]>({
    queryKey: [...llmRoot(tenant?.id), 'providers', tenant?.membershipId],
    queryFn: async () => (await client.readAll('listAiProviders')).flatMap((raw) => toProvider(raw) ?? []),
    enabled: tenant !== undefined,
    retry: false,
  });
}

export function useModels() {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<ModelEntry[]>({
    queryKey: [...llmRoot(tenant?.id), 'models', tenant?.membershipId],
    queryFn: async () => (await client.readAll('listAiModels')).flatMap((raw) => toModel(raw) ?? []),
    enabled: tenant !== undefined,
    retry: false,
  });
}

export function usePolicies() {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<PolicyBook>({
    queryKey: [...llmRoot(tenant?.id), 'policies', tenant?.membershipId],
    queryFn: async () => toPolicyBook(await client.readAll('listAiClassificationPolicies')),
    enabled: tenant !== undefined,
    retry: false,
  });
}

export function useKeys() {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<KeyEntry[]>({
    queryKey: [...llmRoot(tenant?.id), 'keys', tenant?.membershipId],
    queryFn: async () => (await client.readAll('listAiVirtualKeys')).flatMap((raw) => toKey(raw) ?? []),
    enabled: tenant !== undefined,
    retry: false,
  });
}

/** A command of the registry: a stable idempotency key for the same payload, and every read of the tenant refreshed when it succeeds. */
function useRegistryCommand<Input>(send: (client: ReturnType<typeof useApiClient>, input: Input, attempt: ReturnType<AttemptRegistry['forPayload']>) => Promise<unknown>) {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const { tenant } = useSession();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: (input: Input) => send(client, input, attempts.current.forPayload(input)),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: llmRoot(tenant?.id) });
    },
    onError: (error) => attempts.current.ended(error),
  });
}

export function useRegisterProvider() {
  return useRegistryCommand<ProviderValues>((client, values, attempt) => client.command('registerAiProvider', { body: providerBody(values), attempt }));
}

export interface ActivationInput {
  providerId: string;
  version: number;
  d07Ref: string;
}

export function useActivateProvider() {
  return useRegistryCommand<ActivationInput>((client, input, attempt) => client.command('activateAiProvider', { path: { id: input.providerId }, ifMatchVersion: input.version, body: input.d07Ref.trim() === '' ? {} : { d07_approval_ref: input.d07Ref.trim() }, attempt }));
}

export function useRegisterModel() {
  return useRegistryCommand<ModelValues>((client, values, attempt) => client.command('registerAiModel', { body: modelBody(values), attempt }));
}

export function useDraftPolicy() {
  return useRegistryCommand<PolicyValues>((client, values, attempt) => client.command('createAiClassificationPolicy', { body: policyBody(values), attempt }));
}

export interface PublishInput {
  policyId: string;
  version: number;
}

export function usePublishPolicy() {
  return useRegistryCommand<PublishInput>((client, input, attempt) => client.command('publishAiClassificationPolicy', { path: { id: input.policyId }, ifMatchVersion: input.version, attempt }));
}

export function useCreateKey() {
  return useRegistryCommand<KeyValues>((client, values, attempt) => client.command('createAiVirtualKey', { body: keyBody(values), attempt }));
}

export interface KeyAction {
  keyId: string;
  version: number;
}

export function useRotateKey() {
  return useRegistryCommand<KeyAction>((client, input, attempt) => client.command('rotateAiVirtualKey', { path: { id: input.keyId }, ifMatchVersion: input.version, attempt }));
}

export interface RevokeInput extends KeyAction {
  reason: string;
}

export function useRevokeKey() {
  return useRegistryCommand<RevokeInput>((client, input, attempt) => client.command('revokeAiVirtualKey', { path: { id: input.keyId }, ifMatchVersion: input.version, body: { reason: input.reason.trim() }, attempt }));
}

export function useBudgets() {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<BudgetEntry[]>({
    queryKey: [...llmRoot(tenant?.id), 'budgets', tenant?.membershipId],
    queryFn: async () => (await client.readAll('listAiBudgets')).flatMap((raw) => toBudget(raw) ?? []),
    enabled: tenant !== undefined,
    retry: false,
  });
}

export function usePrices() {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<PriceEntry[]>({
    queryKey: [...llmRoot(tenant?.id), 'prices', tenant?.membershipId],
    queryFn: async () => (await client.readAll('listAiPricingVersions')).flatMap((raw) => toPrice(raw) ?? []),
    enabled: tenant !== undefined,
    retry: false,
  });
}

/** The spend of a budget (LLM-09); nothing is read until a budget is chosen. */
export function useSpend(budgetId: string | undefined) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<Spend | undefined>({
    queryKey: [...llmRoot(tenant?.id), 'spend', budgetId, tenant?.membershipId],
    queryFn: async () => toSpend(await client.read('getAiSpendSummary', { path: { id: budgetId as string } })),
    enabled: tenant !== undefined && budgetId !== undefined,
    retry: false,
  });
}

export const RESERVATION_PAGE = 50;

/** The reservations a page at a time, newest first (the list grows with every request): a status narrows it, and the next page is asked for when the person wants it. */
export function useReservations(status?: ReservationStatus) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useInfiniteQuery<ReservationPage, Error, { pages: ReservationPage[] }, readonly unknown[], string | undefined>({
    queryKey: [...llmRoot(tenant?.id), 'reservations', status ?? 'all', tenant?.membershipId],
    initialPageParam: undefined,
    queryFn: async ({ pageParam }) =>
      toReservationPage(
        await client.read('get_resources_budget_reservation', {
          query: { limit: RESERVATION_PAGE, ...(status === undefined ? {} : { status }), ...(pageParam === undefined ? {} : { cursor: pageParam }) },
        }),
      ),
    getNextPageParam: (last) => last.next,
    enabled: tenant !== undefined,
    retry: false,
  });
}

export function useCreateBudget() {
  return useRegistryCommand<BudgetValues>((client, values, attempt) => client.command('createAiBudget', { body: budgetBody(values), attempt }));
}

export interface PriceInput {
  values: PriceValues;
  modelId: string;
}

export function useRegisterPrice() {
  return useRegistryCommand<PriceInput>((client, input, attempt) => client.command('registerPricingVersion', { body: priceBody(input.values, input.modelId), attempt }));
}

// ---- the evaluation gate (ST-LLM-004) -------------------------------------------------------------------------------------------------------

export function usePrompts() {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<PromptEntry[]>({
    queryKey: [...llmRoot(tenant?.id), 'prompts', tenant?.membershipId],
    queryFn: async () => (await client.readAll('listAiPrompts')).flatMap((raw) => toPrompt(raw) ?? []),
    enabled: tenant !== undefined,
    retry: false,
  });
}

export function useDatasets() {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<DatasetEntry[]>({
    queryKey: [...llmRoot(tenant?.id), 'datasets', tenant?.membershipId],
    queryFn: async () => (await client.readAll('listAiEvalDatasets')).flatMap((raw) => toDataset(raw) ?? []),
    enabled: tenant !== undefined,
    retry: false,
  });
}

export function useProfiles() {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<ProfileEntry[]>({
    queryKey: [...llmRoot(tenant?.id), 'profiles', tenant?.membershipId],
    queryFn: async () => (await client.readAll('get_resources_model_profile_version')).flatMap((raw) => toProfile(raw) ?? []),
    enabled: tenant !== undefined,
    retry: false,
  });
}

/** The evaluations of one profile (all of them while none is chosen): the page of the release asks for the profile it shows. */
export function useEvalRuns(profileId?: string) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<RunEntry[]>({
    queryKey: [...llmRoot(tenant?.id), 'runs', profileId ?? 'all', tenant?.membershipId],
    queryFn: async () => (await client.readAll('get_resources_ai_eval_run', profileId === undefined ? {} : { query: { profile_version_id: profileId } })).flatMap((raw) => toRun(raw) ?? []),
    enabled: tenant !== undefined,
    retry: false,
  });
}

export function useCreatePrompt() {
  return useRegistryCommand<PromptValues>((client, values, attempt) => client.command('createAiPromptVersion', { body: promptBody(values), attempt }));
}

export interface PromptRevision {
  promptId: string;
  version: number;
  values: PromptValues;
}

export function useRevisePrompt() {
  return useRegistryCommand<PromptRevision>((client, input, attempt) => client.command('reviseAiPromptVersion', { path: { id: input.promptId }, ifMatchVersion: input.version, body: promptBody(input.values), attempt }));
}

export interface PromptApproval {
  promptId: string;
  version: number;
}

export function useApprovePrompt() {
  return useRegistryCommand<PromptApproval>((client, input, attempt) => client.command('approveAiPromptVersion', { path: { id: input.promptId }, ifMatchVersion: input.version, attempt }));
}

export function useCreateDataset() {
  return useRegistryCommand<DatasetValues>((client, values, attempt) => client.command('createAiEvalDataset', { body: datasetBody(values), attempt }));
}

export interface ProfileDraft {
  values: ProfileValues;
  providerModelId: string;
}

export function useDraftProfile() {
  return useRegistryCommand<ProfileDraft>((client, input, attempt) => client.command('createModelProfileVersion', { body: profileBody(input.values, input.providerModelId), attempt }));
}

export interface EvalStart {
  profileId: string;
  datasetId: string;
  route: Route;
}

export function useStartEvalRun() {
  return useRegistryCommand<EvalStart>((client, input, attempt) => client.command('startAiEvalRun', { body: { profile_version_id: input.profileId, dataset_version_id: input.datasetId, route_class: input.route }, attempt }));
}

export interface EvalSignature {
  runId: string;
  version: number;
  decision: 'PASS' | 'FAIL';
  comment: string;
}

export function useSignEvalRun() {
  return useRegistryCommand<EvalSignature>((client, input, attempt) => client.command('signAiEvalRun', { path: { id: input.runId }, ifMatchVersion: input.version, body: { decision: input.decision, comment: input.comment.trim() }, attempt }));
}

export interface ProfileDecision {
  profileId: string;
  version: number;
  decision: 'approve' | 'return';
  reason: string;
  evidenceIds: string[];
}

export function useDecideProfile() {
  return useRegistryCommand<ProfileDecision>((client, input, attempt) =>
    client.command('post_model_profiles_id_publish', {
      path: { id: input.profileId },
      ifMatchVersion: input.version,
      body: { decision: input.decision, reason: input.reason.trim(), evidence_ids: input.evidenceIds },
      attempt,
    }),
  );
}

export interface ModelApproval {
  modelId: string;
  version: number;
}

export function useApproveModel() {
  return useRegistryCommand<ModelApproval>((client, input, attempt) => client.command('approveAiModel', { path: { id: input.modelId }, ifMatchVersion: input.version, attempt }));
}

// ---- the records of the gateway (ST-LLM-005) -------------------------------------------------------------------------------------------------

export const REQUEST_PAGE = 50;

/** The requests a page at a time, newest first, narrowed by the filter; the first page also carries the figures of the month. */
export function useRequests(filter: RequestFilter) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useInfiniteQuery<RequestPage, Error, { pages: RequestPage[] }, readonly unknown[], string | undefined>({
    queryKey: [...llmRoot(tenant?.id), 'requests', filter, tenant?.membershipId],
    initialPageParam: undefined,
    queryFn: async ({ pageParam }) => toRequestPage(await client.read('listAiRequests', { query: { limit: REQUEST_PAGE, ...filterQuery(filter), ...(pageParam === undefined ? {} : { cursor: pageParam }) } })),
    getNextPageParam: (last) => last.next,
    // A new filter keeps the list that is on the screen until the new one is there: the fields the reader is typing in are not taken away.
    placeholderData: keepPreviousData,
    enabled: tenant !== undefined,
    retry: false,
  });
}

/** How one request was classified and routed; nothing is read until a request is chosen. */
export function useRouteDecision(requestId: string | undefined) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<RouteDecision | null>({
    queryKey: [...llmRoot(tenant?.id), 'route', requestId, tenant?.membershipId],
    queryFn: async () => toRouteDecision(await client.read('getAiRequestRoute', { path: { id: requestId as string } })) ?? null,
    enabled: tenant !== undefined && requestId !== undefined,
    retry: false,
  });
}
