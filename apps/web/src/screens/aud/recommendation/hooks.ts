import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { AttemptRegistry } from '../../../api/attempt-registry';
import { useApiClient } from '../../../api/ApiClientContext';
import { useScopeKey } from '../hooks';
import { toBoardItem } from './model';
import type { AssignBody, BoardItem, CompleteBody, DecisionBody, DisputeBody, EvidenceBody, PlanBody, VerifyBody } from './model';

export interface BoardFilter {
  engagementId: string | undefined;
  status: '' | BoardItem['status'];
  type: '' | BoardItem['type'];
}

/** The recommendations in the scope of the caller, or given to them, filtered by the server on the engagement, the status and the type. */
export function useRecommendationBoard(filter: BoardFilter) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<BoardItem[]>({
    queryKey: [...key, 'board', filter.engagementId ?? '', filter.status, filter.type],
    queryFn: async () => {
      const items: unknown[] = await client.readAll('listAuditRecommendations', {
        query: {
          ...(filter.engagementId === undefined ? {} : { engagement_id: filter.engagementId }),
          ...(filter.status === '' ? {} : { status: filter.status }),
          ...(filter.type === '' ? {} : { rec_type: filter.type }),
        },
      });
      return items.flatMap((raw) => toBoardItem(raw) ?? []);
    },
    enabled: key[1] !== undefined,
    retry: false,
  });
}

type Client = ReturnType<typeof useApiClient>;
type Attempt = ReturnType<AttemptRegistry['forPayload']>;

/** A command of AUD: one idempotency attempt per intention, every cached read of AUD refreshed on success. */
export function useAudCommand<I>(send: (client: Client, input: I, attempt: Attempt) => Promise<unknown>) {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const key = useScopeKey();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: (input: I) => send(client, input, attempts.current.forPayload(input)),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: key });
    },
    onError: (error) => attempts.current.ended(error),
  });
}

export interface Versioned<B> {
  id: string;
  version: number;
  body: B;
}

export const useAssign = () =>
  useAudCommand((client, input: Versioned<AssignBody>, attempt) => client.command('assignAuditRecommendation', { path: { id: input.id }, body: input.body, ifMatchVersion: input.version, attempt }));

export const usePlan = () =>
  useAudCommand((client, input: Versioned<PlanBody>, attempt) => client.command('planRemediationAction', { path: { id: input.id }, body: input.body, ifMatchVersion: input.version, attempt }));

/** The completion is under the version of the action, not of the recommendation. */
export const useComplete = () =>
  useAudCommand((client, input: Versioned<CompleteBody>, attempt) => client.command('completeRemediationAction', { path: { id: input.id }, body: input.body, ifMatchVersion: input.version, attempt }));

export const useSubmit = () =>
  useAudCommand((client, input: { id: string; version: number }, attempt) =>
    client.command('submitRecommendationForVerification', { path: { id: input.id }, ifMatchVersion: input.version, attempt }),
  );

export const useVerify = () =>
  useAudCommand((client, input: Versioned<VerifyBody>, attempt) => client.command('verifyAuditRecommendation', { path: { id: input.id }, body: input.body, ifMatchVersion: input.version, attempt }));

export const useDispute = () =>
  useAudCommand((client, input: Versioned<DisputeBody>, attempt) => client.command('disputeAuditRecommendation', { path: { id: input.id }, body: input.body, ifMatchVersion: input.version, attempt }));

export const useDecide = () =>
  useAudCommand((client, input: Versioned<DecisionBody>, attempt) => client.command('recordAuditDisputeDecision', { path: { id: input.id }, body: input.body, ifMatchVersion: input.version, attempt }));

export const useAttachEvidence = () => useAudCommand((client, input: EvidenceBody, attempt) => client.command('attachAuditEvidence', { body: input, attempt }));
