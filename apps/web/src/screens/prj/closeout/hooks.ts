import { useQuery } from '@tanstack/react-query';
import { useApiClient } from '../../../api/ApiClientContext';
import { toHandover } from '../../ast/handover/model';
import type { HandoverLine } from '../../ast/handover/model';
import { toSettlement } from '../../pay/settlement/model';
import type { Settlement } from '../../pay/settlement/model';
import { useScopeKey } from '../hooks';
import { handoversOf, settlementsOf } from './model';

const PAGE = 200;

/** The handovers in the scope of the caller that belong to a project, the newest first; the read of AST knows the contract and the state, not the project, so the project is chosen here. */
export function useProjectHandovers(projectId: string | undefined, enabled: boolean) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<HandoverLine[]>({
    queryKey: [...key, 'closeout', 'handovers', projectId ?? ''],
    queryFn: async () =>
      handoversOf(
        projectId ?? '',
        (await client.readAll('get_resources_handover', { query: { limit: PAGE } })).flatMap((raw) => toHandover(raw) ?? []),
      ),
    enabled: enabled && key[1] !== undefined && projectId !== undefined,
    retry: false,
  });
}

/** The settlements of a project the caller may read, the newest first. */
export function useProjectSettlements(projectId: string | undefined, enabled: boolean) {
  const client = useApiClient();
  const key = useScopeKey();
  // The read takes the project as a filter, which openapi.json does not list yet: the query is built as text, as the settlement workspace of PAY does for its state filter.
  const query: Record<string, string> = { project_id: projectId ?? '', limit: String(PAGE) };
  return useQuery<Settlement[]>({
    queryKey: [...key, 'closeout', 'settlements', projectId ?? ''],
    queryFn: async () =>
      settlementsOf(
        projectId ?? '',
        (await client.readAll('get_resources_settlement_revision', { query })).flatMap((raw) => toSettlement(raw) ?? []),
      ),
    enabled: enabled && key[1] !== undefined && projectId !== undefined,
    retry: false,
  });
}
