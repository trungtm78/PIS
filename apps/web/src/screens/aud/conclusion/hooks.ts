import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { AttemptRegistry } from '../../../api/attempt-registry';
import { useApiClient } from '../../../api/ApiClientContext';
import { useScopeKey } from '../hooks';
import { toConclusion, toFinding, toRecommendation } from './model';
import type { ConclusionBody, ConclusionLine, FindingBody, FindingLine, RecommendationBody, RecommendationLine } from './model';

/** The conclusions of an engagement, the newest revision first, each with what its recommendations add up to and what is left of its total. */
export function useConclusions(engagementId: string | undefined) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<ConclusionLine[]>({
    queryKey: [...key, 'conclusions', engagementId ?? ''],
    queryFn: async () => {
      const items: unknown[] = await client.readAll('listAuditConclusions', { path: { id: engagementId ?? '' } });
      return items.flatMap((raw) => toConclusion(raw) ?? []);
    },
    enabled: key[1] !== undefined && engagementId !== undefined,
    retry: false,
  });
}

/** The findings of a conclusion, by code. */
export function useFindings(conclusionId: string | undefined) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<FindingLine[]>({
    queryKey: [...key, 'findings', conclusionId ?? ''],
    queryFn: async () => {
      const items: unknown[] = await client.readAll('listAuditFindings', { path: { id: conclusionId ?? '' } });
      return items.flatMap((raw) => toFinding(raw) ?? []);
    },
    enabled: key[1] !== undefined && conclusionId !== undefined,
    retry: false,
  });
}

/** The recommendations of a conclusion, by code. */
export function useRecommendations(conclusionId: string | undefined) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<RecommendationLine[]>({
    queryKey: [...key, 'recommendations', conclusionId ?? ''],
    queryFn: async () => {
      const items: unknown[] = await client.readAll('listAuditRecommendations', { query: { conclusion_id: conclusionId ?? '' } });
      return items.flatMap((raw) => toRecommendation(raw) ?? []);
    },
    enabled: key[1] !== undefined && conclusionId !== undefined,
    retry: false,
  });
}

export interface RecordConclusionInput {
  engagementId: string;
  version: number;
  body: ConclusionBody;
}

/** The record of a conclusion, under the version of the engagement the caller saw: one idempotency attempt per intention, every cached read of AUD refreshed on success. */
export function useRecordConclusion() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const key = useScopeKey();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: (input: RecordConclusionInput) =>
      client.command('recordAuditConclusion', { path: { id: input.engagementId }, body: input.body, ifMatchVersion: input.version, attempt: attempts.current.forPayload(input) }),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: key });
    },
    onError: (error) => attempts.current.ended(error),
  });
}

export interface RecordFindingInput {
  conclusionId: string;
  body: FindingBody;
}

/** The record of a finding of a conclusion. */
export function useRecordFinding() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const key = useScopeKey();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: (input: RecordFindingInput) => client.command('recordAuditFinding', { path: { id: input.conclusionId }, body: input.body, attempt: attempts.current.forPayload(input) }),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: key });
    },
    onError: (error) => attempts.current.ended(error),
  });
}

export interface CreateRecommendationInput {
  conclusionId: string;
  body: RecommendationBody;
}

/** The creation of a recommendation on a conclusion. */
export function useCreateRecommendation() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const key = useScopeKey();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: (input: CreateRecommendationInput) =>
      client.command('createAuditRecommendation', { path: { id: input.conclusionId }, body: input.body, attempt: attempts.current.forPayload(input) }),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: key });
    },
    onError: (error) => attempts.current.ended(error),
  });
}
