import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../../api/ApiClientContext';
import { AttemptRegistry } from '../../../api/attempt-registry';
import { useSession } from '../../../session/SessionContext';
import { toDossier, toRule } from './types';
import type { Dossier, RetentionRule } from './types';

export const dossiersKey = (tenantId: string | undefined) => ['doc', 'dossiers', tenantId] as const;
export const rulesKey = (tenantId: string | undefined) => ['doc', 'retention-rules', tenantId] as const;

/** Every dossier in the reach of the caller, the latest first: the pages of the list are followed to the end. */
export function useDossiers(enabled: boolean) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<Dossier[]>({
    queryKey: dossiersKey(tenant?.id),
    queryFn: async () => (await client.readAll('listDossiers')).map(toDossier),
    enabled: enabled && tenant !== undefined,
    retry: false,
  });
}

/** Every retention rule of the tenant, by category. */
export function useRetentionRules(enabled: boolean) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<RetentionRule[]>({
    queryKey: rulesKey(tenant?.id),
    queryFn: async () => (await client.readAll('listDocumentRetentionRules')).map(toRule),
    enabled: enabled && tenant !== undefined,
    retry: false,
  });
}

function useCommand<Input>(key: (tenantId: string | undefined) => readonly unknown[], send: (input: Input, attempt: ReturnType<AttemptRegistry['forPayload']>) => Promise<unknown>) {
  const queryClient = useQueryClient();
  const { tenant } = useSession();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: (input: Input) => send(input, attempts.current.forPayload(input)),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: key(tenant?.id) });
    },
    onError: async (error) => {
      attempts.current.ended(error);
      // A refusal can follow a step taken by somebody else: the list is read again.
      await queryClient.invalidateQueries({ queryKey: key(tenant?.id) });
    },
  });
}

export interface VersionedInput<Body> {
  id: string;
  version: number;
  body: Body;
}

export function useHandover() {
  const client = useApiClient();
  return useCommand(dossiersKey, (input: VersionedInput<Record<string, unknown>>, attempt) => client.command('handoverDossierToArchive', { path: { id: input.id }, body: input.body as never, ifMatchVersion: input.version, attempt }));
}

export function usePropose() {
  const client = useApiClient();
  return useCommand(dossiersKey, (input: VersionedInput<Record<string, unknown>>, attempt) => client.command('proposeDossierDisposal', { path: { id: input.id }, body: input.body as never, ifMatchVersion: input.version, attempt }));
}

export function useDecide() {
  const client = useApiClient();
  return useCommand(dossiersKey, (input: VersionedInput<Record<string, unknown>>, attempt) => client.command('decideDossierDisposal', { path: { id: input.id }, body: input.body as never, ifMatchVersion: input.version, attempt }));
}

export function useCreateRule() {
  const client = useApiClient();
  return useCommand(rulesKey, (body: Record<string, unknown>, attempt) => client.command('createDocumentRetentionRule', { body: body as never, attempt }));
}

export function usePublishRule() {
  const client = useApiClient();
  return useCommand(rulesKey, (input: { id: string; version: number }, attempt) => client.command('publishDocumentRetentionRule', { path: { id: input.id }, body: {} as never, ifMatchVersion: input.version, attempt }));
}

export function useConfirmRule() {
  const client = useApiClient();
  return useCommand(rulesKey, (input: VersionedInput<Record<string, unknown>>, attempt) => client.command('confirmDocumentRetentionRuleLegalBasis', { path: { id: input.id }, body: input.body as never, ifMatchVersion: input.version, attempt }));
}
