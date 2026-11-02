import { finding, ME, runId } from '../analysis/test-support';

export { EVALUATOR, NOBODY, client, criteriaId, documentEvidence, evidenceId, failedRun, findingId, mount, packageId, problem, proposalId, routeOf, run, runId, versionId, world } from '../analysis/test-support';
export type { Harness, World } from '../analysis/test-support';

export const RECORD = '00000000-0000-4000-8000-0000ec0d0001';
export const REVIEWER = ME;

/** One decision of an expert as the server writes it: what stood, what was set, and the record of the decision of a person about the AI output. */
export const reviewEntry = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: `00000000-0000-4000-8000-0000000b${String(n).padStart(4, '0')}`,
  reviewer: { id: REVIEWER, display_name: 'Chuyên gia Lê Văn Hai' },
  from_status: 'SUPPORTED',
  to_status: 'SUPPORTED',
  score_before: null,
  score_after: '4.00',
  reason: 'Hợp đồng tương tự đã được nghiệm thu, đủ điều kiện kinh nghiệm.',
  decision: 'ACCEPTED_WITH_CHANGE',
  ai_decision_record_id: RECORD,
  checked_evidence_ids: [],
  decided_at: '2026-12-06T04:00:00.000Z',
  ...overrides,
});

/** A finding of the run as the list of the findings returns it: what the model said, and what a person decided apart from it. */
export const reviewable = (n: number, overrides: Record<string, unknown> = {}) =>
  finding(n, { final_score: null, review_count: 0, version: 1, reviews: [], run_id: runId(1), ...overrides });

/** A finding with one decision of an expert that scored it 4 out of 5: the review in the acceptance criterion changes it from here. */
export const scored = (n: number, overrides: Record<string, unknown> = {}) =>
  reviewable(n, { final_status: 'SUPPORTED', final_score: '4.00', reviewed_at: '2026-12-06T04:00:00.000Z', review_count: 1, version: 2, reviews: [reviewEntry(1)], ...overrides });
