import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useApiClient } from '../../../api/ApiClientContext';
import { AttemptRegistry } from '../../../api/attempt-registry';
import { useScopeKey } from '../hooks';
import { toFeedbackLine, toPlanTimers } from './model';
import type { FeedbackBody, FeedbackLine, PlanTimers } from './model';

/** The timers of a plan and its opinions counted, as the server counted them at the moment of the read. */
export function usePlanTimers(planId: string | undefined) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<PlanTimers | undefined>({
    queryKey: [...key, 'plan-timers', planId ?? ''],
    queryFn: async () => toPlanTimers(await client.read('getCompensationPlanTimers', { path: { id: planId ?? '' } })),
    enabled: key[1] !== undefined && planId !== undefined,
    retry: false,
  });
}

/** The opinions on one plan inside the units of the caller. */
export function usePlanFeedback(planId: string | undefined) {
  const client = useApiClient();
  const key = useScopeKey();
  return useQuery<FeedbackLine[]>({
    queryKey: [...key, 'plan-feedback', planId ?? ''],
    queryFn: async () => (await client.readAll('listPlanFeedback', { path: { id: planId ?? '' } })).flatMap((raw) => toFeedbackLine(raw) ?? []),
    enabled: key[1] !== undefined && planId !== undefined,
    retry: false,
  });
}

export interface PostInput {
  id: string;
  version: number;
  body: { posting_started_on: string; posting_place_text: string };
}

/** The posting of a draft plan, under the version the caller saw: one idempotency attempt per intention, every cached read of the land screens refreshed on success. */
export function usePostPlan() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const key = useScopeKey();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: (input: PostInput) => client.command('postCompensationPlan', { path: { id: input.id }, body: input.body, ifMatchVersion: input.version, attempt: attempts.current.forPayload(input) }),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: key });
    },
    onError: (error) => attempts.current.ended(error),
  });
}

export interface RecordFeedbackInput {
  id: string;
  body: FeedbackBody;
}

export function useRecordFeedback() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const key = useScopeKey();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: (input: RecordFeedbackInput) => client.command('recordPlanFeedback', { path: { id: input.id }, body: input.body, attempt: attempts.current.forPayload(input) }),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: key });
    },
    onError: (error) => attempts.current.ended(error),
  });
}

export interface HandleFeedbackInput {
  id: string;
  feedbackId: string;
  note: string;
}

export function useHandleFeedback() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const key = useScopeKey();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: (input: HandleFeedbackInput) =>
      client.command('handlePlanFeedback', { path: { id: input.id, feedback_id: input.feedbackId }, body: { handling_note: input.note.trim() }, attempt: attempts.current.forPayload(input) }),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: key });
    },
    onError: (error) => attempts.current.ended(error),
  });
}

export interface ClosePostingInput {
  id: string;
  version: number;
  summary: string;
}

/** The closing of the posting with the summary of the opinions, under the version the caller saw. */
export function useClosePosting() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const key = useScopeKey();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: (input: ClosePostingInput) =>
      client.command('closePlanPosting', { path: { id: input.id }, body: { feedback_summary: input.summary.trim() }, ifMatchVersion: input.version, attempt: attempts.current.forPayload(input) }),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: key });
    },
    onError: (error) => attempts.current.ended(error),
  });
}

export interface ApproveInput {
  id: string;
  version: number;
  body: { approved_on: string; decision_document_version_id: string };
}

/** The approval of a plan whose posting is closed, under the version the caller saw. */
export function useApprovePlan() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const key = useScopeKey();
  const attempts = useRef(new AttemptRegistry());
  return useMutation({
    mutationFn: (input: ApproveInput) => client.command('approveCompensationPlan', { path: { id: input.id }, body: input.body, ifMatchVersion: input.version, attempt: attempts.current.forPayload(input) }),
    onSuccess: async () => {
      attempts.current.done();
      await queryClient.invalidateQueries({ queryKey: key });
    },
    onError: (error) => attempts.current.ended(error),
  });
}
