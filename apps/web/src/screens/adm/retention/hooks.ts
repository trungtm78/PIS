import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../../api/ApiClientContext';
import { AttemptRegistry } from '../../../api/attempt-registry';
import { useSession } from '../../../session/SessionContext';
import { toHold, toPolicy, toReviewItem } from './model';
import type { DraftBody, HoldView, PolicyView, ReviewItemView } from './model';

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

/** Every version of every record class, the newest revision of a class first (the register read pages through all of them). */
export function useRetentionPolicies(enabled = true) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<PolicyView[]>({
    queryKey: [...retentionKey(tenant?.id), 'policies'],
    queryFn: async () => (await client.readAll('get_resources_data_retention_policy')).flatMap((raw) => toPolicy(raw) ?? []),
    enabled: enabled && tenant !== undefined,
    retry: false,
  });
}

/** The records whose period has run out and that wait for a decision, the oldest first. */
export function useRetentionReview(enabled = true) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<ReviewItemView[]>({
    queryKey: [...retentionKey(tenant?.id), 'review'],
    queryFn: async () => (await client.readAll('get_resources_retention_review_item')).flatMap((raw) => toReviewItem(raw) ?? []),
    enabled: enabled && tenant !== undefined,
    retry: false,
  });
}

/** The legal holds of the tenant; the screen only needs them to say what overrides the rules, so they are read apart from the rules. */
export function useRetentionHolds(enabled = true) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<HoldView[]>({
    queryKey: [...retentionKey(tenant?.id), 'holds'],
    queryFn: async () => (await client.readAll('get_resources_legal_hold')).flatMap((raw) => toHold(raw) ?? []),
    enabled: enabled && tenant !== undefined,
    retry: false,
  });
}
