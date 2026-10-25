import { ApiError } from '@machvon/api-client';
import { describe, expect, it } from 'vitest';
import {
  EMPTY_DECIDE,
  EMPTY_SUBMIT,
  canApprove,
  canDecide,
  canSubmit,
  canSubmitFor,
  decideBody,
  describeProblem,
  resultPackages,
  submitBody,
  toResultLine,
  toResultList,
  validateDecide,
  validateSubmit,
} from './model';
import type { ResultLine } from './model';
import { MINUTES, DECISION, ME, SOMEONE, contractorId, pack, result } from './test-support';
import type { TrackedPackage } from '../procurement/model';

const line = (overrides: Record<string, unknown> = {}): ResultLine => toResultLine(result(1, 1, overrides)) as ResultLine;
const problem = (code: string, extensions: Record<string, unknown> = {}) => new ApiError({ status: 422, code, correlationId: 'c', extensions });
const tracked = (status: string): TrackedPackage => ({ id: 'p', code: 'GT-1', title: null, status, version: 1, project: { id: 'x', code: 'X', name: 'X' } });

describe('toResultLine', () => {
  it('reads a result with the package, the winner, the price, the evaluation and the people', () => {
    expect(toResultLine(result(1, 1, { status: 'APPROVED', decision_document_id: DECISION, decided_by: { membership_id: ME, display_name: 'Người duyệt' }, decided_at: '2026-10-21T02:00:00.000Z', comment: 'KQ-01', version: 2 }))).toEqual({
      id: expect.any(String),
      package: { id: expect.any(String), code: 'GT-1', budgetVnd: '18000000000' },
      outcome: 'AWARDED',
      winner: { id: contractorId(1), legalName: 'Công ty nhà thầu 1' },
      awardPriceVnd: '17650000000',
      evaluationMinutes: { documentId: MINUTES, title: 'Biên bản đánh giá' },
      decisionDocumentId: DECISION,
      status: 'APPROVED',
      submittedBy: { membershipId: SOMEONE, displayName: 'Chuyên viên đấu thầu' },
      submittedAt: '2026-10-20T02:00:00.000Z',
      decidedBy: { membershipId: ME, displayName: 'Người duyệt' },
      decidedAt: '2026-10-21T02:00:00.000Z',
      comment: 'KQ-01',
      version: 2,
    });
  });

  it('leaves out what an outcome has none of, and refuses what is not a result', () => {
    expect(line({ outcome: 'CANCELLED', winner: null, award_price_vnd: null, evaluation_minutes: null, submitted_by: null })).toMatchObject({ winner: null, awardPriceVnd: null, evaluationMinutes: null, submittedBy: null });
    expect(toResultLine(result(1, 1, { winner: { legal_name: 'No id' } }))).toMatchObject({ winner: null });
    expect(toResultLine(result(1, 1, { evaluation_minutes: { title: 'No id' } }))).toMatchObject({ evaluationMinutes: null });
    expect(toResultLine(result(1, 1, { submitted_by: { display_name: 'No id' } }))).toMatchObject({ submittedBy: null });
    expect(toResultLine(result(1, 1, { winner: { id: contractorId(1) } }))?.winner).toEqual({ id: contractorId(1), legalName: '' });
    for (const broken of [{ id: undefined }, { package: undefined }, { package: { id: 'a', code: 'b' } }, { outcome: 'WON' }, { status: 'PENDING' }, { version: '1' }, { version: 1.5 }]) {
      expect(toResultLine(result(1, 1, broken))).toBeUndefined();
    }
    expect(toResultLine(null)).toBeUndefined();
    expect(toResultLine([])).toBeUndefined();
  });

  it('reads the items of a list and nothing else', () => {
    expect(toResultList({ items: [result(1, 1), { nope: true }, result(2, 1)] })).toHaveLength(2);
    expect(toResultList({ items: 'x' })).toEqual([]);
    expect(toResultList(null)).toEqual([]);
  });
});

describe('who may do what', () => {
  it('asks for the permission unless the permissions are not known yet, and for a session that can write', () => {
    expect(canSubmit(['bid.result.submit'], 'FULL')).toBe(true);
    expect(canSubmit(undefined, undefined)).toBe(true);
    expect(canSubmit(['bid.read'], 'FULL')).toBe(false);
    expect(canSubmit(['bid.result.submit'], 'READ_ONLY')).toBe(false);
    expect(canApprove(['bid.result.approve'], 'FULL')).toBe(true);
    expect(canApprove(['bid.result.submit'], 'FULL')).toBe(false);
    expect(canApprove(['bid.result.approve'], 'READ_ONLY')).toBe(false);
  });

  it('submits for a package whose plan is in force and that has no result waiting', () => {
    expect(canSubmitFor(tracked('APPROVED'), [])).toBe(true);
    expect(canSubmitFor(tracked('APPROVED'), [line({ status: 'REJECTED' }), line({ status: 'APPROVED' })])).toBe(true);
    expect(canSubmitFor(tracked('APPROVED'), [line({ status: 'SUBMITTED' })])).toBe(false);
    expect(canSubmitFor(tracked('APPROVED'), [line({ status: 'DRAFT' })])).toBe(false);
    for (const status of ['AWARDED', 'IN_REVIEW', 'DRAFT', 'SUPERSEDED', 'CANCELLED']) expect(canSubmitFor(tracked(status), [])).toBe(false);
  });

  it('decides a result that waits, for someone who holds the permission and did not submit it', () => {
    expect(canDecide(line(), ME, ['bid.result.approve'], 'FULL')).toBe(true);
    expect(canDecide(line({ submitted_by: { membership_id: ME, display_name: 'Tôi' } }), ME, ['bid.result.approve'], 'FULL')).toBe(false);
    expect(canDecide(line({ submitted_by: null }), ME, ['bid.result.approve'], 'FULL')).toBe(true);
    expect(canDecide(line({ status: 'APPROVED' }), ME, ['bid.result.approve'], 'FULL')).toBe(false);
    expect(canDecide(line(), ME, ['bid.read'], 'FULL')).toBe(false);
    expect(canDecide(line(), ME, ['bid.result.approve'], 'READ_ONLY')).toBe(false);
  });

  it('keeps the packages the screen is about', () => {
    const all = ['APPROVED', 'AWARDED', 'NO_ACCEPTABLE_BID', 'CANCELLED', 'DRAFT', 'IN_REVIEW', 'SUPERSEDED'].map((status) => ({ ...tracked(status), id: status }));
    expect(resultPackages(all).map((p) => p.id)).toEqual(['APPROVED', 'AWARDED', 'NO_ACCEPTABLE_BID', 'CANCELLED']);
    expect(pack(1).status).toBe('APPROVED');
  });
});

describe('the submission form', () => {
  const awarded = { ...EMPTY_SUBMIT, outcome: 'AWARDED' as const, winnerId: contractorId(1), awardPriceVnd: '17650000000', minutesId: MINUTES };

  it('asks for the outcome and the evaluation, and for an award the winner and the price', () => {
    expect(validateSubmit(EMPTY_SUBMIT)).toEqual({ outcome: 'required', minutesId: 'required' });
    expect(validateSubmit({ ...EMPTY_SUBMIT, outcome: 'AWARDED', minutesId: MINUTES })).toEqual({ winnerId: 'required', awardPriceVnd: 'required' });
    expect(validateSubmit(awarded)).toEqual({});
    for (const price of ['1.5', '-5', 'abc', '0', '000', '1'.repeat(25)]) expect(validateSubmit({ ...awarded, awardPriceVnd: price })).toEqual({ awardPriceVnd: 'price' });
    expect(validateSubmit({ ...awarded, minutesId: 'nope' })).toEqual({ minutesId: 'uuid' });
  });

  it('lets the other outcomes name neither a winner nor a price', () => {
    for (const outcome of ['NO_ACCEPTABLE_BID', 'CANCELLED'] as const) {
      expect(validateSubmit({ ...EMPTY_SUBMIT, outcome, minutesId: MINUTES })).toEqual({});
      expect(validateSubmit({ ...EMPTY_SUBMIT, outcome, minutesId: MINUTES, winnerId: contractorId(1) })).toEqual({ winnerId: 'notAllowed' });
      expect(validateSubmit({ ...EMPTY_SUBMIT, outcome, minutesId: MINUTES, awardPriceVnd: '5' })).toEqual({ awardPriceVnd: 'notAllowed' });
    }
  });

  it('builds the body: the winner and the price only for an award, the evaluation in lower case', () => {
    expect(submitBody('p1', { ...awarded, minutesId: ` ${MINUTES.toUpperCase()} `, awardPriceVnd: ' 17650000000 ' })).toEqual({ package_id: 'p1', outcome: 'AWARDED', evaluation_report_id: MINUTES, winner_contractor_id: contractorId(1), award_price_vnd: '17650000000' });
    expect(submitBody('p1', { ...EMPTY_SUBMIT, outcome: 'CANCELLED', minutesId: MINUTES })).toEqual({ package_id: 'p1', outcome: 'CANCELLED', evaluation_report_id: MINUTES });
  });
});

describe('the decision form', () => {
  it('asks for the decision, a document for an approval and a reason for a rejection', () => {
    expect(validateDecide(EMPTY_DECIDE)).toEqual({ decision: 'required' });
    expect(validateDecide({ decision: 'APPROVE', documentId: '', comment: '' })).toEqual({ documentId: 'required' });
    expect(validateDecide({ decision: 'APPROVE', documentId: 'nope', comment: '' })).toEqual({ documentId: 'uuid' });
    expect(validateDecide({ decision: 'APPROVE', documentId: DECISION, comment: 'KQ-01' })).toEqual({});
    expect(validateDecide({ decision: 'REJECT', documentId: '', comment: '  ' })).toEqual({ comment: 'required' });
    expect(validateDecide({ decision: 'REJECT', documentId: DECISION, comment: 'No.' })).toEqual({ documentId: 'notAllowed' });
    expect(validateDecide({ decision: 'REJECT', documentId: '', comment: 'No.' })).toEqual({});
    expect(validateDecide({ decision: 'APPROVE', documentId: DECISION, comment: 'x'.repeat(2001) })).toEqual({ comment: 'tooLong' });
  });

  it('builds the body: the document only for an approval, the note trimmed and only when there is one', () => {
    expect(decideBody({ decision: 'APPROVE', documentId: ` ${DECISION.toUpperCase()} `, comment: ' KQ-01 ' })).toEqual({ decision: 'APPROVE', decision_document_id: DECISION, comment: 'KQ-01' });
    expect(decideBody({ decision: 'APPROVE', documentId: DECISION, comment: '' })).toEqual({ decision: 'APPROVE', decision_document_id: DECISION });
    expect(decideBody({ decision: 'REJECT', documentId: DECISION, comment: ' Too high. ' })).toEqual({ decision: 'REJECT', comment: 'Too high.' });
    expect(decideBody({ decision: '', documentId: '', comment: '' })).toEqual({ decision: 'REJECT' });
  });
});

describe('describeProblem', () => {
  it('names each refusal of the two commands', () => {
    const codes: Record<string, string> = {
      PRICE_EXCEEDS_PACKAGE_BUDGET: 'priceExceeds',
      PLAN_NOT_APPROVED: 'planNotApproved',
      CONTRACTOR_RESTRICTED: 'restricted',
      CONTRACTOR_NOT_VERIFIED: 'notVerified',
      REPORT_NOT_ISSUED: 'reportNotIssued',
      RESULT_STATE_INVALID: 'resultState',
      SELF_APPROVAL_DENIED: 'selfApproval',
      SCOPE_DENIED: 'denied',
      DOA_RULE_NOT_FOUND: 'noRule',
      DECISION_DOCUMENT_NOT_EFFECTIVE: 'decisionDocument',
      VERSION_CONFLICT: 'versionConflict',
      VALIDATION_FAILED: 'validation',
      INVALID_REQUEST: 'validation',
      FIELD_NOT_ALLOWED: 'validation',
      RESOURCE_NOT_FOUND: 'notFound',
      SESSION_EXPIRED: 'session',
      SOMETHING_ELSE: 'general',
    };
    for (const [code, expected] of Object.entries(codes)) expect(describeProblem(problem(code))).toBe(expected);
    expect(describeProblem(new Error('x'))).toBe('general');
  });

  it('tells an open result from a decided one, and a delegation limit from a plain denial', () => {
    expect(describeProblem(problem('RESULT_STATE_INVALID', { reason: 'OPEN_RESULT' }))).toBe('openResult');
    expect(describeProblem(problem('SCOPE_DENIED', { approver_role_id: 'r' }))).toBe('delegation');
  });
});
