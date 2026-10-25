import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../../api/ApiClientContext';
import { AttemptRegistry } from '../../../api/attempt-registry';
import { useSession } from '../../../session/SessionContext';
import { toAssetList } from './model';
import type { AssetLine, RegisterBody, TransferBody } from './model';

// What the screen shows depends on what the signed-in membership may see, not only on the tenant: the membership is part of every key.
function useScopeKey(): readonly ['ast-assets', string | undefined, string | undefined] {
  const { tenant } = useSession();
  return ['ast-assets', tenant?.id, tenant?.membershipId];
}

/** The assets in the scope of the caller, the newest first; a page of the server is enough for a dossier. Those of one handover when it is named. */
export function useAssets(handoverId: string) {
  const client = useApiClient();
  const key = useScopeKey();
  const query: Record<string, string> = { limit: '200' };
  if (handoverId !== '') query.handover_id = handoverId;
  return useQuery<AssetLine[]>({
    queryKey: [...key, 'list', handoverId],
    queryFn: async () => toAssetList(await client.read('get_resources_asset_record', { query })),
    enabled: key[1] !== undefined,
    retry: false,
  });
}

/** One mutation hook: one idempotency attempt per intention, the reads of the assets refreshed once it succeeds. */
function useCommand<Input>(send: (input: Input, attempt: ReturnType<AttemptRegistry['forPayload']>) => Promise<unknown>) {
  const queryClient = useQueryClient();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: (input: Input) => send(input, attempts.current.forPayload(input)),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ predicate: (query) => query.queryKey[0] === 'ast-assets' });
    },
    onError: (error) => attempts.current.ended(error),
  });
}

export function useRegisterAsset() {
  const client = useApiClient();
  return useCommand<RegisterBody>((body, attempt) => client.command('registerAsset', { body, attempt }));
}

export interface TransferInput {
  id: string;
  version: number;
  body: TransferBody;
}

export function useTransferAsset() {
  const client = useApiClient();
  return useCommand<TransferInput>((input, attempt) => client.command('transferAsset', { path: { id: input.id }, body: input.body, ifMatchVersion: input.version, attempt }));
}
