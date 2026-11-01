import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../../api/ApiClientContext';
import { AttemptRegistry } from '../../../api/attempt-registry';
import { useSession } from '../../../session/SessionContext';
import { issRoot } from '../hooks';
import { toSiteChecks } from './model';
import type { RaiseBody, SiteCheck } from './model';

/**
 * The inspections in the scope of the caller, the latest request first, with the project of each. The key is the one of the quality inspections, so that recording a result on QMS-04 refreshes this list too; nothing is
 * read unless the caller holds the permission to read inspections.
 */
export function useSiteChecks(enabled: boolean) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<SiteCheck[]>({
    queryKey: ['qms-inspections', tenant?.id, tenant?.membershipId, 'site-checks'],
    queryFn: async () => toSiteChecks(await client.read('listInspections', { query: {} })),
    enabled: enabled && tenant !== undefined,
    retry: false,
  });
}

/** Opens one issue for a failed item (createIssue). The operation id inside the body is what makes a send repeated after a lost answer the same issue; the attempt is the idempotency key of the intention. */
export function useRaiseIssue() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const { tenant } = useSession();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: (body: RaiseBody) => client.command('createIssue', { body, attempt: attempts.current.forPayload(body) }),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: issRoot(tenant?.id) });
    },
    onError: (error) => attempts.current.ended(error),
  });
}
