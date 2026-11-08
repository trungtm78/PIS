import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../../api/ApiClientContext';
import { AttemptRegistry } from '../../../api/attempt-registry';
import { useScopeKey } from './hooks';
import { toProposals } from './rating-model';
import type { ProposalView } from './rating-model';

/** The proposals of a rating the caller reads, newest first; the proposals of one contract when it is named. */
export function useRatingProposals(contractId: string | undefined, enabled: boolean) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<ProposalView[]>({
    queryKey: [...key, 'rating-proposals', contractId ?? ''],
    queryFn: async () => {
      const items = toProposals(await client.read('listContractRatingProposals', { query: { ...(contractId === undefined ? {} : { contract_id: contractId }), limit: 100 } }));
      if (items === undefined) throw new Error('listContractRatingProposals: the answer is not what the contract says');
      return items;
    },
    enabled: enabled && key[1] !== undefined,
    retry: false,
  });
}

type Client = ReturnType<typeof useApiClient>;
type Attempt = { key: string };

/** One command of the rating: one idempotency attempt per intention, and the reads are made again after it, also after a refusal (the proposal can have been changed by someone else). */
function useRatingCommand<Input>(run: (client: Client, input: Input, attempt: Attempt) => Promise<unknown>) {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const key = useScopeKey();
  const attempts = useRef(new AttemptRegistry());
  const refresh = (): Promise<void> => queryClient.invalidateQueries({ queryKey: key });
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

export interface ProposeInput {
  contractId: string;
  body: Record<string, unknown>;
}

export interface VersionedInput {
  id: string;
  version: number;
  body: Record<string, unknown>;
}

export const usePropose = () => useRatingCommand<ProposeInput>((client, input, attempt) => client.command('proposeContractRating', { path: { id: input.contractId }, body: input.body as never, attempt }));
export const useNotify = () => useRatingCommand<VersionedInput>((client, input, attempt) => client.command('notifyContractRating', { path: { id: input.id }, body: input.body as never, ifMatchVersion: input.version, attempt }));
export const useRespond = () => useRatingCommand<VersionedInput>((client, input, attempt) => client.command('recordContractRatingResponse', { path: { id: input.id }, body: input.body as never, ifMatchVersion: input.version, attempt }));
export const useAdopt = () => useRatingCommand<VersionedInput>((client, input, attempt) => client.command('adoptContractRating', { path: { id: input.id }, body: input.body as never, ifMatchVersion: input.version, attempt }));
export const useWithdraw = () => useRatingCommand<VersionedInput>((client, input, attempt) => client.command('withdrawContractRating', { path: { id: input.id }, body: input.body as never, ifMatchVersion: input.version, attempt }));
