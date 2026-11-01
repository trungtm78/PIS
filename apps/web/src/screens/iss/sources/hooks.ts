import { useQuery } from '@tanstack/react-query';
import { useApiClient } from '../../../api/ApiClientContext';
import { useSession } from '../../../session/SessionContext';
import { toSourceIssue } from './model';
import type { SourceIssue } from './model';

/**
 * The issues in the scope of the caller that came from another module, newest first. What the issues show depends on the membership that is signed in, not only on the tenant, so the membership is part of the
 * key; nothing is read unless the caller holds the permission to read issues.
 */
export function useSourceIssues(enabled: boolean) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<SourceIssue[]>({
    queryKey: ['iss', tenant?.id, tenant?.membershipId, 'sources'],
    queryFn: async () => (await client.readAll('get_resources_issue')).flatMap((raw) => toSourceIssue(raw) ?? []),
    enabled: enabled && tenant !== undefined,
    retry: false,
  });
}
