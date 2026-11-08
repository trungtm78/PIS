import { hasControlCharExceptWhitespace } from './control-chars.ts';
import { DomainError } from './errors.ts';
import type { VersionStatus } from './doc-repository.ts';

/**
 * The review of a project document (DOC-2, PD.01): a version is sent to review, goes through the stages the tenant published for the business type `document.review` (the ADM approval workflow: stages are steps, the
 * reviewers of a stage are its tasks and decide in parallel, a stage closes when its number of approvals is reached), and ends approved (the version is locked), sent back for a supplement, or rejected. A
 * supplement is a new version, and sending it is the next round of the same document. Pure rules; the engine is ADM's.
 */

export const DOCUMENT_REVIEW_BUSINESS_TYPE = 'document.review';
export const DOCUMENT_REVIEW_RESOURCE = 'document_review';

export const REVIEW_STATUSES = ['IN_REVIEW', 'APPROVED', 'SUPPLEMENT_REQUESTED', 'REJECTED', 'WITHDRAWN'] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

export const REVIEW_EVENT_KINDS = ['SUBMITTED', 'RESUBMITTED', 'WITHDRAWN', 'APPROVED', 'SUPPLEMENT_REQUESTED', 'REJECTED', 'VERSION_LOCKED'] as const;
export type ReviewEventKind = (typeof REVIEW_EVENT_KINDS)[number];

export const MAX_REVIEW_NOTE = 2000;

export type WorkflowEnd = 'APPROVED' | 'RETURNED' | 'REJECTED';

export interface ReviewEnd {
  reviewStatus: Exclude<ReviewStatus, 'IN_REVIEW' | 'WITHDRAWN'>;
  versionStatus: Extract<VersionStatus, 'APPROVED' | 'SUPPLEMENT_REQUESTED' | 'REJECTED'>;
  eventKind: Extract<ReviewEventKind, 'APPROVED' | 'SUPPLEMENT_REQUESTED' | 'REJECTED'>;
}

/** What each end of the workflow means for the review and for the version it was about. `RETURNED` is the supplement request: the engine sends the record back to its initiator. */
export function reviewEndOf(end: WorkflowEnd): ReviewEnd {
  switch (end) {
    case 'APPROVED':
      return { reviewStatus: 'APPROVED', versionStatus: 'APPROVED', eventKind: 'APPROVED' };
    case 'RETURNED':
      return { reviewStatus: 'SUPPLEMENT_REQUESTED', versionStatus: 'SUPPLEMENT_REQUESTED', eventKind: 'SUPPLEMENT_REQUESTED' };
    case 'REJECTED':
      return { reviewStatus: 'REJECTED', versionStatus: 'REJECTED', eventKind: 'REJECTED' };
  }
}

export interface SubmissionFacts {
  documentActive: boolean;
  version: { id: string; versionNo: number; status: VersionStatus; extractionStatus: string };
  /** The newest review of the document, if any. */
  latest: { id: string; round: number; status: ReviewStatus; versionNo: number } | null;
}

export interface SubmissionPlan {
  round: number;
  kind: Extract<ReviewEventKind, 'SUBMITTED' | 'RESUBMITTED'>;
  previousReviewId: string | null;
}

/**
 * Whether a version may be sent to review, and as which round. The document is not archived (409 DOC_ARCHIVED); the version is a draft (409 DOC_VERSION_STATE_INVALID); the document has no review open (409
 * DOC_REVIEW_ALREADY_OPEN); the text of the version has been read, or read and found empty (a version still being read waits: 409 DOC_EXTRACTION_PENDING); and, after a review that sent the document back or
 * rejected it, the version is a newer one than the one reviewed (422 DOC_REVIEW_VERSION_NOT_NEWER): a supplement is a new version, not the same file again.
 */
export function planSubmission(facts: SubmissionFacts): SubmissionPlan {
  if (!facts.documentActive) throw new DomainError('DOC_ARCHIVED', 409, 'document_id');
  if (facts.version.status !== 'DRAFT') throw new DomainError('DOC_VERSION_STATE_INVALID', 409, 'version_id', { extensions: { from: facts.version.status, to: 'IN_REVIEW' } });
  if (facts.latest?.status === 'IN_REVIEW') throw new DomainError('DOC_REVIEW_ALREADY_OPEN', 409, 'document_id', { extensions: { review_id: facts.latest.id } });
  if (facts.version.extractionStatus === 'PENDING') throw new DomainError('DOC_EXTRACTION_PENDING', 409, 'version_id');
  const latest = facts.latest;
  if (latest !== null && (latest.status === 'SUPPLEMENT_REQUESTED' || latest.status === 'REJECTED') && facts.version.versionNo <= latest.versionNo) {
    throw new DomainError('DOC_REVIEW_VERSION_NOT_NEWER', 422, 'version_id', { extensions: { reviewed_version: latest.versionNo, version: facts.version.versionNo } });
  }
  return { round: (latest?.round ?? 0) + 1, kind: latest?.status === 'SUPPLEMENT_REQUESTED' ? 'RESUBMITTED' : 'SUBMITTED', previousReviewId: latest?.id ?? null };
}

/** The note of a submission or a withdrawal: short plain text, or none. */
export function reviewNoteOf(value: unknown, field = 'note'): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new DomainError('VALIDATION_FAILED', 422, field);
  const text = value.normalize('NFC').trim();
  if (text.length === 0 || text.length > MAX_REVIEW_NOTE || hasControlCharExceptWhitespace(text)) throw new DomainError('VALIDATION_FAILED', 422, field);
  return text;
}

/** A review is withdrawn only while it is open, and by the person who sent it. */
export function assertWithdrawable(review: { status: ReviewStatus; submittedBy: string }, actor: string): void {
  if (review.status !== 'IN_REVIEW') throw new DomainError('DOC_REVIEW_NOT_OPEN', 409, 'status');
  if (review.submittedBy !== actor) throw new DomainError('SCOPE_DENIED', 403, 'submitted_by');
}

// ---- the board: stages and reviewers ---------------------------------------------------------------------------------------------------------------

export type StageState = 'DONE' | 'CURRENT' | 'WAITING' | 'SUPPLEMENT_REQUESTED' | 'REJECTED' | 'SKIPPED';
export type ReviewerState = 'PENDING' | 'APPROVED' | 'SUPPLEMENT_REQUESTED' | 'REJECTED' | 'NOT_NEEDED' | 'REASSIGNED' | 'EXPIRED';

export interface BoardStep {
  id: string;
  name: string;
  minApprovals: number;
}

export interface BoardTask {
  id: string;
  stepIndex: number;
  assigneeId: string;
  assigneeName?: string | null;
  /** The version of the task row, which a decision names (If-Match). */
  taskVersion?: number | null;
  status: 'Pending' | 'Decided' | 'Reassigned' | 'Cancelled' | 'Expired';
  decision: 'approve' | 'return' | 'reject' | null;
  reason: string | null;
  decidedAt: string | null;
  dueAt: string;
}

export interface BoardInstance {
  status: 'Running' | 'Completed' | 'Cancelled' | 'Failed';
  outcome: string | null;
  currentStep: number;
}

export interface BoardStage {
  index: number;
  id: string;
  name: string;
  minApprovals: number;
  state: StageState;
  approvals: number;
  reviewers: Array<{ taskId: string; assigneeId: string; assigneeName: string | null; taskVersion: number | null; state: ReviewerState; decision: BoardTask['decision']; reason: string | null; decidedAt: string | null; dueAt: string }>;
}

const reviewerStateOf = (task: BoardTask): ReviewerState => {
  if (task.status === 'Pending') return 'PENDING';
  if (task.status === 'Decided') return task.decision === 'approve' ? 'APPROVED' : task.decision === 'return' ? 'SUPPLEMENT_REQUESTED' : 'REJECTED';
  if (task.status === 'Reassigned') return 'REASSIGNED';
  if (task.status === 'Expired') return 'EXPIRED';
  return 'NOT_NEEDED';
};

/**
 * The board of a review: every stage of the definition the review runs by, with its state and its reviewers (the parallel reviewers of a stage are shown together, with what each decided). A running review has done the
 * stages before the current one, waits at it and has the later ones waiting; a finished one has done every stage before the one that ended it, and that stage shows how it ended (a supplement request or a rejection); the
 * stages after it were never opened.
 */
export function reviewBoardOf(steps: readonly BoardStep[], instance: BoardInstance | null, tasks: readonly BoardTask[]): BoardStage[] {
  const endedAt = instance === null || instance.status === 'Running' ? -1 : Math.max(-1, ...tasks.filter((task) => task.status === 'Decided').map((task) => task.stepIndex));
  return steps.map((step, index): BoardStage => {
    const own = tasks.filter((task) => task.stepIndex === index);
    const reviewers = own.map((task) => ({ taskId: task.id, assigneeId: task.assigneeId, assigneeName: task.assigneeName ?? null, taskVersion: task.taskVersion ?? null, state: reviewerStateOf(task), decision: task.decision, reason: task.reason, decidedAt: task.decidedAt, dueAt: task.dueAt }));
    const approvals = own.filter((task) => task.status === 'Decided' && task.decision === 'approve').length;
    let state: StageState;
    if (instance === null) state = 'WAITING';
    else if (instance.status === 'Running') state = index < instance.currentStep ? 'DONE' : index === instance.currentStep ? 'CURRENT' : 'WAITING';
    else if (instance.status === 'Completed' && instance.outcome === 'APPROVED') state = 'DONE';
    else if (index < endedAt) state = 'DONE';
    else if (index === endedAt) state = instance.outcome === 'RETURNED' ? 'SUPPLEMENT_REQUESTED' : instance.outcome === 'REJECTED' ? 'REJECTED' : 'DONE';
    else state = 'SKIPPED';
    return { index, id: step.id, name: step.name, minApprovals: step.minApprovals, state, approvals, reviewers };
  });
}
