import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../../api/ApiClientContext';
import { AttemptRegistry } from '../../../api/attempt-registry';
import { useSession } from '../../../session/SessionContext';
import { toResultList } from './model';
import type { DecideBody, ResultLine, SubmitBody } from './model';

// What the screen shows depends on what the signed-in membership may see, not only on the tenant: the membership is part of every key.
function useScopeKey(): readonly ['bid-results', string | undefined, string | undefined] {
  const { tenant } = useSession();
  return ['bid-results', tenant?.id, tenant?.membershipId];
}

/** The results of one package, the newest first; none is asked for until a package is chosen. */
export function useResults(packageId: string) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<ResultLine[]>({
    queryKey: [...key, 'results', packageId],
    queryFn: async () => toResultList(await client.read('listProcurementResults', { query: { package_id: packageId } })),
    enabled: key[1] !== undefined && packageId !== '',
    retry: false,
  });
}

/** Every read of the bidding screens is refreshed when a result moves: the status of the package moves with an approval. */
function useRefresh(): () => Promise<void> {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ predicate: (query) => typeof query.queryKey[0] === 'string' && query.queryKey[0].startsWith('bid-') });
}

/** The submission of a result: one idempotency attempt per intention. */
export function useSubmitResult() {
  const client = useApiClient();
  const refresh = useRefresh();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: (body: SubmitBody) => client.command('submitProcurementResult', { body, attempt: attempts.current.forPayload(body) }),
    onSuccess: async () => {
      attempts.current.done();
      await refresh();
    },
    onError: (error) => attempts.current.ended(error),
  });
}

export interface DecideInput {
  id: string;
  version: number;
  body: DecideBody;
}

/** The decision of a result, under the version of the result the screen showed. */
export function useDecideResult() {
  const client = useApiClient();
  const refresh = useRefresh();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: (input: DecideInput) => client.command('decideProcurementResult', { path: { id: input.id }, body: input.body, ifMatchVersion: input.version, attempt: attempts.current.forPayload(input) }),
    onSuccess: async () => {
      attempts.current.done();
      await refresh();
    },
    onError: (error) => attempts.current.ended(error),
  });
}
