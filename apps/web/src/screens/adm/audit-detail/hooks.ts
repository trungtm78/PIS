import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../../api/ApiClientContext';
import { AttemptRegistry } from '../../../api/attempt-registry';
import { useSession } from '../../../session/SessionContext';
import { toDetail, toPolicies } from './model';
import type { DetailView, PolicyView, SaveBody } from './model';

/** The queries of the screen begin with this key: the save refreshes all of them. */
export const auditDetailKey = (tenantId: string | undefined) => ['adm', 'audit-detail', tenantId] as const;

/** The opt-ins of the tenant, one per class of business object. */
export function useAuditDetailPolicies(enabled = true) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<PolicyView[]>({
    queryKey: [...auditDetailKey(tenant?.id), 'policies'],
    queryFn: async () => toPolicies(await client.read('listAuditDetailPolicies')),
    enabled: enabled && tenant !== undefined,
    retry: false,
  });
}

/** Saves the opt-in of one class (versioned by the body: a stale version is a 409); one idempotency attempt per intention. */
export function useSaveAuditDetailPolicy() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const { tenant } = useSession();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: (body: SaveBody) => client.command('saveAuditDetailPolicy', { body, attempt: attempts.current.forPayload(body) }),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: auditDetailKey(tenant?.id) });
    },
    onError: (error) => attempts.current.ended(error),
  });
}

/** The full before and after of one audit row, read when a person asks for it (an event id is typed or picked). */
export function useAuditEventDetail(auditEventId: string | undefined) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<DetailView | undefined>({
    queryKey: [...auditDetailKey(tenant?.id), 'event', auditEventId ?? ''],
    queryFn: async () => toDetail(await client.read('getAuditEventDetail', { path: { id: auditEventId as string } })),
    enabled: tenant !== undefined && auditEventId !== undefined,
    retry: false,
  });
}
