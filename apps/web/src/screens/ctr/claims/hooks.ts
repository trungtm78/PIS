import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../../api/ApiClientContext';
import { AttemptRegistry } from '../../../api/attempt-registry';
import { useSession } from '../../../session/SessionContext';
import { useContracts } from '../hooks';
import { queryOf } from './model';
import type { Claim, ClaimFilter, ClaimPage, ClaimTermList } from './model';
import type { components } from '@machvon/contracts';

type Schemas = components['schemas'];

/** The registers shown depend on the places the signed-in membership reaches, not only on the tenant: the membership is part of every key. The key is shared with the early-warning register, so a claim registered refreshes both. */
export function useRegisterKey(): readonly ['ctr-register', string | undefined, string | undefined] {
  const { tenant } = useSession();
  return ['ctr-register', tenant?.id, tenant?.membershipId];
}

/** The contracts a person can pick for a filter or a form: the register of the contracts in scope. */
export function useContractChoices(enabled = true) {
  return useContracts(enabled);
}

/** The register of claims, a page after another: the totals are those of the whole filter, whatever page was read. */
export function useClaims(filter: ClaimFilter) {
  const client = useApiClient();
  const key = useRegisterKey();
  return useInfiniteQuery<ClaimPage, Error, { pages: ClaimPage[] }, readonly unknown[], string | undefined>({
    queryKey: [...key, 'claims', filter],
    initialPageParam: undefined,
    queryFn: ({ pageParam }) => client.read('listClaims', { query: queryOf(filter, pageParam) }),
    getNextPageParam: (page) => page.next_cursor ?? undefined,
    enabled: key[1] !== undefined,
    retry: false,
  });
}

/** One claim with its term, its four clocks, its timeline and what may be done next. */
export function useClaim(id: string | null) {
  const client = useApiClient();
  const key = useRegisterKey();
  return useQuery<Claim>({
    queryKey: [...key, 'claim', id ?? ''],
    queryFn: () => client.read('getClaim', { path: { id: id ?? '' } }),
    enabled: key[1] !== undefined && id !== null,
    retry: false,
  });
}

/** The terms of a contract and the templates a person may copy from. */
export function useClaimTerms(contractId: string | null) {
  const client = useApiClient();
  const key = useRegisterKey();
  return useQuery<ClaimTermList>({
    queryKey: [...key, 'terms', contractId ?? ''],
    queryFn: () => client.read('listClaimTerms', { path: { id: contractId ?? '' } }),
    enabled: key[1] !== undefined && contractId !== null,
    retry: false,
  });
}

/** One mutation: one idempotency attempt per intention, every cached read of the registers refreshed on success. */
export function useRegisterCommand<Input>(send: (input: Input, attempt: ReturnType<AttemptRegistry['forPayload']>) => Promise<unknown>) {
  const queryClient = useQueryClient();
  const key = useRegisterKey();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: (input: Input) => send(input, attempts.current.forPayload(input)),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: key });
    },
    onError: (error) => attempts.current.ended(error),
  });
}

/** Refreshes what the registers read (after a conflict, the screen reads again). */
export function useReloadRegisters() {
  const queryClient = useQueryClient();
  const key = useRegisterKey();
  return () => queryClient.invalidateQueries({ queryKey: key });
}

export interface RegisterClaimInput {
  contractId: string;
  body: Schemas['CtrClaimRegister'];
}
export function useRegisterClaim() {
  const client = useApiClient();
  return useRegisterCommand<RegisterClaimInput>((input, attempt) => client.command('registerClaim', { path: { id: input.contractId }, body: input.body, attempt }));
}

export interface VersionedInput<Body> {
  id: string;
  version: number;
  body: Body;
}
export function useRecordStep() {
  const client = useApiClient();
  return useRegisterCommand<VersionedInput<Schemas['CtrClaimStepRecord']>>((input, attempt) => client.command('recordClaimStep', { path: { id: input.id }, body: input.body, ifMatchVersion: input.version, attempt }));
}
export function useDecideSettlement() {
  const client = useApiClient();
  return useRegisterCommand<VersionedInput<Schemas['CtrClaimSettlementDecision']>>((input, attempt) => client.command('decideClaimSettlement', { path: { id: input.id }, body: input.body, ifMatchVersion: input.version, attempt }));
}
export function useDeclareBar() {
  const client = useApiClient();
  return useRegisterCommand<VersionedInput<Schemas['CtrClaimBarDeclare']>>((input, attempt) => client.command('declareClaimBar', { path: { id: input.id }, body: input.body, ifMatchVersion: input.version, attempt }));
}
export function useLinkClaim() {
  const client = useApiClient();
  return useRegisterCommand<VersionedInput<Schemas['CtrClaimLinks']>>((input, attempt) => client.command('linkClaim', { path: { id: input.id }, body: input.body, ifMatchVersion: input.version, attempt }));
}
export function useProposeTerm() {
  const client = useApiClient();
  return useRegisterCommand<{ contractId: string; body: Schemas['CtrClaimTermPropose'] }>((input, attempt) => client.command('proposeClaimTerm', { path: { id: input.contractId }, body: input.body, attempt }));
}
export function useDecideTerm() {
  const client = useApiClient();
  return useRegisterCommand<VersionedInput<Schemas['CtrClaimTermDecision']>>((input, attempt) => client.command('decideClaimTerm', { path: { id: input.id }, body: input.body, ifMatchVersion: input.version, attempt }));
}
