import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../../api/ApiClientContext';
import { AttemptRegistry } from '../../../api/attempt-registry';
import { useSession } from '../../../session/SessionContext';
import { toAvailability, toExtension } from './model';
import type { Availability, Decision, ExtensionEntry } from './model';

// What the screen shows is the capital of the tenant for the member that is signed in: switching between two memberships keeps the query client, so the membership is part of every key.
function useScopeKey(): readonly ['cap', string | undefined, string | undefined] {
  const { tenant } = useSession();
  return ['cap', tenant?.id, tenant?.membershipId];
}

/** Every request to carry capital over, the latest first (every page is followed). */
export function useExtensions(enabled = true) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<ExtensionEntry[]>({
    queryKey: [...key, 'extensions'],
    queryFn: async () => (await client.readAll('listAllocationExtensions')).flatMap((raw) => toExtension(raw) ?? []),
    enabled: enabled && key[1] !== undefined,
    retry: false,
  });
}

/** The figures of one line: allocated, committed and disbursed (`getCapitalAvailability`). */
export function useLineAvailability(lineId: string | undefined, enabled = true) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<Availability>({
    queryKey: [...key, 'availability', lineId ?? ''],
    queryFn: async () => toAvailability(await client.read('getCapitalAvailability', { query: { allocation_line_id: lineId as string } })),
    enabled: enabled && lineId !== undefined && key[1] !== undefined,
    retry: false,
  });
}

/** One mutation hook: one idempotency attempt per intention, every cached read of the capital refreshed on success (the lines and the balances moved). */
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
    onError: (error) => attempts.current.ended(error),
  });
}

export interface RequestInput {
  lineId: string;
  body: Record<string, unknown>;
}

export function useRequestExtension() {
  const client = useApiClient();
  return useCommand<RequestInput>((input, attempt) => client.command('requestAllocationExtension', { path: { id: input.lineId }, body: input.body as never, attempt }));
}

export interface DecideInput {
  id: string;
  version: number;
  decision: Decision;
  reason: string;
  documentId: string | undefined;
}

export function useDecideExtension() {
  const client = useApiClient();
  return useCommand<DecideInput>((input, attempt) =>
    client.command('decideAllocationExtension', {
      path: { id: input.id },
      body: { decision: input.decision, reason: input.reason, ...(input.documentId === undefined ? {} : { approving_document_id: input.documentId }) } as never,
      ifMatchVersion: input.version,
      attempt,
    }),
  );
}
