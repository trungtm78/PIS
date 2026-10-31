import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../../api/ApiClientContext';
import { AttemptRegistry } from '../../../api/attempt-registry';
import { useSession } from '../../../session/SessionContext';
import { toFlags } from './model';
import type { FlagView } from './model';

// The flags are read for the control-plane member that is signed in: switching between two memberships keeps the query client, so the membership is part of every key.
function useScopeKey(): readonly ['sas-flags', string | undefined, string | undefined] {
  const { tenant } = useSession();
  return ['sas-flags', tenant?.id, tenant?.membershipId];
}

/** Every release flag the code declares, with its rollout. */
export function useFlags(enabled: boolean) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<FlagView[]>({
    queryKey: [...key, 'list'],
    queryFn: async () => toFlags(await client.read('listFeatureFlags')),
    enabled: enabled && key[1] !== undefined,
    retry: false,
  });
}

export interface UpdateInput {
  key: string;
  version: number;
  body: Record<string, unknown>;
}

export function useUpdateFlag() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const key = useScopeKey();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: (input: UpdateInput) => client.command('updateFeatureFlag', { path: { flagKey: input.key }, body: input.body as never, ifMatchVersion: input.version, attempt: attempts.current.forPayload(input) }),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: key });
    },
    onError: (error) => attempts.current.ended(error),
  });
}
