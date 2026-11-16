import { useQuery } from '@tanstack/react-query';
import { useApiClient } from '../../../api/ApiClientContext';
import { usePwfKey } from '../hooks';
import { todayInVietnam } from '../model';
import { toUnitNode, unitChoices } from './unit-tree';
import type { UnitChoice } from './unit-tree';

/** The units of the tenant the caller may read, as a tree in order, for the step where a unit the project cannot name is chosen. A list that cannot be read gives none: the step then says so, and nothing is guessed. */
export function useUnitTree(enabled: boolean) {
  const client = useApiClient();
  const key = usePwfKey();
  return useQuery<UnitChoice[]>({
    queryKey: [...key, 'unit-tree'],
    queryFn: async () => {
      const today = todayInVietnam();
      return unitChoices((await client.readAll('get_resources_organization_unit')).flatMap((row) => toUnitNode(row, today)));
    },
    enabled: enabled && key[1] !== undefined,
    retry: false,
    staleTime: 60_000,
  });
}
