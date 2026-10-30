import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../../api/ApiClientContext';
import { AttemptRegistry } from '../../../api/attempt-registry';
import { useSession } from '../../../session/SessionContext';
import { toOverview } from './model';
import type { Overview } from './model';

export const overviewKey = (tenantId: string | undefined) => ['not', 'delivery-overview', tenantId] as const;

/** The overview of the delivery for a period (`getDeliveryOverview`), read again every minute: the figures of the day move. */
export function useOverview(range: { from: string; to: string }, enabled: boolean) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<Overview>({
    queryKey: [...overviewKey(tenant?.id), range.from, range.to],
    queryFn: async () => toOverview(await client.read('getDeliveryOverview', { query: { from: range.from, to: range.to } })),
    enabled: enabled && tenant !== undefined,
    refetchInterval: 60_000,
    retry: false,
  });
}

export interface SetLimitsInput {
  accountId: string;
  version: number;
  body: Record<string, unknown>;
  reason: string;
}

export function useSetLimits() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const { tenant } = useSession();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: (input: SetLimitsInput) =>
      client.command('setChannelLimits', { path: { channelAccountId: input.accountId }, body: { ...input.body, reason: input.reason } as never, ifMatchVersion: input.version, attempt: attempts.current.forPayload(input) }),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: overviewKey(tenant?.id) });
    },
    onError: (error) => attempts.current.ended(error),
  });
}
