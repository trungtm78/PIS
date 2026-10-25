import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../../api/ApiClientContext';
import { AttemptRegistry } from '../../../api/attempt-registry';
import { useSession } from '../../../session/SessionContext';
import { toYear } from './model';
import type { CloseTarget, YearRow } from './model';

// What the screen shows is the capital of the tenant for the member that is signed in: switching between two memberships keeps the query client, so the membership is part of every key.
function useScopeKey(): readonly ['cap', string | undefined, string | undefined] {
  const { tenant } = useSession();
  return ['cap', tenant?.id, tenant?.membershipId];
}

/** The years the control knows, the latest first (`listFiscalYears`); a year it does not list is open. */
export function useYears(enabled = true) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<YearRow[]>({
    queryKey: [...key, 'fiscal-years'],
    queryFn: async () => {
      const body = (await client.read('listFiscalYears')) as { items?: unknown[] };
      return (body.items ?? []).flatMap((raw) => toYear(raw) ?? []);
    },
    enabled: enabled && key[1] !== undefined,
    retry: false,
  });
}

/** One mutation hook: one idempotency attempt per intention, every cached read of the capital refreshed on success (a lock lapses capital and refuses plan commands). */
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

export interface CloseInput {
  year: number;
  version: number;
  target: CloseTarget;
  reason: string;
}

export function useCloseYear() {
  const client = useApiClient();
  return useCommand<CloseInput>((input, attempt) =>
    client.command('closeFiscalYear', { path: { year: input.year }, body: { target_status: input.target, reason: input.reason } as never, ifMatchVersion: input.version, attempt }),
  );
}

export interface ReopenInput {
  year: number;
  version: number;
  reason: string;
  hours: number;
}

export function useReopenYear() {
  const client = useApiClient();
  return useCommand<ReopenInput>((input, attempt) =>
    client.command('reopenFiscalYear', { path: { year: input.year }, body: { reason: input.reason, window_hours: input.hours } as never, ifMatchVersion: input.version, attempt }),
  );
}
