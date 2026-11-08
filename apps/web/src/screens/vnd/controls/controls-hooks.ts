import { useQuery } from '@tanstack/react-query';
import { useApiClient } from '../../../api/ApiClientContext';
import { useScopeKey } from '../shared/vnd-hooks';

/** The tenant is known: the reads of this part of the module wait for it, as the reads of the rest of the module do. */
const ready = (key: readonly [string, string | undefined, string | undefined]): boolean => key[1] !== undefined;

export function useIndependence(packageId: string | undefined) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery({ queryKey: [...key, 'independence', packageId], queryFn: () => client.read('getVendorIndependence', { path: { id: packageId ?? '' } }), enabled: ready(key) && packageId !== undefined, retry: false });
}

export function usePackageControls(packageId: string | undefined) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery({ queryKey: [...key, 'package-controls', packageId], queryFn: () => client.read('getVendorPackageControls', { path: { id: packageId ?? '' } }), enabled: ready(key) && packageId !== undefined, retry: false });
}

export function useInterests(enabled: boolean) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery({ queryKey: [...key, 'interests'], queryFn: () => client.read('listVendorPersonInterests', { query: { active_only: true } }), enabled: ready(key) && enabled, retry: false });
}

export function useFinance(contractorId: string | undefined, packageId: string | undefined) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery({
    queryKey: [...key, 'finance', contractorId, packageId],
    queryFn: () => client.read('getVendorFinance', { path: { id: contractorId ?? '' }, ...(packageId === undefined ? {} : { query: { package_id: packageId } }) }),
    enabled: ready(key) && contractorId !== undefined,
    retry: false,
  });
}

export function useCapacity(contractorId: string | undefined) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery({ queryKey: [...key, 'capacity', contractorId], queryFn: () => client.read('getVendorCapacity', { path: { id: contractorId ?? '' } }), enabled: ready(key) && contractorId !== undefined, retry: false });
}
