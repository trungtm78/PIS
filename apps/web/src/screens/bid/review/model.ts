import { ApiError } from '@machvon/api-client';
import { FINDING_STATUSES, FINDINGS_PERMISSION, holds, toFinding, toRun } from '../analysis/model';
import type { Finding, FindingStatus, Run } from '../analysis/model';

export { FINDING_STATUSES, FINDINGS_PERMISSION, holds };
export type { FindingStatus };

/** What an expert did with what the model said (BR-BID-09): the record of the decision of a person about an answer of the AI. */
export const REVIEW_DECISIONS = ['ACCEPTED', 'ACCEPTED_WITH_CHANGE', 'REJECTED'] as const;
export type ReviewDecision = (typeof REVIEW_DECISIONS)[number];

/** The reason of a change is one a colleague can read: at least this many characters once trimmed; the server holds the same limits (422 REASON_REQUIRED). */
export const MIN_REVIEW_REASON = 20;
export const MAX_REVIEW_REASON = 4000;
/** A score is from 0 with at most two decimals; whether it is within the scale of the criterion is the server's (422). */
const SCORE = /^(0|[1-9][0-9]{0,4})(\.[0-9]{1,2})?$/;
const RUN_REVIEWABLE: readonly string[] = ['AWAITING_REVIEW', 'COMPLETED'];

type Raw = Record<string, unknown>;
const asRecord = (value: unknown): Raw | undefined => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Raw) : undefined);
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const nullableText = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const whole = (value: unknown): number | undefined => (typeof value === 'number' && Number.isInteger(value) ? value : undefined);
const oneOf = <T extends string>(list: readonly T[], value: unknown): T | undefined => list.find((candidate) => candidate === value);

/** Whether the caller is offered the review: the right is held and the session is not read-only. */
export const canReview = (permissions: readonly string[] | undefined, mode: 'FULL' | 'READ_ONLY' | undefined): boolean => mode !== 'READ_ONLY' && holds(permissions, FINDINGS_PERMISSION);

/** The experts decide on a run that waits for them or has all its findings decided, and on no other (422 RUN_NOT_COMPLETED). */
export const isReviewable = (run: Run | undefined): boolean => run !== undefined && RUN_REVIEWABLE.includes(run.status);

// ---- the findings with what a person decided ---------------------------------------------------------------------------------------------

/** One decision of an expert about a finding. It points at the finding and never changes it. */
export interface Review {
  id: string;
  reviewerName: string | null;
  reviewerId: string;
  fromStatus: FindingStatus;
  toStatus: FindingStatus;
  scoreBefore: string | null;
  scoreAfter: string | null;
  reason: string;
  decision: ReviewDecision;
  aiDecisionRecordId: string;
  decidedAt: string;
}

/** A finding as BID-12 reads it: what the model said (`status`) apart from what a person decided (`finalStatus`, `finalScore`, `reviews`). */
export interface ReviewedFinding extends Finding {
  finalScore: string | null;
  reviewedAt: string | null;
  reviewCount: number;
  /** What a review names in If-Match. */
  version: number;
  reviews: Review[];
}

export function toReview(raw: unknown): Review | undefined {
  const row = asRecord(raw);
  const reviewer = asRecord(row?.reviewer);
  const id = text(row?.id);
  const reviewerId = text(reviewer?.id);
  const fromStatus = oneOf(FINDING_STATUSES, row?.from_status);
  const toStatus = oneOf(FINDING_STATUSES, row?.to_status);
  const decision = oneOf(REVIEW_DECISIONS, row?.decision);
  const reason = text(row?.reason);
  const decidedAt = text(row?.decided_at);
  if (row === undefined || id === undefined || reviewerId === undefined || fromStatus === undefined || toStatus === undefined || decision === undefined || reason === undefined || decidedAt === undefined) return undefined;
  return {
    id,
    reviewerName: nullableText(reviewer?.display_name),
    reviewerId,
    fromStatus,
    toStatus,
    scoreBefore: nullableText(row.score_before),
    scoreAfter: nullableText(row.score_after),
    reason,
    decision,
    aiDecisionRecordId: text(row.ai_decision_record_id) ?? '',
    decidedAt,
  };
}

export function toReviewedFinding(raw: unknown): ReviewedFinding | undefined {
  const row = asRecord(raw);
  const base = toFinding(raw);
  const version = whole(row?.version);
  if (row === undefined || base === undefined || version === undefined) return undefined;
  return {
    ...base,
    finalScore: nullableText(row.final_score),
    reviewedAt: nullableText(row.reviewed_at),
    reviewCount: whole(row.review_count) ?? 0,
    version,
    reviews: Array.isArray(row.reviews) ? row.reviews.flatMap((item) => toReview(item) ?? []) : [],
  };
}

export interface ReviewedList {
  run: Run | undefined;
  findings: ReviewedFinding[];
  nextCursor: string | undefined;
}

export function toReviewedList(raw: unknown): ReviewedList {
  const body = asRecord(raw);
  return { run: toRun(body?.run), findings: Array.isArray(body?.items) ? body.items.flatMap((item) => toReviewedFinding(item) ?? []) : [], nextCursor: text(body?.next_cursor) };
}

/** What stands for a finding: the status of the latest decision of a person, or what the model said while nobody decided. */
export const standingStatus = (finding: ReviewedFinding): FindingStatus => finding.finalStatus ?? finding.status;

/** Whether a person decided about the finding: only then does a status of it count as a decision. */
export const isDecided = (finding: ReviewedFinding): boolean => finding.finalStatus !== null;

// ---- the drafts --------------------------------------------------------------------------------------------------------------------------

export interface Draft {
  status: FindingStatus;
  score: string;
  reason: string;
}

/** What is typed for each finding, by its id; a finding with nothing typed starts from the status that stands. */
export type Drafts = Readonly<Record<string, Partial<Draft>>>;

export const draftOf = (finding: ReviewedFinding, drafts: Drafts): Draft => ({ status: standingStatus(finding), score: '', reason: '', ...drafts[finding.id] });

export const withDraft = (drafts: Drafts, id: string, change: Partial<Draft>): Drafts => ({ ...drafts, [id]: { ...drafts[id], ...change } });

export const withoutDraft = (drafts: Drafts, id: string): Drafts => Object.fromEntries(Object.entries(drafts).filter(([key]) => key !== id));

export type DraftProblem = 'reasonTooShort' | 'reasonTooLong' | 'scoreInvalid';

/** What is wrong with a review before it is sent: the reason is mandatory and at least 20 characters once trimmed (BR-BID-09). */
export function validateDraft(draft: Draft): DraftProblem | undefined {
  const length = draft.reason.trim().length;
  if (length < MIN_REVIEW_REASON) return 'reasonTooShort';
  if (length > MAX_REVIEW_REASON) return 'reasonTooLong';
  const score = draft.score.trim();
  return score === '' || SCORE.test(score) ? undefined : 'scoreInvalid';
}

export interface ReviewBody {
  to_status: FindingStatus;
  reason: string;
  score_after?: string;
}

/** The body of the review: the reason as it was trimmed, and a score only when one was typed. */
export function reviewBody(draft: Draft): ReviewBody {
  const score = draft.score.trim();
  return { to_status: draft.status, reason: draft.reason.trim(), ...(score === '' ? {} : { score_after: score }) };
}

/** The decision that was recorded, as the server answers it. */
export interface Recorded {
  findingId: string;
  reviewId: string;
  decision: ReviewDecision;
  finalStatus: FindingStatus;
  finalScore: string | null;
  aiDecisionRecordId: string;
  runStatus: string;
  version: number;
}

export function toRecorded(raw: unknown): Recorded | undefined {
  const row = asRecord(raw);
  const findingId = text(row?.resource_id);
  const reviewId = text(row?.review_id);
  const decision = oneOf(REVIEW_DECISIONS, row?.decision);
  const finalStatus = oneOf(FINDING_STATUSES, row?.final_status);
  const aiDecisionRecordId = text(row?.ai_decision_record_id);
  const version = whole(row?.resource_version);
  if (row === undefined || findingId === undefined || reviewId === undefined || decision === undefined || finalStatus === undefined || aiDecisionRecordId === undefined || version === undefined) return undefined;
  return { findingId, reviewId, decision, finalStatus, finalScore: nullableText(row.final_score), aiDecisionRecordId, runStatus: text(row.run_status) ?? '', version };
}

// ---- refusals ----------------------------------------------------------------------------------------------------------------------------

export type ReviewProblem = 'reasonRequired' | 'runNotCompleted' | 'undeclared' | 'conflict' | 'validation' | 'notFound' | 'denied' | 'session' | 'general';

/** The refusal of the server as the screen words it. */
export function describeProblem(error: unknown): ReviewProblem {
  if (!(error instanceof ApiError)) return 'general';
  switch (error.code) {
    case 'REASON_REQUIRED':
      return 'reasonRequired';
    case 'RUN_NOT_COMPLETED':
      return 'runNotCompleted';
    case 'CONFLICT_UNDECLARED':
      return 'undeclared';
    case 'VERSION_CONFLICT':
      return 'conflict';
    case 'VALIDATION_FAILED':
    case 'INVALID_REQUEST':
    case 'FIELD_NOT_ALLOWED':
      return 'validation';
    case 'RESOURCE_NOT_FOUND':
      return 'notFound';
    case 'SCOPE_DENIED':
    case 'ENTITLEMENT_DENIED':
      return 'denied';
    case 'SESSION_EXPIRED':
      return 'session';
    default:
      return 'general';
  }
}

// ---- the filters -------------------------------------------------------------------------------------------------------------------------

export { findingQuery, findingStatusFromParam, hasFindingFilter, missingFromParam, NO_FINDING_FILTER, readFailure } from '../analysis/model';
export type { FindingFilter } from '../analysis/model';

// ---- the addresses -----------------------------------------------------------------------------------------------------------------------

/** The review of a run: it carries the proposal and the package it belongs to, so that the way back to the comparison and to the proposal needs nothing else. */
export const reviewPath = (ids: { runId: string; proposalId: string; packageId: string }): string =>
  `/bid/bid-12?run=${encodeURIComponent(ids.runId)}&proposal=${encodeURIComponent(ids.proposalId)}&package=${encodeURIComponent(ids.packageId)}`;
export const comparePath = (packageId: string, criteriaVersionId?: string): string =>
  `/bid/bid-10?package=${encodeURIComponent(packageId)}${criteriaVersionId === undefined ? '' : `&criteria_version_id=${encodeURIComponent(criteriaVersionId)}`}`;
