import { useQuery } from '@tanstack/react-query';
import { useApiClient } from '../../../api/ApiClientContext';
import { useScopeKey } from '../shared/vnd-hooks';

export interface SecurityFilters {
  packageId: string;
  contractorId: string;
  state: string;
}

/** The bid security register, with the amount a package asks of one bidder when both are given. */
export function useSecurities(filters: SecurityFilters) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery({
    queryKey: [...key, 'securities', filters],
    queryFn: () =>
      client.read('listVendorBidSecurities', {
        query: {
          ...(filters.packageId === '' ? {} : { package_id: filters.packageId }),
          ...(filters.contractorId === '' ? {} : { contractor_id: filters.contractorId }),
          ...(filters.state === '' ? {} : { state: filters.state }),
        },
      }),
    enabled: key[1] !== undefined,
    retry: false,
    placeholderData: (previous) => previous,
  });
}

/** One security with its ledger; it reads only when the person opens the ledger. */
export function useSecurityDetail(id: string | undefined) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery({ queryKey: [...key, 'security', id], queryFn: () => client.read('getVendorBidSecurity', { path: { id: id ?? '' } }), enabled: key[1] !== undefined && id !== undefined, retry: false });
}

/** The subcontracts of a contract; it reads only when a contract is named. */
export function useSubcontracts(contractId: string | undefined) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery({
    queryKey: [...key, 'subcontracts', contractId],
    queryFn: () => client.read('listVendorSubcontracts', { query: { contract_id: contractId ?? '' } }),
    enabled: key[1] !== undefined && contractId !== undefined,
    retry: false,
  });
}
