import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../api/ApiClientContext';
import { AttemptRegistry } from '../../api/attempt-registry';
import { toAppraisalView } from './appraisal-model';
import type { AppraisalView, DecisionBody, ProposalBody, ScoreBody } from './appraisal-model';
import { useScopeKey } from './hooks';

/** The project with the appraisal block the caller may see (the lifecycle read); null when nothing readable came back. */
export function useAppraisal(projectId: string | null | undefined) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<AppraisalView | null>({
    queryKey: [...key, 'appraisal', projectId ?? ''],
    queryFn: async () => toAppraisalView(await client.read('getProjectLifecycle', { path: { id: projectId ?? '' } })) ?? null,
    enabled: key[1] !== undefined && typeof projectId === 'string',
    retry: false,
    // The sheets and the figures are the state of the day: a screen that is opened again reads them again.
    gcTime: 0,
  });
}

/** One mutation: one idempotency attempt per intention, every cached read of the register, the board and the appraisal refreshed on success. */
function useAppraisalCommand<Input>(send: (input: Input, attempt: ReturnType<AttemptRegistry['forPayload']>) => Promise<unknown>) {
  const queryClient = useQueryClient();
  const key = useScopeKey();
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

export interface SubmitProposalInput {
  id: string;
  version: number;
  body: ProposalBody;
}

export function useSubmitProposal() {
  const client = useApiClient();
  return useAppraisalCommand<SubmitProposalInput>((input, attempt) => client.command('submitProjectForAppraisal', { path: { id: input.id }, body: input.body, ifMatchVersion: input.version, attempt }));
}

export interface RecordSheetInput {
  id: string;
  body: ScoreBody;
}

/** The sheet of the caller: the first time it is created, afterwards it is replaced (the contract takes no If-Match from this client for it). */
export function useRecordSheet() {
  const client = useApiClient();
  return useAppraisalCommand<RecordSheetInput>((input, attempt) => client.command('recordProjectAppraisal', { path: { id: input.id }, body: input.body, attempt }));
}

export interface DecideInput {
  sheetId: string;
  sheetVersion: number;
  body: DecisionBody;
}

export function useDecide() {
  const client = useApiClient();
  return useAppraisalCommand<DecideInput>((input, attempt) => client.command('decideProjectAppraisal', { path: { id: input.sheetId }, body: input.body, ifMatchVersion: input.sheetVersion, attempt }));
}
