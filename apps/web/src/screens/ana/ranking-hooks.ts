import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../api/ApiClientContext';
import { AttemptRegistry } from '../../api/attempt-registry';
import { useSession } from '../../session/SessionContext';
import { toAnnotations, toComplaints, toRanking } from './ranking-model';
import type { Annotation, Complaint, MetricCode, RankingReading } from './ranking-model';

const root = (tenantId: string | undefined, membershipId: string | undefined) => ['ana', tenantId, membershipId, 'ranking'] as const;
const base = { retry: false, staleTime: 0, refetchOnWindowFocus: false } as const;

export function useMultiRanking() {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<RankingReading>({
    queryKey: [...root(tenant?.id, tenant?.membershipId), 'multi'],
    queryFn: async () => {
      const reading = toRanking(await client.read('getMultiMetricRanking', {}));
      if (reading === undefined) throw new Error('the ranking could not be read');
      return reading;
    },
    enabled: tenant !== undefined,
    ...base,
  });
}

export function useAnnotations(status: string) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<Annotation[]>({
    queryKey: [...root(tenant?.id, tenant?.membershipId), 'annotations', status],
    queryFn: async () => {
      const items = toAnnotations(await client.read('listRankingAnnotations', { query: status === '' ? {} : { status } }));
      if (items === undefined) throw new Error('the notes could not be read');
      return items;
    },
    enabled: tenant !== undefined,
    ...base,
  });
}

export function useComplaints(status: string) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<Complaint[]>({
    queryKey: [...root(tenant?.id, tenant?.membershipId), 'complaints', status],
    queryFn: async () => {
      const items = toComplaints(await client.read('listRankingComplaints', { query: status === '' ? {} : { status } }));
      if (items === undefined) throw new Error('the complaints could not be read');
      return items;
    },
    enabled: tenant !== undefined,
    ...base,
  });
}

export interface ProposeInput {
  unitId: string;
  reasonCode: string;
  metricCodes: readonly MetricCode[];
  evidence: string;
  validTo: string;
}
export interface DecideInput {
  id: string;
  decision: 'APPROVE' | 'REJECT' | 'WITHDRAW';
  note: string;
}
export interface FileInput {
  unitId: string;
  metricCode: MetricCode;
  asOfDate: string;
  claim: string;
  claimedValue: string;
}
export interface ResolveInput {
  id: string;
  action: 'START_REVIEW' | 'UPHOLD' | 'REJECT' | 'CORRECT';
  resolution: string;
}

/** The four commands of the notes and complaints; each intention keeps one idempotency attempt across retries and the lists are read again after a success so the server stays the truth. */
export function useRankingCommands() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const { tenant } = useSession();
  const proposeAttempts = useRef(new AttemptRegistry());
  const decideAttempts = useRef(new AttemptRegistry());
  const fileAttempts = useRef(new AttemptRegistry());
  const resolveAttempts = useRef(new AttemptRegistry());
  const refresh = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: root(tenant?.id, tenant?.membershipId) });
  };
  const propose = useMutation({
    mutationFn: (input: ProposeInput) => {
      const body = { unit_id: input.unitId, reason_code: input.reasonCode, metric_codes: [...input.metricCodes], evidence: input.evidence.trim(), valid_to: input.validTo };
      return client.command('proposeRankingAnnotation', { body, attempt: proposeAttempts.current.forPayload(body) });
    },
    onSuccess: async () => {
      proposeAttempts.current.done();
      await refresh();
    },
    onError: (error) => proposeAttempts.current.ended(error),
  });
  const decide = useMutation({
    mutationFn: (input: DecideInput) => {
      const body = { decision: input.decision, note: input.note.trim() };
      return client.command('decideRankingAnnotation', { path: { id: input.id }, body, attempt: decideAttempts.current.forPayload({ id: input.id, ...body }) });
    },
    onSuccess: async () => {
      decideAttempts.current.done();
      await refresh();
    },
    onError: (error) => decideAttempts.current.ended(error),
  });
  const file = useMutation({
    mutationFn: (input: FileInput) => {
      const body = { unit_id: input.unitId, metric_code: input.metricCode, as_of_date: input.asOfDate, claim: input.claim.trim(), ...(input.claimedValue.trim() === '' ? {} : { claimed_value: input.claimedValue.trim() }) };
      return client.command('fileRankingComplaint', { body, attempt: fileAttempts.current.forPayload(body) });
    },
    onSuccess: async () => {
      fileAttempts.current.done();
      await refresh();
    },
    onError: (error) => fileAttempts.current.ended(error),
  });
  const resolve = useMutation({
    mutationFn: (input: ResolveInput) => {
      const body = { action: input.action, ...(input.resolution.trim() === '' ? {} : { resolution: input.resolution.trim() }) };
      return client.command('resolveRankingComplaint', { path: { id: input.id }, body, attempt: resolveAttempts.current.forPayload({ id: input.id, ...body }) });
    },
    onSuccess: async () => {
      resolveAttempts.current.done();
      await refresh();
    },
    onError: (error) => resolveAttempts.current.ended(error),
  });
  return { propose, decide, file, resolve };
}
