import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../../api/ApiClientContext';
import { AttemptRegistry } from '../../../api/attempt-registry';
import { useSession } from '../../../session/SessionContext';
import { toConnector } from './model';
import type { ConnectorBody, ConnectorStatus, ConnectorView } from './model';

/** The queries of the connector screens begin with this key: a command refreshes all of them. */
export const connectorsKey = (tenantId: string | undefined) => ['adm', 'connectors', tenantId] as const;

/** Declares a connector; one idempotency attempt per intention. */
export function useCreateConnector() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const { tenant } = useSession();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: (body: ConnectorBody) => client.command('createIntegrationConnector', { body, attempt: attempts.current.forPayload(body) }),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: connectorsKey(tenant?.id) });
    },
    onError: (error) => attempts.current.ended(error),
  });
}

export interface ConnectorMoveInput {
  id: string;
  version: number;
  status: ConnectorStatus;
  reason: string;
}

/** Moves a connector to Active or Disabled (versioned: a stale version is a 409). */
export function useMoveConnector() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const { tenant } = useSession();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: (input: ConnectorMoveInput) =>
      client.command('updateIntegrationConnector', {
        path: { connectorId: input.id },
        body: { status: input.status, reason: input.reason },
        ifMatchVersion: input.version,
        attempt: attempts.current.forPayload(input),
      }),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: connectorsKey(tenant?.id) });
    },
    onError: (error) => attempts.current.ended(error),
  });
}

/** Every connector of the tenant, by code. */
export function useConnectors(enabled = true) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<ConnectorView[]>({
    queryKey: [...connectorsKey(tenant?.id), 'list'],
    queryFn: async () => (await client.readAll('get_resources_integration_connector')).flatMap((raw) => toConnector(raw) ?? []),
    enabled: enabled && tenant !== undefined,
    retry: false,
  });
}
