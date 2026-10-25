import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../../api/ApiClientContext';
import { AttemptRegistry } from '../../../api/attempt-registry';
import { useSession } from '../../../session/SessionContext';
import { toPetitionList } from './model';
import type { PetitionLine, ReceiveBody, ResolveBody } from './model';

// What the screen shows depends on what the signed-in membership may see, not only on the tenant: the membership is part of every key.
function useScopeKey(): readonly ['bid-petitions', string | undefined, string | undefined] {
  const { tenant } = useSession();
  return ['bid-petitions', tenant?.id, tenant?.membershipId];
}

/** The petitions of one package, the ones that wait first; none is asked for until a package is chosen. */
export function usePetitions(packageId: string, overdueOnly: boolean) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<PetitionLine[]>({
    queryKey: [...key, 'petitions', packageId, overdueOnly],
    queryFn: async () => toPetitionList(await client.read('listProcurementPetitions', { query: { package_id: packageId, ...(overdueOnly ? { overdue: true } : {}) } })),
    enabled: key[1] !== undefined && packageId !== '',
    retry: false,
  });
}

/** Every read of the bidding screens is refreshed when a petition moves. */
function useRefresh(): () => Promise<void> {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ predicate: (query) => typeof query.queryKey[0] === 'string' && query.queryKey[0].startsWith('bid-') });
}

/** Logging a petition: one idempotency attempt per intention. */
export function useReceivePetition() {
  const client = useApiClient();
  const refresh = useRefresh();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: (body: ReceiveBody) => client.command('receiveProcurementPetition', { body, attempt: attempts.current.forPayload(body) }),
    onSuccess: async () => {
      attempts.current.done();
      await refresh();
    },
    onError: (error) => attempts.current.ended(error),
  });
}

export interface ResolveInput {
  id: string;
  version: number;
  body: ResolveBody;
}

/** The answer to a petition, under the version of the petition the screen showed. */
export function useResolvePetition() {
  const client = useApiClient();
  const refresh = useRefresh();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: (input: ResolveInput) => client.command('resolveProcurementPetition', { path: { id: input.id }, body: input.body, ifMatchVersion: input.version, attempt: attempts.current.forPayload(input) }),
    onSuccess: async () => {
      attempts.current.done();
      await refresh();
    },
    onError: (error) => attempts.current.ended(error),
  });
}
