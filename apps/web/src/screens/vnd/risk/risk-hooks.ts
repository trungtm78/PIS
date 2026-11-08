import { useQuery } from '@tanstack/react-query';
import { useApiClient } from '../../../api/ApiClientContext';
import { useScopeKey } from '../shared/vnd-hooks';
import type { PublicationState, RiskTier } from './risk-model';

export interface RiskFilters {
  q: string;
  tier: RiskTier | '';
  reviewDue: boolean;
  pending: boolean;
  cursor: string | undefined;
  limit: number;
}

const ready = (key: readonly [string, string | undefined, string | undefined]): boolean => key[1] !== undefined;

/** The register of risk grades, one page at a time by the cursor the server gave. */
export function useRiskRegister(filters: RiskFilters) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery({
    queryKey: [...key, 'risk-register', filters],
    queryFn: () =>
      client.read('listVendorRiskGrades', {
        query: {
          ...(filters.q.trim() === '' ? {} : { q: filters.q.trim() }),
          ...(filters.tier === '' ? {} : { tier: filters.tier }),
          ...(filters.reviewDue ? { review_due: true } : {}),
          ...(filters.pending ? { pending: true } : {}),
          ...(filters.cursor === undefined ? {} : { cursor: filters.cursor }),
          limit: filters.limit,
        },
      }),
    enabled: ready(key),
    retry: false,
    placeholderData: (previous) => previous,
  });
}

/** The grade of one contractor with its live explanation; it reads only when a contractor is chosen. */
export function useRiskGrade(contractorId: string | undefined) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery({ queryKey: [...key, 'risk-grade', contractorId], queryFn: () => client.read('getVendorRiskGrade', { path: { id: contractorId ?? '' } }), enabled: ready(key) && contractorId !== undefined, retry: false });
}

export function usePerformance(contractorId: string | undefined) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery({ queryKey: [...key, 'performance', contractorId], queryFn: () => client.read('getVendorPerformance', { path: { id: contractorId ?? '' } }), enabled: ready(key) && contractorId !== undefined, retry: false });
}

/** The publications to look after, by state. */
export function usePublications(state: PublicationState) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery({
    queryKey: [...key, 'publications', state],
    queryFn: () => client.read('listVendorPerformancePublications', { query: state === 'ALL' ? {} : { state } }),
    enabled: ready(key),
    retry: false,
    placeholderData: (previous) => previous,
  });
}
