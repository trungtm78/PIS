import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../api/ApiClientContext';
import { AttemptRegistry } from '../../api/attempt-registry';
import { useSession } from '../../session/SessionContext';
import { keyBody, modelBody, policyBody, providerBody, toKey, toModel, toPolicyBook, toProvider } from './llm-model';
import type { KeyEntry, KeyValues, ModelEntry, ModelValues, PolicyBook, PolicyValues, Provider, ProviderValues } from './llm-model';

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
  return useRegistryCommand<ActivationInput>((client, input, attempt) =>
    client.command('activateAiProvider', { path: { id: input.providerId }, ifMatchVersion: input.version, body: input.d07Ref.trim() === '' ? {} : { d07_approval_ref: input.d07Ref.trim() }, attempt }),
  );
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
  return useRegistryCommand<RevokeInput>((client, input, attempt) =>
    client.command('revokeAiVirtualKey', { path: { id: input.keyId }, ifMatchVersion: input.version, body: { reason: input.reason.trim() }, attempt }),
  );
}
