import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../../api/ApiClientContext';
import { AttemptRegistry } from '../../../api/attempt-registry';
import { useSession } from '../../../session/SessionContext';
import { PAGE_SIZE, toAuditPage, toExportDone } from './model';
import type { AuditPage, ExportBody, ExportDone } from './model';

// What the trail shows depends on the scope of the membership that is signed in, not only on the tenant.
const auditKey = (tenantId: string | undefined, membershipId: string | undefined) => ['adm', 'audit', tenantId, membershipId] as const;

/** The audit trail, newest first, page by page, narrowed by the applied filter (a query the server validates). */
export function useAuditEvents(filter: Record<string, string>, enabled: boolean) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useInfiniteQuery<AuditPage, Error, { pages: AuditPage[] }, readonly unknown[], string | undefined>({
    queryKey: [...auditKey(tenant?.id, tenant?.membershipId), filter],
    initialPageParam: undefined,
    queryFn: async ({ pageParam }) => {
      // The filters are parameters of the read that the contract does not list yet; the server validates each of them.
      const query = { limit: PAGE_SIZE, ...filter, ...(pageParam === undefined ? {} : { cursor: pageParam }) };
      return toAuditPage(await client.read('get_resources_audit_event', { query }));
    },
    getNextPageParam: (last) => last.nextCursor,
    enabled: enabled && tenant !== undefined,
    retry: false,
  });
}

/** Asks for a sealed export; one idempotency attempt per intention, so a retry never writes a second file. */
export function useExportAudit() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const { tenant } = useSession();
  const attempts = useRef(new AttemptRegistry());
  return useMutation<ExportDone | undefined, Error, ExportBody>({
    mutationFn: async (body) => toExportDone(await client.command('exportAuditLog', { body, attempt: attempts.current.forPayload(body) })),
    onSuccess: async () => {
      attempts.current.done();
      // The export is itself an audited act: the trail shows it.
      await queryClient.invalidateQueries({ queryKey: auditKey(tenant?.id, tenant?.membershipId) });
    },
    onError: (error) => attempts.current.ended(error),
  });
}
