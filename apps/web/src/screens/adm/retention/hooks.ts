import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../../api/ApiClientContext';
import { AttemptRegistry } from '../../../api/attempt-registry';
import { useSession } from '../../../session/SessionContext';
import type { DraftBody } from './model';

/** The queries of the retention screen begin with this key: a command refreshes all of them. */
export const retentionKey = (tenantId: string | undefined) => ['adm', 'retention', tenantId] as const;

/** Writes the next draft of a record class; one idempotency attempt per intention. */
export function useCreateRetentionDraft() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const { tenant } = useSession();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: (body: DraftBody) => client.command('createRetentionPolicyVersion', { body, attempt: attempts.current.forPayload(body) }),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: retentionKey(tenant?.id) });
    },
    onError: (error) => attempts.current.ended(error),
  });
}

export interface PublishInput {
  id: string;
  version: number;
  reason: string;
}

/** Publishes a draft (versioned: a stale version is a 409). */
export function usePublishRetention() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const { tenant } = useSession();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: (input: PublishInput) =>
      client.command('publishRetentionPolicy', {
        path: { policyId: input.id },
        body: { reason: input.reason },
        ifMatchVersion: input.version,
        attempt: attempts.current.forPayload(input),
      }),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: retentionKey(tenant?.id) });
    },
    onError: (error) => attempts.current.ended(error),
  });
}
