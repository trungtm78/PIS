import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../api/ApiClientContext';
import { AttemptRegistry } from '../../api/attempt-registry';
import { useSession } from '../../session/SessionContext';

/** What the screens of the project workflow show depends on the places the signed-in membership reaches, not only on the tenant: the membership is part of every key. */
export function usePwfKey(): readonly ['pwf', string | undefined, string | undefined] {
  const { tenant } = useSession();
  return ['pwf', tenant?.id, tenant?.membershipId];
}

/** The calendar of the day and the rules a screen reads change when a command succeeds, so every cached read of the module is read again then. */
export function usePwfCommand<Input>(send: (input: Input, attempt: ReturnType<AttemptRegistry['forPayload']>) => Promise<unknown>) {
  const queryClient = useQueryClient();
  const key = usePwfKey();
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

const text = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() !== '' ? value : undefined);

/**
 * The names of the kinds of project of the shared catalogue (`PROJECT_TYPE`), by the code a template and a mapping rule carry (the `business_key` of the entry). A template names its kind of project by that code; a
 * person reads the name the catalogue gives it. A catalogue that cannot be read gives no names: the screen then falls back to what it knows, and nothing fails.
 */
export function useProjectTypeNames(enabled = true): ReadonlyMap<string, string> {
  const client = useApiClient();
  const key = usePwfKey();
  const found = useQuery<ReadonlyMap<string, string>>({
    queryKey: [...key, 'project-type-names'],
    queryFn: async () => {
      const rows: unknown = await client.readAll('searchMasterRecords', { query: { master_type: 'PROJECT_TYPE' } });
      const names = new Map<string, string>();
      for (const raw of Array.isArray(rows) ? rows : []) {
        const row = raw as Record<string, unknown> | null;
        const code = text(row?.business_key);
        const label = text(row?.label);
        if (code !== undefined && label !== undefined && row?.status === 'EFFECTIVE') names.set(code, label);
      }
      return names;
    },
    enabled: enabled && key[1] !== undefined,
    retry: false,
    staleTime: 5 * 60_000,
  });
  return found.data ?? EMPTY_NAMES;
}

const EMPTY_NAMES: ReadonlyMap<string, string> = new Map();

/** Reads the module again (after a refusal that says somebody changed it first). */
export function useReloadPwf(): () => Promise<void> {
  const queryClient = useQueryClient();
  const key = usePwfKey();
  return () => queryClient.invalidateQueries({ queryKey: key });
}

/** A command that carries the version the person saw (the `If-Match` of the call). */
export interface VersionedInput<Body = undefined> {
  id: string;
  version: number;
  body: Body;
}
