import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../../api/ApiClientContext';
import { AttemptRegistry } from '../../../api/attempt-registry';
import { useSession } from '../../../session/SessionContext';
import type { FeedbackView, FileDetail, FileList, Oc4idsExport, PortalRecordList, PortalSettingsRead } from './prjModel';

// What the screens show depends on the membership as well as the tenant (the right is over the whole tenant): both are part of every key.
function useScopeKey(): readonly ['prj12', string | undefined, string | undefined] {
  const { tenant } = useSession();
  return ['prj12', tenant?.id, tenant?.membershipId];
}

const q = (value: Record<string, string | number | boolean | undefined>): never => value as never;
const path = (parameters: Record<string, string>): never => parameters as never;

export function useMonitoringFiles(status: string | undefined, offset: number, size: number) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<FileList>({
    queryKey: [...key, 'files', status ?? '', offset, size],
    queryFn: () => client.read('listMonitoringFiles', { query: q({ ...(status === undefined ? {} : { status }), limit: size, offset }) }) as unknown as Promise<FileList>,
    enabled: key[1] !== undefined,
    retry: false,
  });
}

export function useMonitoringFile(id: string | undefined) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<FileDetail>({
    queryKey: [...key, 'file', id ?? ''],
    queryFn: () => client.read('getMonitoringFile', { path: path({ id: id as string }) }) as unknown as Promise<FileDetail>,
    enabled: key[1] !== undefined && id !== undefined,
    retry: false,
  });
}

export function usePortalSettings() {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<PortalSettingsRead>({ queryKey: [...key, 'portal-settings'], queryFn: () => client.read('getPortalSettings') as unknown as Promise<PortalSettingsRead>, enabled: key[1] !== undefined, retry: false });
}

export function usePortalRecords(includeWithdrawn: boolean, offset: number, size: number) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<PortalRecordList>({
    queryKey: [...key, 'portal-records', includeWithdrawn, offset, size],
    queryFn: () => client.read('listPortalRecords', { query: q({ include_withdrawn: includeWithdrawn, limit: size, offset }) }) as unknown as Promise<PortalRecordList>,
    enabled: key[1] !== undefined,
    retry: false,
  });
}

export function useOc4idsExport(enabled: boolean) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<Oc4idsExport>({ queryKey: [...key, 'oc4ids'], queryFn: () => client.read('exportPortalOc4ids') as unknown as Promise<Oc4idsExport>, enabled: key[1] !== undefined && enabled, retry: false });
}

/** One command, one idempotency attempt per intention: the key is kept while the same request is retried and dropped when it ends. */
function useCommand<Input, Output = unknown>(send: (input: Input, attempt: ReturnType<AttemptRegistry['forPayload']>) => Promise<Output>) {
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

export function useOpenFile() {
  const client = useApiClient();
  return useCommand<{ projectId: string }, { resource_id: string; status: string }>((input, attempt) => client.command('openMonitoringFile', { body: { project_id: input.projectId }, attempt }) as Promise<{ resource_id: string; status: string }>);
}

export interface TriggerInput {
  id: string;
  version: number;
  kind: string;
  on: string;
  reason: string | undefined;
}

export function useSetTrigger() {
  const client = useApiClient();
  return useCommand<TriggerInput>((input, attempt) =>
    client.command('setMonitoringTrigger', { path: path({ id: input.id }), ifMatchVersion: input.version, body: { kind: input.kind, on: input.on, ...(input.reason === undefined ? {} : { reason: input.reason }) } as never, attempt }),
  );
}

export interface AddItemInput {
  id: string;
  item: string;
  documentId: string;
  documentKind: string;
}

export function useAddItem() {
  const client = useApiClient();
  return useCommand<AddItemInput>((input, attempt) => client.command('addMonitoringPackItem', { path: path({ id: input.id }), body: { item: input.item, document_id: input.documentId, document_kind: input.documentKind } as never, attempt }));
}

export function useWithdrawItem() {
  const client = useApiClient();
  return useCommand<{ itemId: string; reason: string }>((input, attempt) => client.command('withdrawMonitoringPackItem', { path: path({ id: input.itemId }), body: { reason: input.reason }, attempt }));
}

export interface NoticeInput {
  id: string;
  version: number;
  sentOn: string;
  note: string | undefined;
}

export function useSendNotice() {
  const client = useApiClient();
  return useCommand<NoticeInput>((input, attempt) => client.command('sendMonitoringNotice', { path: path({ id: input.id }), ifMatchVersion: input.version, body: { sent_on: input.sentOn, ...(input.note === undefined ? {} : { note: input.note }) }, attempt }));
}

export function useCloseFile() {
  const client = useApiClient();
  return useCommand<{ id: string; version: number }>((input, attempt) => client.command('closeMonitoringFile', { path: path({ id: input.id }), ifMatchVersion: input.version, attempt }));
}

export interface LogInput {
  id: string;
  reference: string;
  receivedOn: string;
  channel: string;
  topic: string;
  fromLabel: string | undefined;
  summary: string;
}

export function useLogFeedback() {
  const client = useApiClient();
  return useCommand<LogInput>((input, attempt) =>
    client.command('logMonitoringFeedback', {
      path: path({ id: input.id }),
      body: { reference: input.reference, received_on: input.receivedOn, channel: input.channel, topic: input.topic, summary: input.summary, ...(input.fromLabel === undefined ? {} : { from_label: input.fromLabel }) } as never,
      attempt,
    }),
  );
}

export interface MoveInput {
  feedback: FeedbackView;
  move: 'TAKE' | 'RESPOND' | 'CLOSE' | 'REOPEN' | 'DECLINE';
  text: string | undefined;
}

export function useMoveFeedback() {
  const client = useApiClient();
  return useCommand<MoveInput>((input, attempt) =>
    client.command('moveMonitoringFeedback', { path: path({ id: input.feedback.id }), ifMatchVersion: input.feedback.version, body: { move: input.move, ...(input.text === undefined ? {} : { text: input.text }) } as never, attempt }),
  );
}

export interface SettingsInput {
  expectedVersion: number;
  slug: string;
  enabled: boolean;
  whistleEnabled: boolean;
  title: string;
  publisherName: string;
  idPrefix: string;
  licenseUri: string;
  policyUri: string;
}

export function useSaveSettings() {
  const client = useApiClient();
  return useCommand<SettingsInput>((input, attempt) =>
    client.command('savePortalSettings', {
      body: { expected_version: input.expectedVersion, slug: input.slug, enabled: input.enabled, whistle_enabled: input.whistleEnabled, title: input.title, publisher_name: input.publisherName, id_prefix: input.idPrefix, license_uri: input.licenseUri, policy_uri: input.policyUri } as never,
      attempt,
    }),
  );
}

export interface PublishInput {
  projectId: string;
  summary: string;
  sector: string;
  projectType: string;
  purpose: string;
}

export function usePublishRecord() {
  const client = useApiClient();
  return useCommand<PublishInput, { status: string }>(
    (input, attempt) => client.command('publishPortalRecord', { body: { project_id: input.projectId, summary: input.summary, sector: input.sector, project_type: input.projectType, purpose: input.purpose } as never, attempt }) as Promise<{ status: string }>,
  );
}

export function useWithdrawRecord() {
  const client = useApiClient();
  return useCommand<{ projectId: string; reason: string }>((input, attempt) => client.command('withdrawPortalRecord', { path: path({ project_id: input.projectId }), body: { reason: input.reason }, attempt }));
}
