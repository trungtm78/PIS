import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../../../api/ApiClientContext';
import { AttemptRegistry } from '../../../../api/attempt-registry';
import { useSession } from '../../../../session/SessionContext';
import { toMaterialisation, toPack } from './model';
import type { Materialisation, OrgPack } from './model';

function useScopeKey(): readonly ['org', string | undefined, string | undefined] {
  const { tenant } = useSession();
  return ['org', tenant?.id, tenant?.membershipId];
}

/** The template pack, or the pack of an applied batch, with the plan against the tenant and the seats against their holders. */
export function useOrgPack(batchId: string | undefined) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<OrgPack>({
    queryKey: [...key, 'pack', batchId ?? 'template'],
    queryFn: async () => toPack(await client.read('getEnterpriseOrgPack', batchId === undefined ? {} : { query: { batch_id: batchId } as never })),
    enabled: key[1] !== undefined,
    retry: false,
  });
}

/** Turns an applied batch into units, roles and proposals; a success refreshes the pack and its verification. */
export function useMaterialisePack() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const attempts = useRef(new AttemptRegistry());
  return useMutation<Materialisation, unknown, string>({
    mutationFn: async (batchId) => toMaterialisation(await client.command('materialiseEnterpriseOrgPack', { body: { batch_id: batchId }, attempt: attempts.current.forPayload({ batchId }) })),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ predicate: (query) => query.queryKey[0] === 'org' });
    },
    onError: (error) => attempts.current.ended(error),
  });
}
