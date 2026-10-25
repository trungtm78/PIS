import { uploadFile } from '@machvon/api-client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../../api/ApiClientContext';
import { AttemptRegistry } from '../../../api/attempt-registry';
import { useSession } from '../../../session/SessionContext';
import { toContractorOption, toDeclarationList, toProposal, toUploadedProposalFile } from './model';
import type { ConflictDecision, ContractorOption, DeclarationList, DeclareBody, Proposal, ReceiveBody, UploadedProposalFile } from './model';

// What the screen shows depends on what the signed-in membership may see, not only on the tenant: the membership is part of every key.
function useScopeKey(): readonly ['bid-proposals', string | undefined, string | undefined] {
  const { tenant } = useSession();
  return ['bid-proposals', tenant?.id, tenant?.membershipId];
}

/** The proposals of a package the caller may see; what each shows of itself is decided by the server. */
export function useProposals(packageId: string) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<Proposal[]>({
    queryKey: [...key, 'proposals', packageId],
    queryFn: async () => (await client.readAll('get_resources_proposal', { query: { package_id: packageId } })).flatMap((raw) => toProposal(raw) ?? []),
    enabled: key[1] !== undefined && packageId !== '',
    retry: false,
  });
}

/** One proposal in full, with its files: the read is recorded on the server as the opening of the proposal, so it is made when the member asks and not before. */
export function useOpenProposal() {
  const client = useApiClient();
  return useMutation<Proposal | undefined, unknown, string>({
    mutationFn: async (id) => toProposal(await client.read('get_resources_proposal_id', { path: { id } })),
  });
}

/** The declarations of conflict of interest of a package: every one for whoever decides, the caller's own for a member. */
export function useDeclarations(packageId: string) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<DeclarationList>({
    queryKey: [...key, 'declarations', packageId],
    queryFn: async () => toDeclarationList(await client.read('listConflictDeclarations', { path: { id: packageId } })),
    enabled: key[1] !== undefined && packageId !== '',
    retry: false,
  });
}

/** The verified contractors, for the choice of the one whose proposal is received; read when the dialog opens. */
export function useContractorOptions(enabled: boolean) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<ContractorOption[]>({
    queryKey: [...key, 'contractors'],
    queryFn: async () => (await client.readAll('get_resources_contractor')).flatMap((raw) => toContractorOption(raw) ?? []).sort((a, b) => a.legalName.localeCompare(b.legalName)),
    enabled: enabled && key[1] !== undefined,
    retry: false,
  });
}

/** Puts one file of a bid into the shared upload pipeline (judged by its bytes, scanned, its pages counted); the answer names its key and its digest. */
export function useUploadProposalFile() {
  const client = useApiClient();
  const attempts = useRef(new AttemptRegistry());
  return useMutation<UploadedProposalFile | undefined, unknown, File>({
    mutationFn: async (file) =>
      toUploadedProposalFile(await uploadFile(client, 'uploadProposalFile', { file, attempt: attempts.current.forPayload({ name: file.name, size: file.size, type: file.type, modified: file.lastModified }) })),
    onSuccess: () => attempts.current.done(),
    onError: (error) => attempts.current.ended(error),
  });
}

/** The receipt of a proposal: one idempotency attempt per intention, every cached read refreshed on success. */
export function useReceiveProposal() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const key = useScopeKey();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: (body: ReceiveBody) => client.command('receiveProposal', { body, attempt: attempts.current.forPayload(body) }),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: key });
    },
    onError: (error) => attempts.current.ended(error),
  });
}

export interface DeclareInput {
  packageId: string;
  body: DeclareBody;
}

/** The declaration of the signed-in member for a package, once. */
export function useDeclare() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const key = useScopeKey();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: (input: DeclareInput) => client.command('declareConflictOfInterest', { path: { id: input.packageId }, body: input.body, attempt: attempts.current.forPayload(input) }),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: key });
    },
    onError: (error) => attempts.current.ended(error),
  });
}

export interface DecideInput {
  declarationId: string;
  version: number;
  body: { decision: ConflictDecision; decision_reason: string };
}

/** The decision on a declaration, under the version the decider saw. */
export function useDecide() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const key = useScopeKey();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: (input: DecideInput) =>
      client.command('decideConflictOfInterest', { path: { id: input.declarationId }, body: input.body, ifMatchVersion: input.version, attempt: attempts.current.forPayload(input) }),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: key });
    },
    onError: (error) => attempts.current.ended(error),
  });
}
