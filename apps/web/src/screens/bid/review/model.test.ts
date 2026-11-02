import { ApiError } from '@machvon/api-client';
import { describe, expect, it } from 'vitest';
import { RECORD, reviewEntry, reviewable, scored } from './test-support';
import {
  MAX_REVIEW_REASON,
  MIN_REVIEW_REASON,
  canReview,
  comparePath,
  describeProblem,
  draftOf,
  isDecided,
  isReviewable,
  reviewBody,
  reviewPath,
  standingStatus,
  toRecorded,
  toReview,
  toReviewedFinding,
  toReviewedList,
  validateDraft,
  withDraft,
  withoutDraft,
} from './model';
import type { Draft } from './model';
import { run } from '../analysis/test-support';
import { toRun } from '../analysis/model';

const problem = (code: string, status = 422): ApiError => new ApiError({ status, code, correlationId: 'c', extensions: {} });
const draft = (overrides: Partial<Draft> = {}): Draft => ({ status: 'SUPPORTED', score: '', reason: 'x'.repeat(MIN_REVIEW_REASON), ...overrides });

describe('the review of the findings of an analysis: model (ST-BID-010)', () => {
  describe('who may review', () => {
    it('offers the review to whoever holds the right to evaluate and is not in a read-only session, and while the permissions are not known', () => {
      expect(canReview(['bid.evaluate'], 'FULL')).toBe(true);
      expect(canReview(['bid.evaluate'], undefined)).toBe(true);
      expect(canReview(undefined, 'FULL')).toBe(true);
      expect(canReview(['bid.evaluate'], 'READ_ONLY')).toBe(false);
      expect(canReview(['bid.read'], 'FULL')).toBe(false);
    });

    it('lets the experts decide on a run that waits for them or has all its findings decided, and on no other', () => {
      expect(isReviewable(undefined)).toBe(false);
      for (const status of ['AWAITING_REVIEW', 'COMPLETED']) expect(isReviewable(toRun(run(1, { status })))).toBe(true);
      for (const status of ['QUEUED', 'RUNNING', 'FAILED', 'CANCELLED', 'REJECTED_BY_POLICY']) expect(isReviewable(toRun(run(1, { status })))).toBe(false);
    });
  });

  describe('reading a finding with what a person decided', () => {
    it('reads the decision apart from what the model said, and the history of the review', () => {
      const finding = toReviewedFinding(scored(1, { status: 'CONTRADICTED' }));
      expect(finding).toMatchObject({ status: 'CONTRADICTED', finalStatus: 'SUPPORTED', finalScore: '4.00', reviewCount: 1, version: 2 });
      expect(finding?.reviews).toHaveLength(1);
      expect(finding?.reviews[0]).toMatchObject({ reviewerName: 'Chuyên gia Lê Văn Hai', fromStatus: 'SUPPORTED', toStatus: 'SUPPORTED', scoreBefore: null, scoreAfter: '4.00', decision: 'ACCEPTED_WITH_CHANGE', aiDecisionRecordId: RECORD });
      expect(finding && standingStatus(finding)).toBe('SUPPORTED');
      expect(finding && isDecided(finding)).toBe(true);
    });

    it('stands for what the model said while nobody decided, and says it is not decided', () => {
      const finding = toReviewedFinding(reviewable(1, { status: 'CONTRADICTED' }));
      expect(finding && standingStatus(finding)).toBe('CONTRADICTED');
      expect(finding && isDecided(finding)).toBe(false);
      expect(finding).toMatchObject({ finalStatus: null, finalScore: null, reviewedAt: null, reviewCount: 0, version: 1, reviews: [] });
    });

    it('does not take a finding for one when the server did not say its version: a review without the version it names cannot be sent', () => {
      expect(toReviewedFinding({ ...reviewable(1), version: undefined })).toBeUndefined();
      expect(toReviewedFinding({ id: 'x' })).toBeUndefined();
      expect(toReviewedFinding(null)).toBeUndefined();
    });

    it('reads a decision only when it says who, from what to what, what and why, and leaves out the ones that do not', () => {
      expect(toReview(reviewEntry(1, { reviewer: { id: 'r', display_name: null } }))?.reviewerName).toBeNull();
      expect(toReview(reviewEntry(1, { ai_decision_record_id: undefined }))?.aiDecisionRecordId).toBe('');
      for (const broken of [{ decision: 'APPROVED' }, { to_status: 'DONE' }, { from_status: null }, { reason: 1 }, { decided_at: null }, { id: null }, { reviewer: null }]) expect(toReview(reviewEntry(1, broken))).toBeUndefined();
      expect(toReview('nothing')).toBeUndefined();
    });

    it('reads a page of findings with its run and the cursor, skipping what is not a finding', () => {
      const list = toReviewedList({ run: run(1), items: [reviewable(1), { id: 'broken' }, scored(2)], next_cursor: '5' });
      expect(list.findings.map((finding) => finding.criterionId)).toEqual(['C1', 'C2']);
      expect(list.run?.id).toBe(run(1).id);
      expect(list.nextCursor).toBe('5');
      expect(toReviewedList({})).toEqual({ run: undefined, findings: [], nextCursor: undefined });
      expect(toReviewedList(null).findings).toEqual([]);
    });
  });

  describe('the drafts', () => {
    const finding = toReviewedFinding(scored(1)) as NonNullable<ReturnType<typeof toReviewedFinding>>;

    it('starts a finding from the status that stands and keeps what was typed for each finding apart', () => {
      expect(draftOf(finding, {})).toEqual({ status: 'SUPPORTED', score: '', reason: '' });
      const typed = withDraft(withDraft({}, finding.id, { reason: 'abc' }), 'other', { status: 'MISSING' });
      expect(draftOf(finding, typed)).toEqual({ status: 'SUPPORTED', score: '', reason: 'abc' });
      expect(withDraft(typed, finding.id, { score: '2' })[finding.id]).toEqual({ reason: 'abc', score: '2' });
      expect(Object.keys(withoutDraft(typed, finding.id))).toEqual(['other']);
    });
  });

  describe('what is wrong with a review before it is sent (BR-BID-09)', () => {
    it('asks for a reason of at least 20 characters once trimmed, and of at most 4000', () => {
      expect(validateDraft(draft({ reason: 'ngắn' }))).toBe('reasonTooShort');
      expect(validateDraft(draft({ reason: ' '.repeat(10) + 'x'.repeat(MIN_REVIEW_REASON - 1) + ' '.repeat(10) }))).toBe('reasonTooShort');
      expect(validateDraft(draft({ reason: 'x'.repeat(MIN_REVIEW_REASON) }))).toBeUndefined();
      expect(validateDraft(draft({ reason: 'x'.repeat(MAX_REVIEW_REASON) }))).toBeUndefined();
      expect(validateDraft(draft({ reason: 'x'.repeat(MAX_REVIEW_REASON + 1) }))).toBe('reasonTooLong');
    });

    it('takes no score, or a score of a number with two decimals at most', () => {
      for (const score of ['', '  ', '0', '4', '4.5', '4.25', ' 2 ']) expect(validateDraft(draft({ score }))).toBeUndefined();
      for (const score of ['-1', '1.234', 'abc', '1,5', '01', '1e3']) expect(validateDraft(draft({ score }))).toBe('scoreInvalid');
    });

    it('judges the reason before the score', () => {
      expect(validateDraft(draft({ reason: '', score: 'abc' }))).toBe('reasonTooShort');
    });
  });

  describe('the body of the review', () => {
    it('trims the reason and sends a score only when one was typed', () => {
      expect(reviewBody(draft({ status: 'CONTRADICTED', score: ' 2 ', reason: '  Lý do đủ dài để người khác đọc hiểu.  ' }))).toEqual({ to_status: 'CONTRADICTED', reason: 'Lý do đủ dài để người khác đọc hiểu.', score_after: '2' });
      expect(reviewBody(draft({ score: '   ' }))).toEqual({ to_status: 'SUPPORTED', reason: 'x'.repeat(MIN_REVIEW_REASON) });
    });
  });

  describe('the decision that was recorded', () => {
    const answer = { operation_id: 'o', status: 'CONTRADICTED', resource_version: 3, resource_id: 'f', review_id: 'r', decision: 'ACCEPTED_WITH_CHANGE', final_status: 'CONTRADICTED', final_score: '2.00', ai_decision_record_id: RECORD, run_status: 'COMPLETED' };

    it('reads the decision, the record of the decision of the person and the state of the run', () => {
      expect(toRecorded(answer)).toEqual({ findingId: 'f', reviewId: 'r', decision: 'ACCEPTED_WITH_CHANGE', finalStatus: 'CONTRADICTED', finalScore: '2.00', aiDecisionRecordId: RECORD, runStatus: 'COMPLETED', version: 3 });
      expect(toRecorded({ ...answer, final_score: null, run_status: undefined })).toMatchObject({ finalScore: null, runStatus: '' });
    });

    it('reads nothing from an answer that does not say what was decided', () => {
      for (const missing of ['resource_id', 'review_id', 'decision', 'final_status', 'ai_decision_record_id', 'resource_version']) expect(toRecorded({ ...answer, [missing]: undefined })).toBeUndefined();
      expect(toRecorded(undefined)).toBeUndefined();
    });
  });

  describe('the refusals of the server', () => {
    it('words each one the screen knows, and the rest as a general failure', () => {
      const cases: Array<[string, number, string]> = [
        ['REASON_REQUIRED', 422, 'reasonRequired'],
        ['RUN_NOT_COMPLETED', 422, 'runNotCompleted'],
        ['CONFLICT_UNDECLARED', 403, 'undeclared'],
        ['VERSION_CONFLICT', 409, 'conflict'],
        ['VALIDATION_FAILED', 422, 'validation'],
        ['INVALID_REQUEST', 400, 'validation'],
        ['FIELD_NOT_ALLOWED', 400, 'validation'],
        ['RESOURCE_NOT_FOUND', 404, 'notFound'],
        ['SCOPE_DENIED', 403, 'denied'],
        ['ENTITLEMENT_DENIED', 403, 'denied'],
        ['SESSION_EXPIRED', 401, 'session'],
        ['SOMETHING_ELSE', 500, 'general'],
      ];
      for (const [code, status, expected] of cases) expect(describeProblem(problem(code, status))).toBe(expected);
      expect(describeProblem(new Error('down'))).toBe('general');
    });
  });

  describe('the addresses', () => {
    it('carries the run with the proposal and the package it belongs to, and the package with the version of the criteria when there is one', () => {
      expect(reviewPath({ runId: 'r 1', proposalId: 'p', packageId: 'k' })).toBe('/bid/bid-12?run=r%201&proposal=p&package=k');
      expect(comparePath('k')).toBe('/bid/bid-10?package=k');
      expect(comparePath('k', 'v')).toBe('/bid/bid-10?package=k&criteria_version_id=v');
    });
  });
});
