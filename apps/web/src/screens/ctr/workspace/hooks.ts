import { useQuery } from '@tanstack/react-query';
import { useApiClient } from '../../../api/ApiClientContext';
import { useCommand, useScopeKey } from '../hooks';
import { toSummary } from './model';
import type { ActivateBody, CloseBody, CompleteBody, SignBody, Summary } from './model';

/** The summary of one contract: the contract, the people behind its signature, what stands before its activation and what the caller may do now; null when none is named. */
export function useSummary(contractId: string | null | undefined) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<Summary | null>({
    queryKey: [...key, 'summary', contractId ?? ''],
    queryFn: async () => toSummary(await client.read('getContractSummary', { path: { id: contractId ?? '' } })) ?? null,
    enabled: key[1] !== undefined && typeof contractId === 'string',
    retry: false,
  });
}

export interface NoteInput {
  id: string;
  version: number;
  text: string;
}

/** Sends the contract to review; the note may be empty. */
export function useSubmitReview() {
  const client = useApiClient();
  return useCommand<NoteInput>((input, attempt) =>
    client.command('submitContractForReview', { path: { id: input.id }, body: input.text.trim() === '' ? {} : { note: input.text.trim() }, ifMatchVersion: input.version, attempt }),
  );
}

/** Gives the contract back to its drafter with the reason. */
export function useReturnDraft() {
  const client = useApiClient();
  return useCommand<NoteInput>((input, attempt) => client.command('returnContractDraft', { path: { id: input.id }, body: { reason: input.text.trim() }, ifMatchVersion: input.version, attempt }));
}

export interface SignInput {
  id: string;
  version: number;
  body: SignBody;
}

export function useSignContract() {
  const client = useApiClient();
  return useCommand<SignInput>((input, attempt) => client.command('recordContractSigning', { path: { id: input.id }, body: input.body, ifMatchVersion: input.version, attempt }));
}

export interface ActivateInput {
  id: string;
  version: number;
  body: ActivateBody;
}

export function useActivateContract() {
  const client = useApiClient();
  return useCommand<ActivateInput>((input, attempt) => client.command('post_contracts_id_activate', { path: { id: input.id }, body: input.body, ifMatchVersion: input.version, attempt }));
}

export interface CompleteInput {
  id: string;
  version: number;
  body: CompleteBody;
}

export interface CloseInput {
  id: string;
  version: number;
  body: CloseBody;
}

export function useCloseContract() {
  const client = useApiClient();
  return useCommand<CloseInput>((input, attempt) => client.command('closeContract', { path: { id: input.id }, body: input.body, ifMatchVersion: input.version, attempt }));
}

export function useCompleteContract() {
  const client = useApiClient();
  return useCommand<CompleteInput>((input, attempt) => client.command('completeContract', { path: { id: input.id }, body: input.body, ifMatchVersion: input.version, attempt }));
}
