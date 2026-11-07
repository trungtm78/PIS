import { ApiError } from '@machvon/api-client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../api/ApiClientContext';
import { AttemptRegistry } from '../../api/attempt-registry';
import { useSession } from '../../session/SessionContext';
import { toAdvancePolicy, toAdvancePosition, toChangeTier, toContractAvailability, toEacControl, toProjectReserve, toRecoveryTable } from './model';

// What these screens show depends on the scope of the membership that is signed in, not only on the tenant: the membership is part of every key.
export function useScopeKey(): readonly ['gov4', string | undefined, string | undefined] {
  const { tenant } = useSession();
  return ['gov4', tenant?.id, tenant?.membershipId];
}

/** A read that is null when the record is not there for the caller (another tenant, or outside the scope: a 404); any other failure is the failure of the read, never "nothing". */
function useRead<T>(name: string, id: string | undefined, operation: string, parse: (raw: unknown) => T | undefined) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<T | null>({
    queryKey: [...key, name, id ?? ''],
    queryFn: async () => {
      try {
        return parse(await client.read(operation as never, { path: { id: id ?? '' } } as never)) ?? null;
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return null;
        throw error;
      }
    },
    enabled: key[1] !== undefined && id !== undefined,
    retry: false,
  });
}

export const useContractAvailability = (id: string | undefined) => useRead('availability', id, 'getContractAvailability', toContractAvailability);
export const useProjectEac = (id: string | undefined) => useRead('eac', id, 'getProjectEacControl', toEacControl);
export const useProjectReserve = (id: string | undefined) => useRead('reserve', id, 'getProjectReserve', toProjectReserve);
export const useChangeTier = (id: string | undefined) => useRead('tier', id, 'getChangeTier', toChangeTier);
export const useAdvanceRecoveryTable = (id: string | undefined) => useRead('recovery-table', id, 'getAdvanceRecoveryTable', toRecoveryTable);
export const useContractAdvancePosition = (id: string | undefined) => useRead('advance-position', id, 'getContractAdvancePosition', toAdvancePosition);

/** The policy of the cap of the advance as data with the days it is in force. */
export function useAdvancePolicy() {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery({
    queryKey: [...key, 'advance-policy'],
    queryFn: async () => toAdvancePolicy(await client.read('listAdvancePolicy' as never, {} as never)),
    enabled: key[1] !== undefined,
    retry: false,
  });
}

/** One mutation hook: one idempotency attempt per intention, the cached reads refreshed on success. */
function useCommand<Input>(send: (input: Input, attempt: ReturnType<AttemptRegistry['forPayload']>) => Promise<unknown>) {
  const queryClient = useQueryClient();
  const key = useScopeKey();
  const attempts = useRef(new AttemptRegistry());
  return useMutation<unknown, Error, Input>({
    mutationFn: (input) => send(input, attempts.current.forPayload(input)),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: key });
    },
    onError: (error) => attempts.current.ended(error),
  });
}

export interface FundInput {
  projectId: string;
  body: { kind: string; amount_vnd: string; authority_document_version_id: string; reason: string };
}

export function useFundReserve() {
  const client = useApiClient();
  return useCommand<FundInput>((input, attempt) => client.command('fundProjectReserve' as never, { path: { id: input.projectId }, body: input.body, attempt } as never));
}

export interface DrawdownInput {
  projectId: string;
  body: { kind: string; amount_vnd: string; risk_id?: string; change_request_id?: string; reason: string };
}

export function useRequestDrawdown() {
  const client = useApiClient();
  return useCommand<DrawdownInput>((input, attempt) => client.command('requestReserveDrawdown' as never, { path: { id: input.projectId }, body: input.body, attempt } as never));
}

export interface DecisionInput {
  id: string;
  version: number;
  body: { decision: 'approve' | 'reject'; reason: string };
}

export function useDecideDrawdown() {
  const client = useApiClient();
  return useCommand<DecisionInput>((input, attempt) => client.command('decideReserveDrawdown' as never, { path: { id: input.id }, body: input.body, ifMatchVersion: input.version, attempt } as never));
}

export interface ExposureInput {
  riskId: string;
  body: { probability_pct: string; cost_impact_vnd: string };
}

export function useSetExposure() {
  const client = useApiClient();
  return useCommand<ExposureInput>((input, attempt) => client.command('setRiskExposure' as never, { path: { id: input.riskId }, body: input.body, attempt } as never));
}

export interface ClearInput {
  changeId: string;
  version: number;
  body: { basis: string; decision_document_version_id: string };
}

export function useClearAdjustment() {
  const client = useApiClient();
  return useCommand<ClearInput>((input, attempt) => client.command('clearChangeAdjustmentCheck' as never, { path: { id: input.changeId }, body: input.body, ifMatchVersion: input.version, attempt } as never));
}
