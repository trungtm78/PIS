import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../../api/ApiClientContext';
import { AttemptRegistry } from '../../../api/attempt-registry';
import { useSession } from '../../../session/SessionContext';
import { toConnection } from './connection-model';
import type { Connection } from './connection-model';

// What the screen shows depends on the places the signed-in membership reaches, not only on the tenant: the membership is part of every key.
// The key starts like the other EGP screens', so an import that is applied on BID-24 refreshes this one too.
function useScopeKey(): readonly ['bid-egp', string | undefined, string | undefined] {
  const { tenant } = useSession();
  return ['bid-egp', tenant?.id, tenant?.membershipId];
}

/** The connection of the tenant: the status, the freshness by the rule, the positions, the runs and what the caller may do. */
export function useEgpConnection() {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<Connection>({
    queryKey: [...key, 'connection'],
    queryFn: async () => toConnection(await client.read('getEgpConnection')),
    enabled: key[1] !== undefined,
    retry: false,
  });
}

export interface SwitchInput {
  enabled: boolean;
  reason: string;
  /** The version of the connection the caller saw: the server refuses the change when it moved (409 VERSION_CONFLICT). */
  version: number;
}

/** Switches the connection on or off under the version the caller saw: one idempotency attempt per intention, the read refreshed on success. */
export function useSetEgpConnectionState() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const key = useScopeKey();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: (input: SwitchInput) =>
      client.command('setEgpConnectionState', { body: { enabled: input.enabled, reason: input.reason }, ifMatchVersion: input.version, attempt: attempts.current.forPayload(input) }),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: key });
    },
    onError: (error) => attempts.current.ended(error),
  });
}
