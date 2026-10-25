import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../../api/ApiClientContext';
import { AttemptRegistry } from '../../../api/attempt-registry';
import { useSession } from '../../../session/SessionContext';
import { toWarrantyList } from './model';
import type { CloseBody, CreateBody, WarrantyLine } from './model';

// What the screen shows depends on what the signed-in membership may see, not only on the tenant: the membership is part of every key.
function useScopeKey(): readonly ['ast-warranty', string | undefined, string | undefined] {
  const { tenant } = useSession();
  return ['ast-warranty', tenant?.id, tenant?.membershipId];
}

/** The obligations in the scope of the caller, the newest first; a page of the server is enough for a dossier. Those of one handover when it is named. */
export function useWarranties(handoverId: string) {
  const client = useApiClient();
  const key = useScopeKey();
  const query: Record<string, string> = { limit: '200' };
  if (handoverId !== '') query.handover_id = handoverId;
  return useQuery<WarrantyLine[]>({
    queryKey: [...key, 'list', handoverId],
    queryFn: async () => toWarrantyList(await client.read('listWarrantyObligations', { query })),
    enabled: key[1] !== undefined,
    retry: false,
  });
}

/** One mutation hook: one idempotency attempt per intention, the reads of the obligations refreshed once it succeeds. */
function useCommand<Input>(send: (input: Input, attempt: ReturnType<AttemptRegistry['forPayload']>) => Promise<unknown>) {
  const queryClient = useQueryClient();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: (input: Input) => send(input, attempts.current.forPayload(input)),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ predicate: (query) => query.queryKey[0] === 'ast-warranty' });
    },
    onError: (error) => attempts.current.ended(error),
  });
}

export function useCreateWarranty() {
  const client = useApiClient();
  return useCommand<CreateBody>((body, attempt) => client.command('createWarrantyObligation', { body, attempt }));
}

export interface CloseInput {
  id: string;
  body: CloseBody;
}

export function useCloseWarranty() {
  const client = useApiClient();
  return useCommand<CloseInput>((input, attempt) => client.command('closeWarrantyObligation', { path: { id: input.id }, body: input.body, attempt }));
}
