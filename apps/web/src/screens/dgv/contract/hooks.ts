import { ApiError } from '@machvon/api-client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useApiClient } from '../../../api/ApiClientContext';
import { useSession } from '../../../session/SessionContext';
import { root, useCommand } from '../hooks';
import { toRevision, toVersion, toWaiting } from './model';
import type { DataVersion, DraftForm, Revision, WaitingApproval } from './model';
import { draftBody } from './model';

/** The revisions of the contracts of a dataset (or of all the datasets the person may see), newest first; the consumer approvals of those in review are in them. */
export function useRevisions(query: { datasetId?: string | undefined; status?: string | undefined }, enabled = true) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<Revision[]>({
    queryKey: [...root(tenant?.id), tenant?.membershipId, 'contracts', query.datasetId, query.status],
    queryFn: async () =>
      (
        await client.readAll('get_resources_dataset_contract', {
          query: { ...(query.datasetId === undefined ? {} : { dataset_id: query.datasetId }), ...(query.status === undefined ? {} : { status: query.status }) } as never,
        })
      ).flatMap((raw) => toRevision(raw) ?? []),
    enabled: enabled && tenant !== undefined,
    retry: false,
  });
}

/** The approvals that wait for the person as the owner of a consumer: theirs only, whether or not they may see the dataset; the ones of a revision that is no longer in review are left out. */
export function useWaiting() {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<WaitingApproval[]>({
    queryKey: [...root(tenant?.id), tenant?.membershipId, 'waiting-approvals'],
    queryFn: async () =>
      (await client.readAll('listConsumerApprovals', { query: { decision: 'PENDING' } as never })).flatMap((raw) => toWaiting(raw) ?? []).filter((waiting) => waiting.contractStatus === 'IN_REVIEW'),
    enabled: tenant !== undefined,
    retry: false,
  });
}

/** One revision with the changes from the version before it. */
export function useRevision(id: string | undefined) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<Revision>({
    queryKey: [...root(tenant?.id), tenant?.membershipId, 'contract', id],
    queryFn: async () => {
      const found = toRevision(await client.read('get_resources_dataset_contract_id', { path: { id: id as string } }));
      if (found === undefined) throw new Error('the contract could not be read');
      return found;
    },
    enabled: tenant !== undefined && id !== undefined,
    retry: false,
  });
}

/** The versions published for a dataset, newest first. */
export function useVersions(datasetId: string | undefined) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<DataVersion[]>({
    queryKey: [...root(tenant?.id), tenant?.membershipId, 'contract-versions', datasetId],
    queryFn: async () => (await client.readAll('get_resources_data_contract_version', { query: { dataset_id: datasetId as string } as never })).flatMap((raw) => toVersion(raw) ?? []),
    enabled: tenant !== undefined && datasetId !== undefined,
    retry: false,
  });
}

export interface DraftInput {
  datasetId: string;
  form: DraftForm;
}

export function useDraftRevision() {
  const client = useApiClient();
  return useCommand<DraftInput>((input, attempt) => client.command('createDatasetContractRevision', { body: draftBody(input.datasetId, input.form) as never, attempt }));
}

export interface PublishInput {
  id: string;
  version: number;
  windowUntil: string | undefined;
}

export function usePublishRevision() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const { tenant } = useSession();
  return useCommand<PublishInput>(async (input, attempt) => {
    try {
      return await client.command('publishDatasetContract', {
        path: { id: input.id },
        body: (input.windowUntil === undefined ? {} : { migration_window_until: input.windowUntil }) as never,
        ifMatchVersion: input.version,
        attempt,
      });
    } catch (error) {
      // A publication that finds consumers nobody asked yet keeps the approvals it asked for and then refuses: what the screen shows is read again.
      if (error instanceof ApiError && error.code === 'CONSUMER_APPROVAL_PENDING') await queryClient.invalidateQueries({ queryKey: root(tenant?.id) });
      throw error;
    }
  });
}

export interface CloseInput {
  id: string;
  version: number;
  decision: 'return' | 'reject';
  reason: string;
}

/** The owner of the data returns or rejects the revision in review: the producer can draft another. */
export function useCloseRevision() {
  const client = useApiClient();
  return useCommand<CloseInput>((input, attempt) =>
    client.command('post_data_contracts_id_publish', {
      path: { id: input.id },
      body: { decision: input.decision, reason: input.reason.trim(), evidence_ids: [] } as never,
      ifMatchVersion: input.version,
      attempt,
    }),
  );
}

export interface ConsumerDecisionInput {
  id: string;
  version: number;
  decision: 'APPROVED' | 'REJECTED';
  comment: string;
}

export function useDecideConsumer() {
  const client = useApiClient();
  return useCommand<ConsumerDecisionInput>((input, attempt) =>
    client.command('recordConsumerApproval', {
      path: { id: input.id },
      body: { decision: input.decision, ...(input.comment.trim() === '' ? {} : { comment: input.comment.trim() }) } as never,
      ifMatchVersion: input.version,
      attempt,
    }),
  );
}
