import { useQuery } from '@tanstack/react-query';
import { useApiClient } from '../../../api/ApiClientContext';
import { useScopeKey } from '../shared/vnd-hooks';

export { useVendorCommand as usePortalCommand } from '../shared/vnd-hooks';

const ready = (key: readonly [string, string | undefined, string | undefined]): boolean => key[1] !== undefined;

// ---- the contractor side: every read answers the contractor of the caller, never one named by the screen -------------------------------------------------------------------------

export function usePortalHome() {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery({ queryKey: [...key, 'portal', 'home'], queryFn: () => client.read('getPortalHome'), enabled: ready(key), retry: false });
}

export function usePortalRequests(status: string) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery({
    queryKey: [...key, 'portal', 'requests', status],
    queryFn: () => client.read('listPortalRequests', { query: status === '' ? {} : { status } }),
    enabled: ready(key),
    retry: false,
    placeholderData: (previous) => previous,
  });
}

export function usePortalQualifications() {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery({ queryKey: [...key, 'portal', 'qualifications'], queryFn: () => client.read('listPortalQualifications'), enabled: ready(key), retry: false });
}

export function usePortalEvaluations() {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery({ queryKey: [...key, 'portal', 'evaluations'], queryFn: () => client.read('listPortalEvaluations'), enabled: ready(key), retry: false });
}

export function usePortalPlans() {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery({ queryKey: [...key, 'portal', 'plans'], queryFn: () => client.read('listPortalRemediationPlans'), enabled: ready(key), retry: false });
}

// ---- the staff side --------------------------------------------------------------------------------------------------------------------------------------------------------------------

export interface StaffRequestFilters {
  status: string;
  kind: string;
  contractor: string;
}

export function useStaffRequests(filters: StaffRequestFilters) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery({
    queryKey: [...key, 'portal-manage', 'requests', filters],
    queryFn: () =>
      client.read('listVendorPortalRequests', {
        query: { ...(filters.status === '' ? {} : { status: filters.status }), ...(filters.kind === '' ? {} : { kind: filters.kind }), ...(filters.contractor === '' ? {} : { contractor_id: filters.contractor }) },
      }),
    enabled: ready(key),
    retry: false,
    placeholderData: (previous) => previous,
  });
}

export function useReconfirmations(state: string) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery({
    queryKey: [...key, 'portal-manage', 'reconfirmations', state],
    queryFn: () => client.read('listVendorReconfirmations', { query: state === '' ? {} : { state } }),
    enabled: ready(key),
    retry: false,
    placeholderData: (previous) => previous,
  });
}

/** The contractors a request or a plan can be addressed to: the register, the first page, narrowed by what the person types. */
export function useContractorChoices(q: string, enabled: boolean) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery({
    queryKey: [...key, 'portal-manage', 'choices', q],
    queryFn: () => client.read('listVendorRegister', { query: { ...(q.trim() === '' ? {} : { q: q.trim() }), verification: 'VERIFIED', limit: 20 } }),
    enabled: ready(key) && enabled,
    retry: false,
  });
}

export function usePlans(filters: { status: string; contractor: string }) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery({
    queryKey: [...key, 'remediation', 'plans', filters],
    queryFn: () => client.read('listVendorRemediationPlans', { query: { ...(filters.status === '' ? {} : { status: filters.status }), ...(filters.contractor === '' ? {} : { contractor_id: filters.contractor }) } }),
    enabled: ready(key),
    retry: false,
    placeholderData: (previous) => previous,
  });
}

export function usePlan(id: string | undefined) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery({ queryKey: [...key, 'remediation', 'plan', id], queryFn: () => client.read('getVendorRemediationPlan', { path: { id: id ?? '' } }), enabled: ready(key) && id !== undefined, retry: false });
}
