import { useQuery } from '@tanstack/react-query';
import { useApiClient } from '../../api/ApiClientContext';
import { useSession } from '../../session/SessionContext';
import { mneRoot } from './hooks';
import { toRevision } from './history-model';
import type { Revision } from './history-model';

const LINK_REFRESH_MS = 4 * 60_000;

/**
 * One revision of a report with the history of all of them, in the units of the caller: what is shown depends on who asks, so the cache is of the member as well as the tenant. The links of the files are good for five
 * minutes, so while there are any the revision is read again before they run out.
 */
export function useRevision(id: string | undefined) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<Revision>({
    queryKey: [...mneRoot(tenant?.id), 'revision', tenant?.membershipId, id],
    queryFn: async () => {
      const revision = toRevision(await client.read('getMneReport', { path: { id: id as string } }));
      if (revision === undefined) throw new Error('the report could not be read');
      return revision;
    },
    enabled: tenant !== undefined && id !== undefined && id !== '',
    retry: false,
    refetchInterval: (query) => (query.state.data?.report.packages.some((item) => item.downloadUrl !== null) === true ? LINK_REFRESH_MS : false),
  });
}

/** The names of the members of the tenant by id, for the approver of a revision; nothing when the caller may not list members (the screen then shows the short id). */
export function useMemberNames(enabled: boolean) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<ReadonlyMap<string, string>>({
    queryKey: [...mneRoot(tenant?.id), 'member-names', tenant?.membershipId],
    queryFn: async () =>
      new Map(
        (await client.readAll('get_resources_membership')).flatMap((raw): Array<[string, string]> => {
          const row = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
          return typeof row.id === 'string' && typeof row.display_name === 'string' ? [[row.id, row.display_name]] : [];
        }),
      ),
    enabled: enabled && tenant !== undefined,
    retry: false,
  });
}
