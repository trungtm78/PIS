import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../api/ApiClientContext';
import { AttemptRegistry } from '../../api/attempt-registry';
import { useSession } from '../../session/SessionContext';
import type { Catalogue, Delivery, Draft, FileContent, Generated, Issue, Period } from './model';

// What the screens show depends on the membership as well as the tenant (the right is over the whole tenant): both are part of every key.
function useScopeKey(): readonly ['rpt', string | undefined, string | undefined] {
  const { tenant } = useSession();
  return ['rpt', tenant?.id, tenant?.membershipId];
}

const q = (value: Record<string, string | number | boolean | undefined>): never => value as never;
const path = (id: string): never => ({ id }) as never;

export function useCatalogue() {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<Catalogue>({ queryKey: [...key, 'catalogue'], queryFn: () => client.read('listReportCatalogue') as Promise<Catalogue>, enabled: key[1] !== undefined, retry: false });
}

export function useDrafts(layoutCode: string | undefined) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery({
    queryKey: [...key, 'drafts', layoutCode ?? ''],
    queryFn: () => client.read('listReportDrafts', { query: q({ ...(layoutCode === undefined ? {} : { layout_code: layoutCode }), limit: 100 }) }),
    enabled: key[1] !== undefined,
    retry: false,
  });
}

export function useDraft(id: string | undefined) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<Draft>({ queryKey: [...key, 'draft', id ?? ''], queryFn: () => client.read('getReportDraft', { path: path(id as string) }) as Promise<Draft>, enabled: key[1] !== undefined && id !== undefined, retry: false });
}

export interface IssueQuery {
  layoutCode?: string | undefined;
  headsOnly: boolean;
  demo: boolean | undefined;
}

export function useIssues(filter: IssueQuery) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery({
    queryKey: [...key, 'issues', filter.layoutCode ?? '', filter.headsOnly, filter.demo ?? 'all'],
    queryFn: () => client.read('listReportIssues', { query: q({ ...(filter.layoutCode === undefined ? {} : { layout_code: filter.layoutCode }), heads_only: filter.headsOnly, ...(filter.demo === undefined ? {} : { demo: filter.demo }), limit: 100 }) }),
    enabled: key[1] !== undefined,
    retry: false,
  });
}

export function useIssue(id: string | undefined) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<Issue>({ queryKey: [...key, 'issue', id ?? ''], queryFn: () => client.read('getReportIssue', { path: path(id as string) }) as Promise<Issue>, enabled: key[1] !== undefined && id !== undefined, retry: false });
}

export function useDeliveries(layoutCode: string | undefined, receiver: string | undefined) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery({
    queryKey: [...key, 'deliveries', layoutCode ?? '', receiver ?? ''],
    queryFn: () => client.read('listReportDeliveries', { query: q({ ...(layoutCode === undefined ? {} : { layout_code: layoutCode }), ...(receiver === undefined ? {} : { receiver }), limit: 200 }) }),
    enabled: key[1] !== undefined,
    retry: false,
  });
}

/** Reads a file of a draft or of an issued copy; the server checks its bytes against the recorded hash before it answers. */
export function useFileReader() {
  const client = useApiClient();
  return {
    draftFile: (id: string, format: 'XLSX' | 'DOCX') => client.read('getReportDraftFile', { path: { id, format } as never }) as Promise<FileContent>,
    issueFile: (id: string, format: 'XLSX' | 'DOCX') => client.read('getReportIssueFile', { path: { id, format } as never }) as Promise<FileContent>,
  };
}

/** One command, one idempotency attempt per intention: the key is kept while the same request is retried and dropped when it ends. */
function useReportCommand<Input, Output = unknown>(send: (input: Input, attempt: ReturnType<AttemptRegistry['forPayload']>) => Promise<Output>) {
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

export interface GenerateInput {
  layoutCode: string;
  period: Period;
  reason: string | undefined;
}

export function useGenerate() {
  const client = useApiClient();
  return useReportCommand<GenerateInput, Generated>(
    (input, attempt) => client.command('generateReport', { body: { layout_code: input.layoutCode, period: input.period, ...(input.reason === undefined ? {} : { reason: input.reason }) }, attempt }) as Promise<Generated>,
  );
}

export interface StepInput {
  id: string;
  version: number;
  action: 'check' | 'approve' | 'issue';
}

export function useStep() {
  const client = useApiClient();
  return useReportCommand<StepInput>((input, attempt) => {
    const operation = input.action === 'check' ? 'checkReport' : input.action === 'approve' ? 'approveReport' : 'issueReport';
    return client.command(operation, { path: { id: input.id } as never, ifMatchVersion: input.version, attempt });
  });
}

export interface DeliverInput {
  issueId: string;
  receiver: string;
  channel: Delivery['channel'];
  reference: string | undefined;
  note: string | undefined;
}

export function useDeliver() {
  const client = useApiClient();
  return useReportCommand<DeliverInput>((input, attempt) =>
    client.command('deliverReport', {
      path: { id: input.issueId } as never,
      body: { receiver: input.receiver, channel: input.channel, ...(input.reference === undefined ? {} : { reference: input.reference }), ...(input.note === undefined ? {} : { note: input.note }) },
      attempt,
    }),
  );
}

export interface AnswerInput {
  issueId: string;
  receiver: string;
  outcome: 'ACCEPTED' | 'REJECTED';
  reference: string | undefined;
  note: string | undefined;
}

export function useAnswer() {
  const client = useApiClient();
  return useReportCommand<AnswerInput>((input, attempt) =>
    client.command('answerReportDelivery', {
      path: { id: input.issueId } as never,
      body: { receiver: input.receiver, outcome: input.outcome, ...(input.reference === undefined ? {} : { reference: input.reference }), ...(input.note === undefined ? {} : { note: input.note }) },
      attempt,
    }),
  );
}
