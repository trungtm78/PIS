import { useQuery } from '@tanstack/react-query';
import { useApiClient } from '../../../api/ApiClientContext';
import { useSession } from '../../../session/SessionContext';
import { toWarningPage } from '../../home/warning-model';
import type { WarningItem } from '../../home/warning-model';
import { useScopeKey } from '../hooks';

export { useDirectiveList } from '../../dir/hooks';
export { useIssues } from '../../iss/hooks';
export { useRisks } from '../risk/hooks';

/** The most pages of the warning list the tab walks to find the warnings of one project. */
const MAX_WARNING_PAGES = 8;
const WARNING_PAGE_SIZE = 50;

/**
 * The open early warnings of one project. The warning list (HOME-03) is read in the scope of the caller and has no project narrowing,
 * so its pages are walked (a bounded number) and the ones that name this project are kept.
 */
export function useProjectWarnings(projectId: string) {
  const client = useApiClient();
  const { tenant } = useSession();
  const scope = useScopeKey();
  return useQuery<WarningItem[]>({
    queryKey: [...scope, 'wsTab', 'warnings', projectId],
    queryFn: async () => {
      const found: WarningItem[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < MAX_WARNING_PAGES; page += 1) {
        const read = toWarningPage(await client.read('getHomeWarnings', { query: { limit: WARNING_PAGE_SIZE, ...(cursor === undefined ? {} : { cursor }) } }));
        found.push(...read.items.filter((item) => item.project?.id === projectId));
        cursor = read.nextCursor;
        if (cursor === undefined) break;
      }
      return found;
    },
    enabled: tenant !== undefined && projectId !== '',
    retry: false,
  });
}
