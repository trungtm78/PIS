import { useMutation, useQuery } from '@tanstack/react-query';
import { useApiClient } from '../../../api/ApiClientContext';
import { useVendorCommand, useScopeKey } from '../shared/vnd-hooks';

export { useVendorCommand };

const ready = (key: readonly [string, string | undefined, string | undefined]): boolean => key[1] !== undefined;

export interface LeadFilters {
  status: string;
  kind: string;
  contractor: string;
  cursor: string | undefined;
  limit: number;
}

/** The leads for the auditors, one page at a time by the cursor the server gave. The tenant and the membership are part of every key (the shared scope key), so a command of the module refreshes the family. */
export function useLeads(filters: LeadFilters) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery({
    queryKey: [...key, 'leads', filters],
    queryFn: () =>
      client.read('listVendorLeads', {
        query: {
          ...(filters.status === '' ? {} : { status: filters.status }),
          ...(filters.kind === '' ? {} : { kind: filters.kind }),
          ...(filters.contractor === '' ? {} : { contractor_id: filters.contractor }),
          ...(filters.cursor === undefined ? {} : { cursor: filters.cursor }),
          limit: filters.limit,
        },
      }),
    enabled: ready(key),
    retry: false,
    placeholderData: (previous) => previous,
  });
}

/** The figures of the investigation: a failure of this read does not hide the list. */
export function useInvestigationFigures() {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery({ queryKey: [...key, 'investigation-figures'], queryFn: () => client.read('getVendorInvestigationFigures'), enabled: ready(key), retry: false });
}

export function useLead(id: string | undefined) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery({ queryKey: [...key, 'lead', id], queryFn: () => client.read('getVendorLead', { path: { id: id ?? '' } }), enabled: ready(key) && id !== undefined, retry: false });
}

export function useContractorLinks(contractorId: string | undefined) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery({
    queryKey: [...key, 'links', contractorId],
    queryFn: () => client.read('getVendorContractorLinks', { path: { id: contractorId ?? '' } }),
    enabled: ready(key) && contractorId !== undefined,
    retry: false,
  });
}

export interface HitFilters {
  status: string;
  source: string;
  contractor: string;
}

export function useScreening(filters: HitFilters) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery({
    queryKey: [...key, 'screening', filters],
    queryFn: () =>
      client.read('getVendorScreening', {
        query: { ...(filters.status === '' ? {} : { status: filters.status }), ...(filters.source === '' ? {} : { source: filters.source }), ...(filters.contractor === '' ? {} : { contractor_id: filters.contractor }) },
      }),
    enabled: ready(key),
    retry: false,
    placeholderData: (previous) => previous,
  });
}

export function useScreeningHit(id: string | undefined) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery({ queryKey: [...key, 'screening-hit', id], queryFn: () => client.read('getVendorScreeningHit', { path: { id: id ?? '' } }), enabled: ready(key) && id !== undefined, retry: false });
}

export function useDisputes(contractor: string | undefined) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery({
    queryKey: [...key, 'disputes', contractor],
    queryFn: () => client.read('getVendorDisputes', { query: contractor === undefined ? {} : { contractor_id: contractor } }),
    enabled: ready(key),
    retry: false,
  });
}

/** The export of parties is read when the person asks for the file, never on its own: a mutation that reads (so that a press is one read and its answer is kept for the receipt). */
export function useOcdsExport() {
  const client = useApiClient();
  return useMutation({
    mutationFn: (request: { contractor: string | undefined; packageId: string | undefined }) =>
      client.read('exportVendorOcdsParties', { query: { ...(request.contractor === undefined ? {} : { contractor_id: request.contractor }), ...(request.packageId === undefined ? {} : { package_id: request.packageId }) } }),
  });
}
