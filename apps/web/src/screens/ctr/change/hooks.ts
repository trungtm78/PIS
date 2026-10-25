import { useQuery } from '@tanstack/react-query';
import { useApiClient } from '../../../api/ApiClientContext';
import { useCommand, useScopeKey } from '../hooks';
import { toChain } from './model';
import type { Chain, EvaluateBody, OpenBody } from './model';

/** The chain of a project, or of one contract of it: the tiers, the requests in the scope of the caller and what the caller may do with each; null when no project is named. */
export function useChain(projectId: string | null | undefined, contractId?: string | null) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<Chain | null>({
    queryKey: [...key, 'change-chain', projectId ?? '', contractId ?? ''],
    queryFn: async () => {
      const answer = await client.read('getChangeChain', { path: { id: projectId ?? '' }, ...(typeof contractId === 'string' ? { query: { contract_id: contractId } } : {}) });
      return toChain(answer) ?? null;
    },
    enabled: key[1] !== undefined && typeof projectId === 'string',
    retry: false,
  });
}

export interface TiersInput {
  projectId: string;
  tierCount: 1 | 2 | 3;
}

/** Sets the number of tiers of a project; the server refuses once the first request has been raised. */
export function useSetTiers() {
  const client = useApiClient();
  return useCommand<TiersInput>((input, attempt) => client.command('setChangeChainTiers', { path: { id: input.projectId }, body: { tier_count: input.tierCount }, attempt }));
}

export interface OpenInput {
  contractId: string;
  body: OpenBody;
}

/** Raises a request at the first tier of the chain of the project of a contract. */
export function useOpenChange() {
  const client = useApiClient();
  return useCommand<OpenInput>((input, attempt) => client.command('createChangeRequest', { path: { id: input.contractId }, body: input.body, attempt }));
}

export interface ReasonInput {
  id: string;
  version: number;
  reason: string;
}

export function usePromoteChange() {
  const client = useApiClient();
  return useCommand<ReasonInput>((input, attempt) => client.command('promoteChangeRequest', { path: { id: input.id }, body: { reason: input.reason }, ifMatchVersion: input.version, attempt }));
}

export function useWithdrawChange() {
  const client = useApiClient();
  return useCommand<ReasonInput>((input, attempt) => client.command('withdrawChangeRequest', { path: { id: input.id }, body: { reason: input.reason }, ifMatchVersion: input.version, attempt }));
}

export interface EvaluateInput {
  id: string;
  version: number;
  body: EvaluateBody;
}

export function useEvaluateChange() {
  const client = useApiClient();
  return useCommand<EvaluateInput>((input, attempt) => client.command('evaluateChangeRequest', { path: { id: input.id }, body: input.body, ifMatchVersion: input.version, attempt }));
}
