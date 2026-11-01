import { useQuery } from '@tanstack/react-query';
import { useApiClient } from '../../../api/ApiClientContext';
import { useSession } from '../../../session/SessionContext';
import { root, useCommand } from '../hooks';
import { milestoneBody, recordBody, rubricBody, startBody, toAssessment, toEvidence, toMilestone, toRubric, toScore } from './model';
import type { Assessment, EvidenceRow, Milestone, MilestoneForm, RecordForm, Rubric, RubricForm, Score, StartForm } from './model';

/** The versions of the rubrics, newest first. */
export function useRubrics() {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<Rubric[]>({
    queryKey: [...root(tenant?.id), tenant?.membershipId, 'maturity-rubrics'],
    queryFn: async () => (await client.readAll('listMaturityRubrics')).flatMap((raw) => toRubric(raw) ?? []),
    enabled: tenant !== undefined,
    retry: false,
  });
}

export function useAssessments() {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<Assessment[]>({
    queryKey: [...root(tenant?.id), tenant?.membershipId, 'maturity-assessments'],
    queryFn: async () => (await client.readAll('get_resources_maturity_assessment')).flatMap((raw) => toAssessment(raw) ?? []),
    enabled: tenant !== undefined,
    retry: false,
  });
}

/** The score of an assessment with what it stands on: on its day of publication once published, on today before. */
export function useScore(assessmentId: string | undefined) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<Score>({
    queryKey: [...root(tenant?.id), tenant?.membershipId, 'maturity-score', assessmentId],
    queryFn: async () => {
      const score = toScore(await client.read('getMaturityScore', { path: { id: assessmentId as string } }));
      if (score === undefined) throw new Error('the score could not be read');
      return score;
    },
    enabled: tenant !== undefined && assessmentId !== undefined,
    retry: false,
  });
}

/** The rows of the criteria of an assessment, with the versions that a record or a review is made against. */
export function useEvidence(assessmentId: string | undefined) {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<EvidenceRow[]>({
    queryKey: [...root(tenant?.id), tenant?.membershipId, 'maturity-evidence', assessmentId],
    queryFn: async () => (await client.readAll('get_resources_maturity_evidence', { query: { assessment_id: assessmentId as string } as never })).flatMap((raw) => toEvidence(raw) ?? []),
    enabled: tenant !== undefined && assessmentId !== undefined,
    retry: false,
  });
}

export function useMilestones() {
  const client = useApiClient();
  const { tenant } = useSession();
  return useQuery<Milestone[]>({
    queryKey: [...root(tenant?.id), tenant?.membershipId, 'maturity-milestones'],
    queryFn: async () => (await client.readAll('listMaturityMilestones')).flatMap((raw) => toMilestone(raw) ?? []),
    enabled: tenant !== undefined,
    retry: false,
  });
}

export function useDraftRubric() {
  const client = useApiClient();
  return useCommand<RubricForm>((form, attempt) => client.command('createMaturityRubricVersion', { body: rubricBody(form) as never, attempt }));
}

export interface VersionedInput {
  id: string;
  version: number;
}

export function usePublishRubric() {
  const client = useApiClient();
  return useCommand<VersionedInput>((input, attempt) => client.command('publishMaturityRubric', { path: { id: input.id }, body: {} as never, ifMatchVersion: input.version, attempt }));
}

export function useStartAssessment() {
  const client = useApiClient();
  return useCommand<StartForm>((form, attempt) => client.command('createMaturityAssessment', { body: startBody(form) as never, attempt }));
}

export interface RecordInput {
  assessmentId: string;
  evidence: EvidenceRow;
  form: RecordForm;
}

export function useRecordEvidence() {
  const client = useApiClient();
  return useCommand<RecordInput>((input, attempt) =>
    client.command('recordMaturityEvidence', {
      path: { id: input.assessmentId },
      body: recordBody(input.evidence.pillarCode, input.evidence.criterionCode, input.form) as never,
      ifMatchVersion: input.evidence.version,
      attempt,
    }),
  );
}

export interface ReviewInput {
  evidence: EvidenceRow;
  decision: 'ACCEPTED' | 'REJECTED';
  note: string;
}

export function useReviewEvidence() {
  const client = useApiClient();
  return useCommand<ReviewInput>((input, attempt) =>
    client.command('reviewMaturityEvidence', {
      path: { id: input.evidence.id },
      body: { decision: input.decision, note: input.note.trim() } as never,
      ifMatchVersion: input.evidence.version,
      attempt,
    }),
  );
}

export interface DecideInput extends VersionedInput {
  decision: 'approve' | 'return' | 'reject';
  reason: string;
}

export function useDecideAssessment() {
  const client = useApiClient();
  return useCommand<DecideInput>((input, attempt) =>
    client.command('post_maturity_assessments_id_publish', {
      path: { id: input.id },
      body: { decision: input.decision, reason: input.reason.trim(), evidence_ids: [] } as never,
      ifMatchVersion: input.version,
      attempt,
    }),
  );
}

export function useCreateMilestone() {
  const client = useApiClient();
  return useCommand<MilestoneForm>((form, attempt) => client.command('createMaturityMilestone', { body: milestoneBody(form) as never, attempt }));
}
