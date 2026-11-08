import { useQuery } from '@tanstack/react-query';
import { useApiClient } from '../../../api/ApiClientContext';
import { useScopeKey } from '../shared/vnd-hooks';

/** The suggestions of duplicates of the whole register, by the state of the suggestion (empty: all states). */
export function useDuplicateQueue(status: string) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery({
    queryKey: [...key, 'duplicate-queue', status],
    queryFn: () => client.read('listVendorDuplicates', { query: status === '' ? {} : { status } }),
    enabled: key[1] !== undefined,
    retry: false,
  });
}

/** The seven indicators of the controls of contractors (independence, risk grades, performance, bid security, subcontractor payments). */
export function useControlFigures() {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery({ queryKey: [...key, 'control-figures'], queryFn: () => client.read('getVendorControlFigures'), enabled: key[1] !== undefined, retry: false });
}
