import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../api/ApiClientContext';
import { AttemptRegistry } from '../../api/attempt-registry';
import { useSession } from '../../session/SessionContext';
import { toChange, toPolicy, toRecord, toUsage, toVersion } from './model';
import type { ChangeStatus, ChangeView, PolicyView, RecordView, UsageView, VersionView } from './model';

const root = (tenantId: string | undefined) => ['mdm', tenantId] as const;

/** Every record of the tenant (of one type when given), in the order of the read. */
export function useRecords(masterType: string | undefined) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<RecordView[]>({
    queryKey: [...root(tenant?.id), 'records', masterType ?? ''],
    queryFn: async () =>
      (await client.readAll('searchMasterRecords', { query: masterType === undefined ? {} : { master_type: masterType } })).flatMap((raw) => toRecord(raw) ?? []),
    enabled: tenant !== undefined,
    retry: false,
  });
}

/** The one record that a type and a business key name, or undefined when there is none. */
export function useRecordByKey(masterType: string | undefined, businessKey: string | undefined) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<RecordView | null>({
    queryKey: [...root(tenant?.id), 'record', masterType ?? '', businessKey ?? ''],
    queryFn: async () => {
      const found = (await client.readAll('searchMasterRecords', { query: { master_type: masterType ?? '', business_key: businessKey ?? '' } })).flatMap((raw) => toRecord(raw) ?? []);
      // The query library does not accept undefined as an answer: no such entry is null.
      return found[0] ?? null;
    },
    enabled: tenant !== undefined && masterType !== undefined && businessKey !== undefined,
    retry: false,
  });
}

/** The scope policy of every catalogue type (what the platform locks and what the tenant owns). */
export function useTypePolicies() {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<PolicyView[]>({
    queryKey: [...root(tenant?.id), 'policies'],
    queryFn: async () => ((await client.read('listMasterTypePolicies')) as { items?: unknown[] }).items?.flatMap((raw) => toPolicy(raw) ?? []) ?? [],
    enabled: tenant !== undefined,
    retry: false,
  });
}

export function useChange(changeId: string | null | undefined) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<ChangeView | null>({
    queryKey: [...root(tenant?.id), 'change', changeId ?? ''],
    queryFn: async () => toChange(await client.read('getMasterChangeRequest', { path: { id: changeId ?? '' } })) ?? null,
    enabled: tenant !== undefined && typeof changeId === 'string',
    retry: false,
  });
}

/** The change requests of one status, oldest first: a queue of the approval screen. */
export function useQueue(status: ChangeStatus) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<ChangeView[]>({
    queryKey: [...root(tenant?.id), 'queue', status],
    queryFn: async () => (await client.readAll('listMasterChangeRequests', { query: { status } })).flatMap((raw) => toChange(raw) ?? []),
    enabled: tenant !== undefined,
    retry: false,
  });
}

export function useUsage(recordId: string | undefined) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<UsageView | null>({
    queryKey: [...root(tenant?.id), 'usage', recordId ?? ''],
    queryFn: async () => toUsage(await client.read('getMasterRecordUsages', { path: { id: recordId ?? '' } })) ?? null,
    enabled: tenant !== undefined && recordId !== undefined,
    retry: false,
  });
}

/** The versions of one entry, oldest first. */
export function useHistory(recordId: string | undefined) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<VersionView[]>({
    queryKey: [...root(tenant?.id), 'history', recordId ?? ''],
    queryFn: async () =>
      (await client.readAll('get_resources_master_record_version', { query: { master_record_id: recordId ?? '' } })).flatMap((raw) => toVersion(raw) ?? []).sort((left, right) => left.revision - right.revision),
    enabled: tenant !== undefined && recordId !== undefined,
    retry: false,
  });
}

export interface ProposeBody {
  namespace: 'TENANT';
  master_type: string;
  business_key: string;
  label: string;
  attributes: Record<string, unknown>;
  valid_from: string;
  valid_until?: string;
  parent_record_id?: string;
  legal_basis?: string;
  reason: string;
}

export interface ChangeBody {
  change_kind: 'UPDATE' | 'RETIRE';
  master_type: string;
  master_record_id: string;
  proposed: Record<string, unknown>;
  effective_from: string;
  reason: string;
  successor_record_id?: string;
}

/** One mutation hook: one idempotency attempt per intention, the cached reads of the tenant refreshed on success. */
function useCommand<Input>(send: (input: Input, attempt: ReturnType<AttemptRegistry['forPayload']>) => Promise<unknown>) {
  const queryClient = useQueryClient();
  const { tenant } = useSession();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: (input: Input) => send(input, attempts.current.forPayload(input)),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: root(tenant?.id) });
    },
    onError: (error) => attempts.current.ended(error),
  });
}

export function useProposeRecord() {
  const client = useApiClient();
  // The contract types a free-form object as a record of nothing; the attributes are whatever the steward typed.
  return useCommand<ProposeBody>((body, attempt) => client.command('proposeMasterRecord', { body: { ...body, attributes: body.attributes as Record<string, never> }, attempt }));
}

export function useCreateChange() {
  const client = useApiClient();
  return useCommand<ChangeBody>((body, attempt) => client.command('createMasterChangeRequest', { body: { ...body, proposed: body.proposed as Record<string, never> }, attempt }));
}

export interface VersionedInput {
  id: string;
  version: number;
}

export function useSubmitChange() {
  const client = useApiClient();
  return useCommand<VersionedInput>((input, attempt) => client.command('submitMasterChangeRequest', { path: { id: input.id }, ifMatchVersion: input.version, attempt }));
}

export interface DecideInput extends VersionedInput {
  decision: 'approve' | 'reject' | 'return';
  reason: string;
}

export function useDecideChange() {
  const client = useApiClient();
  return useCommand<DecideInput>((input, attempt) =>
    client.command('decideMasterChangeRequest', { path: { id: input.id }, body: { decision: input.decision, reason: input.reason }, ifMatchVersion: input.version, attempt }),
  );
}

export interface PublishInput extends VersionedInput {
  decisionDocumentId: string;
}

export function usePublishRecord() {
  const client = useApiClient();
  return useCommand<PublishInput>((input, attempt) =>
    client.command('post_master_records_id_publish', { path: { id: input.id }, body: { decision_document_id: input.decisionDocumentId }, ifMatchVersion: input.version, attempt }),
  );
}
