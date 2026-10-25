import { ApiError } from '@machvon/api-client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../../api/ApiClientContext';
import { AttemptRegistry } from '../../../api/attempt-registry';
import { useSession } from '../../../session/SessionContext';
import { toHolds } from './model';
import type { Holds, ReleaseBody } from './model';

// What the screen shows depends on what the signed-in membership may see, not only on the tenant: the membership is part of every key.
function useScopeKey(): readonly ['ctr-retention', string | undefined, string | undefined] {
  const { tenant } = useSession();
  return ['ctr-retention', tenant?.id, tenant?.membershipId];
}

/**
 * The holds of retention of a contract, the newest first; a page of the server is enough for a dossier. null when the contract is not there for the caller (another tenant, or outside the scope:
 * a 404). The contractor of a contract is refused (403) and the screen says so.
 */
export function useHolds(contractId: string | null) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<Holds | null>({
    queryKey: [...key, 'holds', contractId ?? ''],
    queryFn: async () => {
      try {
        return toHolds(await client.read('listRetentionHolds', { path: { id: contractId ?? '' }, query: { limit: 200 } })) ?? null;
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return null;
        throw error;
      }
    },
    enabled: key[1] !== undefined && contractId !== null,
    retry: false,
  });
}

export interface ReleaseInput {
  id: string;
  version: number;
  body: ReleaseBody;
}

/** One idempotency attempt per intention; the holds are read again once the release succeeded. */
export function useReleaseRetention() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: (input: ReleaseInput) => client.command('releaseRetention', { path: { id: input.id }, body: input.body, ifMatchVersion: input.version, attempt: attempts.current.forPayload(input) }),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ predicate: (query) => query.queryKey[0] === 'ctr-retention' });
    },
    onError: (error) => attempts.current.ended(error),
  });
}
