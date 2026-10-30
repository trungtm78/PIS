import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../../api/ApiClientContext';
import { AttemptRegistry } from '../../../api/attempt-registry';
import { useSession } from '../../../session/SessionContext';
import { toContractorChoices, toScorecard } from './model';
import type { ContractorChoice, Scorecard } from './model';

// What the screen shows depends on the scope of the signed-in membership, not only on the tenant: the membership is part of every key.
function useScopeKey(): readonly ['ctr-scorecard', string | undefined, string | undefined] {
  const { tenant } = useSession();
  return ['ctr-scorecard', tenant?.id, tenant?.membershipId];
}

export interface Range {
  from: string;
  to: string;
}

/** The scorecard of a contractor over the contracts the caller reads (`getContractorScorecard`), limited to a range of days when one is given. */
export function useScorecard(contractorId: string | undefined, range: Range, enabled: boolean) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<Scorecard | null>({
    queryKey: [...key, contractorId ?? '', range.from, range.to],
    queryFn: async () => toScorecard(await client.read('getContractorScorecard', { path: { id: contractorId as string }, query: { ...(range.from === '' ? {} : { from: range.from }), ...(range.to === '' ? {} : { to: range.to }) } })) ?? null,
    enabled: enabled && key[1] !== undefined && contractorId !== undefined,
    retry: false,
  });
}

/** The contractors that hold a contract the caller reads (`listScorecardContractors`): authorized by the permission of the scorecard, not by the one of the registry of contractors. */
export function useScorecardContractors(enabled: boolean) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<ContractorChoice[]>({
    queryKey: [...key, 'contractors'],
    queryFn: async () => toContractorChoices(await client.read('listScorecardContractors', {})),
    enabled: enabled && key[1] !== undefined,
    retry: false,
  });
}

/** One command of the scorecard: one idempotency attempt per intention, and the scorecard is read again after it, also after a refusal (it can follow a change made by someone else). */
function useScorecardCommand<Input>(run: (client: ReturnType<typeof useApiClient>, input: Input, attempt: { key: string }) => Promise<unknown>) {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const attempts = useRef(new AttemptRegistry());
  const refresh = (): Promise<void> => queryClient.invalidateQueries({ predicate: (query) => query.queryKey[0] === 'ctr-scorecard' });
  return useMutation({
    mutationFn: (input: Input) => run(client, input, attempts.current.forPayload(input)),
    onSuccess: async () => {
      attempts.current.done();
      await refresh();
    },
    onError: async (error) => {
      attempts.current.ended(error);
      await refresh();
    },
  });
}

export interface EvaluateInput {
  contractId: string;
  body: Record<string, unknown>;
}

export const useEvaluate = () => useScorecardCommand<EvaluateInput>((client, input, attempt) => client.command('evaluateContractor', { path: { id: input.contractId }, body: input.body as never, attempt }));

export interface VersionedInput {
  id: string;
  version: number;
  body: Record<string, unknown>;
}

export const useApprove = () => useScorecardCommand<VersionedInput>((client, input, attempt) => client.command('approveContractorEvaluation', { path: { id: input.id }, body: input.body as never, ifMatchVersion: input.version, attempt }));

export const useRecord = () => useScorecardCommand<EvaluateInput>((client, input, attempt) => client.command('recordContractorViolation', { path: { id: input.contractId }, body: input.body as never, attempt }));

export const useConfirm = () => useScorecardCommand<VersionedInput>((client, input, attempt) => client.command('confirmContractorViolation', { path: { id: input.id }, body: input.body as never, ifMatchVersion: input.version, attempt }));
