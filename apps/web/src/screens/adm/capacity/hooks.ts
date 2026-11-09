import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../../api/ApiClientContext';
import { AttemptRegistry } from '../../../api/attempt-registry';
import { useSession } from '../../../session/SessionContext';
import { toOverview } from './model';
import type { Overview, SaveBody } from './model';

export const capacityKey = (tenantId: string | undefined) => ['adm', 'log-capacity', tenantId] as const;

/** The caps, the last measure of each log class and the archive batches. */
export function useLogCapacity(enabled = true) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<Overview>({
    queryKey: [...capacityKey(tenant?.id), 'overview'],
    queryFn: async () => toOverview(await client.read('getLogCapacity')),
    enabled: enabled && tenant !== undefined,
    retry: false,
  });
}

/** Sets, changes or lifts the cap of one class (the body carries the version the person saw: a stale one is a 409). */
export function useSaveLogCapacity() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const { tenant } = useSession();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: (body: SaveBody) => client.command('saveLogCapacityPolicy', { body, attempt: attempts.current.forPayload(body) }),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: capacityKey(tenant?.id) });
    },
    onError: (error) => attempts.current.ended(error),
  });
}
