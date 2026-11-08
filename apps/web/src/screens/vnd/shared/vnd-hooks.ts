import type { CommandInput, CommandOperation, SuccessBody } from '@machvon/api-client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../../api/ApiClientContext';
import { AttemptRegistry } from '../../../api/attempt-registry';
import { useSession } from '../../../session/SessionContext';
import type { GateAction } from './vnd-model';

/** Everything the module reads depends on the places the signed-in membership reaches: the tenant and the membership are part of every key, and a command refreshes the whole family. */
export function useScopeKey(): readonly ['vnd', string | undefined, string | undefined] {
  const { tenant } = useSession();
  return ['vnd', tenant?.id, tenant?.membershipId];
}

/** The screen reads and the commands may be used once the tenant is known. */
const ready = (key: readonly [string, string | undefined, string | undefined]): boolean => key[1] !== undefined;

export interface RegisterFilters {
  q: string;
  verification: string;
  coverage: string;
  restricted: boolean;
  hasOpenCase: boolean;
  cursor: string | undefined;
  limit: number;
}

/** The register of contractors, one page at a time by the cursor the server gave. */
export function useRegister(filters: RegisterFilters) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery({
    queryKey: [...key, 'register', filters],
    queryFn: () =>
      client.read('listVendorRegister', {
        query: {
          ...(filters.q.trim() === '' ? {} : { q: filters.q.trim() }),
          ...(filters.verification === '' ? {} : { verification: filters.verification }),
          ...(filters.coverage === '' ? {} : { coverage: filters.coverage }),
          ...(filters.restricted ? { restricted: true } : {}),
          ...(filters.hasOpenCase ? { has_open_case: true } : {}),
          ...(filters.cursor === undefined ? {} : { cursor: filters.cursor }),
          limit: filters.limit,
        },
      }),
    enabled: ready(key),
    retry: false,
    placeholderData: (previous) => previous,
  });
}

/** The indicators of the register: a failure of this read does not hide the list. */
export function useFigures() {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery({ queryKey: [...key, 'figures'], queryFn: () => client.read('getVendorFigures'), enabled: ready(key), retry: false });
}

export function useProfile(id: string | undefined) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery({ queryKey: [...key, 'profile', id], queryFn: () => client.read('getVendorContractor', { path: { id: id ?? '' } }), enabled: ready(key) && id !== undefined, retry: false });
}

export interface CaseFilters {
  status: string;
  open: boolean;
  contractor: string;
}

export function useCases(filters: CaseFilters) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery({
    queryKey: [...key, 'cases', filters],
    queryFn: () =>
      client.read('listVendorRestrictionCases', {
        query: { ...(filters.status === '' ? {} : { status: filters.status }), ...(filters.open ? { open: true } : {}), ...(filters.contractor === '' ? {} : { contractor_id: filters.contractor }) },
      }),
    enabled: ready(key),
    retry: false,
  });
}

export function useCase(id: string | undefined) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery({ queryKey: [...key, 'case', id], queryFn: () => client.read('getVendorRestrictionCase', { path: { id: id ?? '' } }), enabled: ready(key) && id !== undefined, retry: false });
}

export function usePayeeChanges(status: string, contractor: string | undefined) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery({
    queryKey: [...key, 'payee-changes', status, contractor],
    queryFn: () => client.read('listVendorPayeeChanges', { query: { ...(status === '' ? {} : { status }), ...(contractor === undefined ? {} : { contractor_id: contractor }) } }),
    enabled: ready(key),
    retry: false,
  });
}

export function useExpiries() {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery({ queryKey: [...key, 'expiries'], queryFn: () => client.read('listVendorExpiries'), enabled: ready(key), retry: false });
}

export function useReputation(status: string) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery({
    queryKey: [...key, 'reputation', status],
    queryFn: () => client.read('listVendorReputationEvents', { query: status === '' ? {} : { status } }),
    enabled: ready(key),
    retry: false,
    placeholderData: (previous) => previous,
  });
}

export function useVentures(status: string) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery({
    queryKey: [...key, 'ventures', status],
    queryFn: () => client.read('listVendorJointVentures', { query: status === '' ? {} : { status } }),
    enabled: ready(key),
    retry: false,
    placeholderData: (previous) => previous,
  });
}

export function usePackageRequirements(packageId: string | undefined) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery({
    queryKey: [...key, 'requirements', packageId],
    queryFn: () => client.read('getVendorPackageRequirements', { path: { id: packageId ?? '' } }),
    enabled: ready(key) && packageId !== undefined,
    retry: false,
  });
}

/** The preview of a gate for one contractor and one step; it reads only when the person asks. */
export function useGateCheck(request: { contractor: string; action: GateAction } | undefined) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery({
    queryKey: [...key, 'gate', request?.contractor, request?.action],
    queryFn: () => client.read('checkVendorGate', { query: { contractor_id: request?.contractor ?? '', action: request?.action ?? 'BID_SUBMISSION' } }),
    enabled: ready(key) && request !== undefined,
    retry: false,
    staleTime: 0,
    gcTime: 0,
  });
}

/**
 * One command of the module under the idempotency protocol: the same intention (a retry after a failure, a second press) reuses its key, a different one is new, a success ends the intention and refreshes every read of the module.
 * The caller types the input by the contract: path, body and the version it saw (the If-Match of an operation that has one).
 */
export function useVendorCommand<K extends CommandOperation>(operation: K) {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const key = useScopeKey();
  const attempts = useRef(new AttemptRegistry());
  return useMutation<SuccessBody<K>, unknown, Omit<CommandInput<K>, 'attempt'>>({
    mutationFn: (input) => client.command(operation, { ...input, attempt: attempts.current.forPayload({ operation, input }) } as CommandInput<K>),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: key });
    },
    onError: (error) => attempts.current.ended(error),
  });
}
