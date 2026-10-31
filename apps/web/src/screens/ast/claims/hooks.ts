import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../../api/ApiClientContext';
import { AttemptRegistry } from '../../../api/attempt-registry';
import { useSession } from '../../../session/SessionContext';
import { toClaim, toObligationOption } from './model';
import type { ClaimLine, ObligationOption } from './model';

// What the screen shows depends on what the signed-in membership may see, not only on the tenant: the membership is part of every key.
function useScopeKey(): readonly ['ast-claims', string | undefined, string | undefined] {
  const { tenant } = useSession();
  return ['ast-claims', tenant?.id, tenant?.membershipId];
}

/** The claims in the scope of the caller, the newest first; those of one obligation when it is named. Every page is read. */
export function useClaims(obligationId: string) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<ClaimLine[]>({
    queryKey: [...key, 'list', obligationId],
    queryFn: async () => (await client.readAll('listWarrantyClaims', { query: obligationId === '' ? {} : { obligation_id: obligationId } })).flatMap((raw) => toClaim(raw) ?? []),
    enabled: key[1] !== undefined,
    retry: false,
  });
}

/** The obligations still running, with the contractor a claim is addressed to: what the form offers. Read only for someone who may file. */
export function useObligations(enabled: boolean) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<ObligationOption[]>({
    queryKey: [...key, 'obligations'],
    queryFn: async () => (await client.readAll('listWarrantyObligations')).flatMap(toObligationOption),
    enabled: enabled && key[1] !== undefined,
    retry: false,
  });
}

/** One mutation hook: one idempotency attempt per intention, the claims read again after the command, also after a refusal (it can follow an answer given by somebody else). */
function useCommand<Input>(send: (input: Input, attempt: ReturnType<AttemptRegistry['forPayload']>) => Promise<unknown>) {
  const queryClient = useQueryClient();
  const key = useScopeKey();
  const attempts = useRef(new AttemptRegistry());
  const refresh = (): Promise<void> => queryClient.invalidateQueries({ queryKey: key });
  return useMutation({
    mutationFn: (input: Input) => send(input, attempts.current.forPayload(input)),
    onSuccess: async () => {
      attempts.current.done();
      await refresh();
    },
    onError: async (error) => {
      attempts.current.ended(error);
      await refresh();
    },
  });
}

export interface FileInput {
  obligationId: string;
  body: Record<string, unknown>;
}

export function useFileClaim() {
  const client = useApiClient();
  return useCommand<FileInput>((input, attempt) => client.command('fileWarrantyClaim', { path: { id: input.obligationId }, body: input.body as never, attempt }));
}

export interface VersionedInput {
  id: string;
  version: number;
  body: Record<string, unknown>;
}

export function useAcknowledgeClaim() {
  const client = useApiClient();
  return useCommand<VersionedInput>((input, attempt) => client.command('acknowledgeWarrantyClaim', { path: { id: input.id }, body: input.body as never, ifMatchVersion: input.version, attempt }));
}

export function useRecordFix() {
  const client = useApiClient();
  return useCommand<VersionedInput>((input, attempt) => client.command('recordWarrantyFix', { path: { id: input.id }, body: input.body as never, ifMatchVersion: input.version, attempt }));
}

export function useVerifyClaim() {
  const client = useApiClient();
  return useCommand<VersionedInput>((input, attempt) => client.command('verifyWarrantyClaim', { path: { id: input.id }, body: input.body as never, ifMatchVersion: input.version, attempt }));
}
