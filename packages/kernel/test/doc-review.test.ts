import { DomainError } from '../src/errors';
import { BUSINESS_TYPES, DOCUMENT_REVIEW_BUSINESS_TYPE, assertWithdrawable, planSubmission, reviewBoardOf, reviewEndOf, reviewNoteOf, validateDefinition } from '../src/index';
import type { BoardTask, SubmissionFacts } from '../src/index';

const refusal = (run: () => unknown): DomainError => {
  try {
    run();
  } catch (error) {
    if (error instanceof DomainError) return error;
    throw error;
  }
  throw new Error('expected a DomainError');
};

const facts = (over: Partial<SubmissionFacts> = {}): SubmissionFacts => ({
  documentActive: true,
  version: { id: 'v2', versionNo: 2, status: 'DRAFT', extractionStatus: 'EXTRACTED' },
  latest: null,
  ...over,
});

describe('the review is a registered business type of the approval workflow', () => {
  it('registers document.review with the three commands of its ends', () => {
    const spec = BUSINESS_TYPES.find((type) => type.code === DOCUMENT_REVIEW_BUSINESS_TYPE);
    expect(spec).toEqual({ code: 'document.review', documentType: 'DOCUMENT_REVIEW', commands: { APPROVED: 'approveDocumentReview', RETURNED: 'requestDocumentSupplement', REJECTED: 'rejectDocumentReview' } });
  });

  it('accepts a two stage definition with parallel reviewers and the registered commands', () => {
    const member = (n: number): string => `0000000${n}-0000-4000-8000-000000000000`;
    const definition = {
      steps: [
        { id: 'technical', name: 'Technical review', assignee_rule: { type: 'SPECIFIC', membership_ids: [member(1), member(2), member(3)] }, min_approvals: 2, sla_working_hours: 24, on_timeout: 'REMIND' },
        { id: 'legal', name: 'Legal review', assignee_rule: { type: 'SPECIFIC', membership_ids: [member(4)] }, min_approvals: 1, sla_working_hours: 16, on_timeout: 'REMIND', allow_return_to: 'technical' },
      ],
      terminal: { approved: 'approveDocumentReview', returned: 'requestDocumentSupplement', rejected: 'rejectDocumentReview' },
    };
    expect(validateDefinition(definition, DOCUMENT_REVIEW_BUSINESS_TYPE)).toEqual([]);
    expect(validateDefinition({ ...definition, terminal: { approved: 'acceptReport', returned: 'requestDocumentSupplement', rejected: 'rejectDocumentReview' } }, DOCUMENT_REVIEW_BUSINESS_TYPE).map((defect) => defect.code)).toEqual(['COMMAND_NOT_REGISTERED']);
  });
});

describe('what each end of the workflow means', () => {
  it('approval locks, a return asks for a supplement, a rejection closes the round', () => {
    expect(reviewEndOf('APPROVED')).toEqual({ reviewStatus: 'APPROVED', versionStatus: 'APPROVED', eventKind: 'APPROVED' });
    expect(reviewEndOf('RETURNED')).toEqual({ reviewStatus: 'SUPPLEMENT_REQUESTED', versionStatus: 'SUPPLEMENT_REQUESTED', eventKind: 'SUPPLEMENT_REQUESTED' });
    expect(reviewEndOf('REJECTED')).toEqual({ reviewStatus: 'REJECTED', versionStatus: 'REJECTED', eventKind: 'REJECTED' });
  });
});

describe('sending a version to review', () => {
  it('is round one for a document never reviewed', () => {
    expect(planSubmission(facts())).toEqual({ round: 1, kind: 'SUBMITTED', previousReviewId: null });
  });

  it('is the next round, as a resubmission, after a supplement request, and needs a newer version', () => {
    const latest = { id: 'r1', round: 1, status: 'SUPPLEMENT_REQUESTED' as const, versionNo: 1 };
    expect(planSubmission(facts({ latest }))).toEqual({ round: 2, kind: 'RESUBMITTED', previousReviewId: 'r1' });
    const same = refusal(() => planSubmission(facts({ latest: { ...latest, versionNo: 2 } })));
    expect([same.code, same.status, same.extensions]).toEqual(['DOC_REVIEW_VERSION_NOT_NEWER', 422, { reviewed_version: 2, version: 2 }]);
  });

  it('is a fresh submission after a rejection, again with a newer version', () => {
    const latest = { id: 'r1', round: 3, status: 'REJECTED' as const, versionNo: 1 };
    expect(planSubmission(facts({ latest }))).toEqual({ round: 4, kind: 'SUBMITTED', previousReviewId: 'r1' });
    expect(refusal(() => planSubmission(facts({ latest: { ...latest, versionNo: 5 } }))).code).toBe('DOC_REVIEW_VERSION_NOT_NEWER');
  });

  it('lets a withdrawn version go again, and a later version after an approval', () => {
    expect(planSubmission(facts({ latest: { id: 'r1', round: 1, status: 'WITHDRAWN', versionNo: 2 } })).round).toBe(2);
    expect(planSubmission(facts({ latest: { id: 'r1', round: 1, status: 'APPROVED', versionNo: 1 } })).round).toBe(2);
  });

  it('refuses an archived document, a version that is not a draft, an open review and a version still being read', () => {
    expect(refusal(() => planSubmission(facts({ documentActive: false }))).code).toBe('DOC_ARCHIVED');
    expect(refusal(() => planSubmission(facts({ version: { id: 'v', versionNo: 1, status: 'APPROVED', extractionStatus: 'EXTRACTED' } }))).code).toBe('DOC_VERSION_STATE_INVALID');
    const open = refusal(() => planSubmission(facts({ latest: { id: 'r9', round: 1, status: 'IN_REVIEW', versionNo: 1 } })));
    expect([open.code, open.status, open.extensions]).toEqual(['DOC_REVIEW_ALREADY_OPEN', 409, { review_id: 'r9' }]);
    expect(refusal(() => planSubmission(facts({ version: { id: 'v', versionNo: 1, status: 'DRAFT', extractionStatus: 'PENDING' } }))).code).toBe('DOC_EXTRACTION_PENDING');
  });

  it('accepts a version whose text could not be read, so a scan with no OCR engine can still be reviewed by eye', () => {
    expect(planSubmission(facts({ version: { id: 'v', versionNo: 1, status: 'DRAFT', extractionStatus: 'NO_TEXT' } })).round).toBe(1);
  });
});

describe('notes and withdrawals', () => {
  it('keeps a note short and plain, or none', () => {
    expect(reviewNoteOf(undefined)).toBeNull();
    expect(reviewNoteOf('')).toBeNull();
    expect(reviewNoteOf('  gửi thẩm định  ')).toBe('gửi thẩm định');
    expect(refusal(() => reviewNoteOf(7)).detail).toBe('note');
    expect(refusal(() => reviewNoteOf('x'.repeat(2001))).detail).toBe('note');
    expect(refusal(() => reviewNoteOf('a\u0007b')).detail).toBe('note');
    expect(refusal(() => reviewNoteOf('   ')).detail).toBe('note');
  });

  it('withdraws an open review, by the one who sent it', () => {
    expect(() => assertWithdrawable({ status: 'IN_REVIEW', submittedBy: 'm1' }, 'm1')).not.toThrow();
    expect(refusal(() => assertWithdrawable({ status: 'APPROVED', submittedBy: 'm1' }, 'm1')).code).toBe('DOC_REVIEW_NOT_OPEN');
    expect(refusal(() => assertWithdrawable({ status: 'IN_REVIEW', submittedBy: 'm1' }, 'm2')).code).toBe('SCOPE_DENIED');
  });
});

describe('the board', () => {
  const steps = [
    { id: 'technical', name: 'Technical', minApprovals: 2 },
    { id: 'legal', name: 'Legal', minApprovals: 1 },
    { id: 'leader', name: 'Leader', minApprovals: 1 },
  ];
  const task = (id: string, stepIndex: number, over: Partial<BoardTask> = {}): BoardTask => ({ id, stepIndex, assigneeId: `m-${id}`, status: 'Pending', decision: null, reason: null, decidedAt: null, dueAt: '2026-11-10T00:00:00Z', ...over });
  const approved = (id: string, stepIndex: number): BoardTask => task(id, stepIndex, { status: 'Decided', decision: 'approve', decidedAt: '2026-11-09T00:00:00Z' });

  it('shows a running review at its current stage with parallel reviewers side by side', () => {
    const board = reviewBoardOf(steps, { status: 'Running', outcome: null, currentStep: 0 }, [approved('a', 0), task('b', 0), task('c', 0)]);
    expect(board.map((stage) => stage.state)).toEqual(['CURRENT', 'WAITING', 'WAITING']);
    expect(board[0]?.approvals).toBe(1);
    expect(board[0]?.reviewers.map((reviewer) => reviewer.state)).toEqual(['APPROVED', 'PENDING', 'PENDING']);
  });

  it('marks the earlier stages done once the review moved on and the reviewers not needed any more', () => {
    const board = reviewBoardOf(steps, { status: 'Running', outcome: null, currentStep: 1 }, [approved('a', 0), approved('b', 0), task('c', 0, { status: 'Cancelled' }), task('d', 1)]);
    expect(board.map((stage) => stage.state)).toEqual(['DONE', 'CURRENT', 'WAITING']);
    expect(board[0]?.reviewers.map((reviewer) => reviewer.state)).toEqual(['APPROVED', 'APPROVED', 'NOT_NEEDED']);
  });

  it('shows an approved review as done everywhere', () => {
    const board = reviewBoardOf(steps, { status: 'Completed', outcome: 'APPROVED', currentStep: 2 }, [approved('a', 0), approved('b', 0), approved('c', 1), approved('d', 2)]);
    expect(board.every((stage) => stage.state === 'DONE')).toBe(true);
  });

  it('shows where a supplement was requested and leaves the stages after it unopened', () => {
    const returned = task('x', 1, { status: 'Decided', decision: 'return', reason: 'Thiếu căn cứ pháp lý', decidedAt: '2026-11-09T01:00:00Z' });
    const board = reviewBoardOf(steps, { status: 'Completed', outcome: 'RETURNED', currentStep: 1 }, [approved('a', 0), approved('b', 0), returned]);
    expect(board.map((stage) => stage.state)).toEqual(['DONE', 'SUPPLEMENT_REQUESTED', 'SKIPPED']);
    expect(board[1]?.reviewers[0]).toMatchObject({ state: 'SUPPLEMENT_REQUESTED', reason: 'Thiếu căn cứ pháp lý' });
  });

  it('shows a rejection at the stage that rejected', () => {
    const rejected = task('x', 0, { status: 'Decided', decision: 'reject', reason: 'Không đạt yêu cầu', decidedAt: '2026-11-09T01:00:00Z' });
    expect(reviewBoardOf(steps, { status: 'Completed', outcome: 'REJECTED', currentStep: 0 }, [rejected]).map((stage) => stage.state)).toEqual(['REJECTED', 'SKIPPED', 'SKIPPED']);
  });

  it('shows every stage waiting before any instance exists', () => {
    expect(reviewBoardOf(steps, null, []).map((stage) => stage.state)).toEqual(['WAITING', 'WAITING', 'WAITING']);
  });

  it('names reassigned and expired reviewers', () => {
    const board = reviewBoardOf(steps, { status: 'Running', outcome: null, currentStep: 0 }, [task('a', 0, { status: 'Reassigned' }), task('b', 0, { status: 'Expired' }), task('c', 0)]);
    expect(board[0]?.reviewers.map((reviewer) => reviewer.state)).toEqual(['REASSIGNED', 'EXPIRED', 'PENDING']);
  });
});
