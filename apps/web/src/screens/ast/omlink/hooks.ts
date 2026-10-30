import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../../api/ApiClientContext';
import { AttemptRegistry } from '../../../api/attempt-registry';
import { useSession } from '../../../session/SessionContext';
import { toOmAsset } from './model';
import type { LinkBody, OmAsset } from './model';

// What the screen shows depends on what the signed-in membership may see, not only on the tenant: the membership is part of every key.
function useScopeKey(): readonly ['ast-omlink', string | undefined, string | undefined] {
  const { tenant } = useSession();
  return ['ast-omlink', tenant?.id, tenant?.membershipId];
}

/** One asset with its link (`get_resources_asset_record_id`). */
export function useOmAsset(assetId: string | undefined, enabled: boolean) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<OmAsset | null>({
    queryKey: [...key, assetId ?? ''],
    queryFn: async () => toOmAsset(await client.read('get_resources_asset_record_id', { path: { id: assetId as string } })) ?? null,
    enabled: enabled && key[1] !== undefined && assetId !== undefined,
    retry: false,
  });
}

export interface LinkInput {
  assetId: string;
  body: LinkBody;
}

/** One idempotency attempt per intention; the asset is read again after the command, also after a refusal (it can follow a link made by someone else). */
export function useLinkOm() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const attempts = useRef(new AttemptRegistry());
  const refresh = (): Promise<void> => queryClient.invalidateQueries({ predicate: (query) => query.queryKey[0] === 'ast-omlink' || query.queryKey[0] === 'ast-assets' });
  return useMutation({
    mutationFn: (input: LinkInput) => client.command('linkOmPlan', { path: { id: input.assetId }, body: input.body as never, attempt: attempts.current.forPayload(input) }),
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
