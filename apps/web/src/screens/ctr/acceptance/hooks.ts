import { useQuery } from '@tanstack/react-query';
import { useApiClient } from '../../../api/ApiClientContext';
import { useCommand, useScopeKey } from '../hooks';
import { toAcceptance } from './model';
import type { Acceptance, Decision, DraftBody } from './model';

/** The acceptances of a contract the caller may see, the latest first. */
export function useAcceptances(contractId: string | null | undefined) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<Acceptance[]>({
    queryKey: [...key, 'acceptances', contractId ?? ''],
    queryFn: async () => (await client.readAll('get_resources_acceptance', { query: { contract_id: contractId ?? '' } })).flatMap((raw) => toAcceptance(raw) ?? []),
    enabled: key[1] !== undefined && typeof contractId === 'string',
    retry: false,
  });
}

export interface DraftInput {
  contractId: string;
  body: DraftBody;
}

/** Drafts an acceptance from approved measurements; the server prices every line at the price of the revision in force on the day. */
export function useDraftAcceptance() {
  const client = useApiClient();
  return useCommand<DraftInput>((input, attempt) => client.command('createAcceptance', { path: { id: input.contractId }, body: input.body, attempt }));
}

export interface SubmitInput {
  id: string;
  version: number;
  body: { signer_refs: Array<{ name: string }> };
}

export function useSubmitAcceptance() {
  const client = useApiClient();
  return useCommand<SubmitInput>((input, attempt) => client.command('submitAcceptance', { path: { id: input.id }, body: input.body, ifMatchVersion: input.version, attempt }));
}

export interface DecideInput {
  id: string;
  version: number;
  body: { decision: Decision; reason: string; evidence_ids: string[] };
}

export function useDecideAcceptance() {
  const client = useApiClient();
  return useCommand<DecideInput>((input, attempt) => client.command('post_acceptances_id_decision', { path: { id: input.id }, body: input.body, ifMatchVersion: input.version, attempt }));
}

export interface RevokeInput {
  id: string;
  version: number;
  body: { reason: string; approval_document_version_id: string };
}

export function useRevokeAcceptance() {
  const client = useApiClient();
  return useCommand<RevokeInput>((input, attempt) => client.command('revokeAcceptance', { path: { id: input.id }, body: input.body, ifMatchVersion: input.version, attempt }));
}
