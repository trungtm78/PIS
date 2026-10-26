import { ApiError } from '@machvon/api-client';
import { describe, expect, it } from 'vitest';
import {
  EMPTY_CONCLUSION_FORM,
  EMPTY_FINDING_FORM,
  EMPTY_RECOMMENDATION_FORM,
  awaitsConclusion,
  canRecord,
  concludable,
  conclusionBody,
  currentOf,
  describeProblem,
  digitsOf,
  findingBody,
  formatVnd,
  isFinancial,
  placeChoiceOf,
  recommendationBody,
  takesMore,
  toConclusion,
  toFinding,
  toRecommendation,
  validateConclusion,
  validateFinding,
  validateRecommendation,
} from './model';
import type { ConclusionForm, ConclusionLine, FindingForm, RecommendationForm } from './model';
import { PROJECT, UNIT, conclusionRecord, findingRecord, recommendationRecord } from '../test-support';

const TODAY = '2026-10-26';
const DOCUMENT = '00000000-0000-4000-8000-000000000021';

const line = (overrides: Record<string, unknown> = {}): ConclusionLine => toConclusion(conclusionRecord(overrides)) as ConclusionLine;
const conclusionForm = (overrides: Partial<ConclusionForm> = {}): ConclusionForm => ({
  kind: 'AUDIT_REPORT',
  documentId: DOCUMENT,
  issuedOn: '2026-10-10',
  receivedOn: '2026-10-15',
  implementationDueOn: '2026-12-31',
  reportDueOn: '2027-01-15',
  totalVnd: '1.250.000.000',
  summary: 'Kiểm toán phát hiện thanh toán vượt khối lượng.',
  isPublic: false,
  ...overrides,
});

describe('the money of the screens of the conclusion (AUD 5)', () => {
  it('writes whole dong with a dot between the thousands', () => {
    expect(formatVnd('0')).toBe('0');
    expect(formatVnd('999')).toBe('999');
    expect(formatVnd('1250000000')).toBe('1.250.000.000');
    expect(formatVnd('50000000')).toBe('50.000.000');
  });

  it('reads the digits of an amount typed with dots, commas or spaces, and nothing else', () => {
    expect(digitsOf('1.250.000.000')).toBe('1250000000');
    expect(digitsOf('1,250,000,000')).toBe('1250000000');
    expect(digitsOf(' 1 250 000 000 ')).toBe('1250000000');
    expect(digitsOf('0007')).toBe('7');
    expect(digitsOf('0')).toBe('0');
    for (const bad of ['', 'abc', '12a', '-5', '1e3', '9'.repeat(25)]) expect(digitsOf(bad)).toBeUndefined();
    expect(digitsOf('9'.repeat(24))).toBe('9'.repeat(24));
  });
});

describe('what the reads answer', () => {
  it('reads a conclusion with its total, what the recommendations add up to and the shortfall', () => {
    expect(line()).toEqual({
      id: conclusionRecord().id,
      engagementId: conclusionRecord().engagement_id,
      kind: 'AUDIT_REPORT',
      document: { id: (conclusionRecord().document as { id: string }).id, title: 'Báo cáo kiểm toán cầu', symbol: '88/BC-KTNN' },
      revision: 1,
      issuedOn: '2026-10-10',
      receivedOn: '2026-10-15',
      implementationDueOn: '2026-12-31',
      reportDueOn: '2027-01-15',
      summary: 'Kiểm toán phát hiện thanh toán vượt khối lượng được duyệt.',
      totalVnd: '1250000000',
      recommendedVnd: '1200000000',
      shortfallVnd: '50000000',
      isPublic: false,
      status: 'RECEIVED',
      findingCount: 1,
      recommendationCount: 2,
      version: 1,
    });
  });

  it('keeps what is missing as empty or null, and drops a conclusion that cannot be read rather than show it half', () => {
    expect(line({ document: { id: DOCUMENT }, implementation_due_on: null, report_due_on: null, finding_count: undefined, recommendation_count: undefined })).toMatchObject({
      document: { title: '', symbol: null },
      implementationDueOn: null,
      reportDueOn: null,
      findingCount: 0,
      recommendationCount: 0,
    });
    for (const broken of [{ id: undefined }, { conclusion_kind: 'OTHER' }, { total_financial_vnd: '12.5' }, { recommended_vnd: 5 }, { status: 'LOST' }, { version: 1.5 }, { document: null }, { revision: '1' }, { summary: undefined }]) {
      expect(toConclusion(conclusionRecord(broken))).toBeUndefined();
    }
    expect(toConclusion(null)).toBeUndefined();
    expect(toConclusion([])).toBeUndefined();
  });

  it('reads a finding with the places it is about, and one without a place or an amount', () => {
    expect(toFinding(findingRecord(1))).toEqual({
      id: findingRecord(1).id,
      code: 'PH-001',
      category: 'FINANCIAL',
      project: { id: PROJECT, code: 'DA-2026-001', name: 'Cầu qua sông' },
      contract: null,
      unit: { id: UNIT, code: 'SXD', name: 'Sở Xây dựng' },
      description: 'Thanh toán vượt khối lượng nghiệm thu.',
      legalBasis: 'Điều 12 Luật Đầu tư công',
      amountVnd: '300000000',
      severity: 'HIGH',
    });
    expect(toFinding(findingRecord(2, { project: null, organization_unit: null, contract: { id: 'c1', code: 'HD-1' }, legal_basis_cited: null, amount_vnd: null }))).toMatchObject({
      project: null,
      unit: null,
      contract: { id: 'c1', code: 'HD-1' },
      legalBasis: null,
      amountVnd: null,
    });
    for (const broken of [{ finding_code: undefined }, { category: 'X' }, { severity: 'X' }, { description: 3 }]) expect(toFinding(findingRecord(3, broken))).toBeUndefined();
    expect(toFinding(undefined)).toBeUndefined();
  });

  it('reads a recommendation, with no amount for one that is not financial', () => {
    expect(toRecommendation(recommendationRecord(1))).toMatchObject({ code: 'KN-001', type: 'FINANCIAL_RECOVERY', amountVnd: '800000000', recoveredVnd: '0', status: 'OPEN', findingId: null });
    expect(toRecommendation(recommendationRecord(2, { rec_type: 'REFERRAL', amount_vnd: null, recovered_vnd: undefined, finding_id: 'f1' }))).toMatchObject({ type: 'REFERRAL', amountVnd: null, recoveredVnd: '0', findingId: 'f1' });
    for (const broken of [{ rec_code: undefined }, { rec_type: 'X' }, { status: 'X' }, { description: 1 }]) expect(toRecommendation(recommendationRecord(3, broken))).toBeUndefined();
    expect(toRecommendation('x')).toBeUndefined();
  });
});

describe('what the caller may do and what the engagement allows', () => {
  it('shows the buttons to whoever holds the permission to record, in a tenant that is not read only', () => {
    expect(canRecord(['aud.conclusion.record'], undefined)).toBe(true);
    expect(canRecord(undefined, 'FULL')).toBe(true);
    expect(canRecord(['aud.read'], 'FULL')).toBe(false);
    expect(canRecord(['aud.conclusion.record'], 'READ_ONLY')).toBe(false);
  });

  it('takes a conclusion while the fieldwork goes on or has ended, and lists the engagements that can take one or have one', () => {
    expect(['PLANNED', 'ONGOING', 'AWAITING_CONCLUSION', 'FOLLOW_UP', 'CLOSED', 'CANCELLED'].map((status) => awaitsConclusion(status as never))).toEqual([false, true, true, false, false, false]);
    expect(['PLANNED', 'ONGOING', 'AWAITING_CONCLUSION', 'FOLLOW_UP', 'CLOSED', 'CANCELLED'].map((status) => concludable(status as never))).toEqual([false, true, true, true, true, false]);
  });

  it('takes more findings and recommendations only on the current revision of an engagement that is followed up', () => {
    expect(takesMore('FOLLOW_UP', line())).toBe(true);
    expect(takesMore('FOLLOW_UP', line({ status: 'ANALYSED' }))).toBe(true);
    expect(takesMore('FOLLOW_UP', line({ status: 'SUPERSEDED' }))).toBe(false);
    expect(takesMore('FOLLOW_UP', line({ status: 'CLOSED' }))).toBe(false);
    expect(takesMore('CLOSED', line())).toBe(false);
    expect(takesMore('ONGOING', line())).toBe(false);
  });

  it('shows the newest revision that was not superseded', () => {
    const first = line({ id: 'a', revision: 1, status: 'SUPERSEDED' });
    const second = line({ id: 'b', revision: 2 });
    expect(currentOf([first, second])?.id).toBe('b');
    expect(currentOf([first])).toBeUndefined();
    expect(currentOf([])).toBeUndefined();
  });

  it('knows the recommendations that carry money', () => {
    expect(isFinancial('FINANCIAL_RECOVERY')).toBe(true);
    expect(isFinancial('FINANCIAL_ADJUSTMENT')).toBe(true);
    for (const type of ['PROCESS_CORRECTION', 'ACCOUNTABILITY', 'REFERRAL', 'POLICY_CHANGE'] as const) expect(isFinancial(type)).toBe(false);
  });
});

describe('the form of a conclusion', () => {
  it('has nothing wrong with a full one, and the body sends the document in lower case, the days, the total in whole dong and the public flag', () => {
    const form = conclusionForm({ documentId: DOCUMENT.toUpperCase(), isPublic: true });
    expect(validateConclusion(form, TODAY)).toEqual({});
    expect(conclusionBody(form)).toEqual({
      conclusion_kind: 'AUDIT_REPORT',
      conclusion_document_id: DOCUMENT,
      issued_on: '2026-10-10',
      received_on: '2026-10-15',
      implementation_due_on: '2026-12-31',
      report_due_on: '2027-01-15',
      summary: 'Kiểm toán phát hiện thanh toán vượt khối lượng.',
      total_financial_vnd: '1250000000',
      is_public: true,
    });
  });

  it('leaves the due days out of the body when they are empty, and accepts a total of zero', () => {
    const form = conclusionForm({ implementationDueOn: '', reportDueOn: '', totalVnd: '0' });
    expect(validateConclusion(form, TODAY)).toEqual({});
    const body = conclusionBody(form);
    expect(body).not.toHaveProperty('implementation_due_on');
    expect(body).not.toHaveProperty('report_due_on');
    expect(body.total_financial_vnd).toBe('0');
  });

  it('says what is missing in an empty form', () => {
    expect(validateConclusion(EMPTY_CONCLUSION_FORM, TODAY)).toEqual({
      kind: 'required',
      documentId: 'required',
      issuedOn: 'required',
      receivedOn: 'required',
      totalVnd: 'required',
      summary: 'required',
    });
  });

  it('refuses a document that is not an id, days that are not days, ahead of today or out of order, due days before the issue, a total that is not whole dong and a short summary', () => {
    expect(validateConclusion(conclusionForm({ documentId: 'not-an-id' }), TODAY)).toEqual({ documentId: 'invalid' });
    expect(validateConclusion(conclusionForm({ issuedOn: '2026-13-01' }), TODAY)).toEqual({ issuedOn: 'invalid' });
    expect(validateConclusion(conclusionForm({ issuedOn: '2026-10-27', receivedOn: '2026-10-27' }), TODAY)).toEqual({ issuedOn: 'future', receivedOn: 'future' });
    expect(validateConclusion(conclusionForm({ receivedOn: '2026-10-09' }), TODAY)).toEqual({ receivedOn: 'order' });
    expect(validateConclusion(conclusionForm({ receivedOn: 'x' }), TODAY)).toEqual({ receivedOn: 'invalid' });
    expect(validateConclusion(conclusionForm({ implementationDueOn: '2026-10-09', reportDueOn: '2026-10-09' }), TODAY)).toEqual({ implementationDueOn: 'early', reportDueOn: 'early' });
    expect(validateConclusion(conclusionForm({ implementationDueOn: 'soon' }), TODAY)).toEqual({ implementationDueOn: 'invalid' });
    expect(validateConclusion(conclusionForm({ totalVnd: '12,5x' }), TODAY)).toEqual({ totalVnd: 'invalid' });
    expect(validateConclusion(conclusionForm({ summary: 'ngắn' }), TODAY)).toEqual({ summary: 'tooShort' });
    expect(validateConclusion(conclusionForm({ summary: 'x'.repeat(8001) }), TODAY)).toEqual({ summary: 'tooLong' });
    expect(validateConclusion(conclusionForm({ summary: `${'x'.repeat(20)}\u0007` }), TODAY)).toEqual({ summary: 'invalid' });
  });

  it('does not judge the due days against an issue day that is not a day (the issue day is the problem)', () => {
    expect(validateConclusion(conclusionForm({ issuedOn: '', implementationDueOn: '2020-01-01' }), TODAY)).toEqual({ issuedOn: 'required' });
  });
});

describe('the form of a finding', () => {
  const form = (overrides: Partial<FindingForm> = {}): FindingForm => ({
    code: 'PH-001',
    category: 'FINANCIAL',
    severity: 'HIGH',
    place: `PROJECT:${'p1'}`,
    description: 'Thanh toán vượt khối lượng nghiệm thu.',
    legalBasis: 'Điều 12 Luật Đầu tư công',
    amountVnd: '300.000.000',
    ...overrides,
  });

  it('sends the place as the field of its kind, the amount in whole dong and no empty legal basis', () => {
    expect(validateFinding(form())).toEqual({});
    expect(findingBody(form())).toEqual({
      finding_code: 'PH-001',
      category: 'FINANCIAL',
      severity: 'HIGH',
      description: 'Thanh toán vượt khối lượng nghiệm thu.',
      project_id: 'p1',
      legal_basis_cited: 'Điều 12 Luật Đầu tư công',
      amount_vnd: '300000000',
    });
    expect(findingBody(form({ place: 'CONTRACT:c1', legalBasis: '  ', amountVnd: '' }))).toEqual({
      finding_code: 'PH-001',
      category: 'FINANCIAL',
      severity: 'HIGH',
      description: 'Thanh toán vượt khối lượng nghiệm thu.',
      contract_id: 'c1',
    });
    expect(findingBody(form({ place: 'UNIT:u1' }))).toMatchObject({ organization_unit_id: 'u1' });
    expect(findingBody(form({ place: '' }))).not.toHaveProperty('project_id');
  });

  it('says what is missing and what is wrong', () => {
    expect(validateFinding(EMPTY_FINDING_FORM)).toEqual({ code: 'required', category: 'required', severity: 'required', description: 'required' });
    expect(validateFinding(form({ code: 'x'.repeat(41) }))).toEqual({ code: 'tooLong' });
    expect(validateFinding(form({ description: 'ngắn' }))).toEqual({ description: 'tooShort' });
    expect(validateFinding(form({ legalBasis: 'x'.repeat(2001) }))).toEqual({ legalBasis: 'tooLong' });
    expect(validateFinding(form({ legalBasis: 'a\u0007b' }))).toEqual({ legalBasis: 'invalid' });
    expect(validateFinding(form({ legalBasis: 'two\nlines' }))).toEqual({});
    expect(validateFinding(form({ amountVnd: '1.5x' }))).toEqual({ amountVnd: 'invalid' });
  });

  it('chooses a scope item by its kind and id', () => {
    expect(placeChoiceOf({ kind: 'PROJECT', id: 'p1', code: 'DA', name: 'Cầu' })).toBe('PROJECT:p1');
  });
});

describe('the form of a recommendation', () => {
  const form = (overrides: Partial<RecommendationForm> = {}): RecommendationForm => ({
    code: 'KN-001',
    type: 'FINANCIAL_RECOVERY',
    description: 'Thu hồi khoản thanh toán vượt khối lượng.',
    amountVnd: '50.000.000',
    findingId: '',
    ...overrides,
  });

  it('AC-ST-AUD-002-1: an amount that fits in the shortfall is sent in whole dong, one above it is refused before it is sent, and a financial one without an amount is refused', () => {
    expect(validateRecommendation(form(), '50000000')).toEqual({});
    expect(recommendationBody(form())).toEqual({ rec_code: 'KN-001', rec_type: 'FINANCIAL_RECOVERY', description: 'Thu hồi khoản thanh toán vượt khối lượng.', amount_vnd: '50000000' });
    expect(validateRecommendation(form({ amountVnd: '100.000.000' }), '50000000')).toEqual({ amountVnd: 'exceeds' });
    expect(validateRecommendation(form({ amountVnd: '' }), '50000000')).toEqual({ amountVnd: 'required' });
    expect(validateRecommendation(form({ amountVnd: '0' }), '50000000')).toEqual({ amountVnd: 'invalid' });
    expect(validateRecommendation(form({ amountVnd: 'abc' }), '50000000')).toEqual({ amountVnd: 'invalid' });
    expect(validateRecommendation(form({ amountVnd: '1' }), '0')).toEqual({ amountVnd: 'exceeds' });
  });

  it('sends no amount for a recommendation that is not financial, even when one was typed before the type changed, and the finding it answers', () => {
    const referral = form({ type: 'REFERRAL', amountVnd: '999', findingId: 'f1' });
    expect(validateRecommendation(referral, '0')).toEqual({});
    expect(recommendationBody(referral)).toEqual({ rec_code: 'KN-001', rec_type: 'REFERRAL', description: 'Thu hồi khoản thanh toán vượt khối lượng.', finding_id: 'f1' });
  });

  it('says what is missing in an empty form, and what is too short or too long', () => {
    expect(validateRecommendation(EMPTY_RECOMMENDATION_FORM, '0')).toEqual({ code: 'required', type: 'required', description: 'required' });
    expect(validateRecommendation(form({ code: 'x'.repeat(41), description: 'ngắn' }), '50000000')).toEqual({ code: 'tooLong', description: 'tooShort' });
  });
});

describe('what a refusal of the server comes to', () => {
  const refused = (code: string, extensions: Record<string, unknown> = {}) => new ApiError({ status: 422, code, correlationId: 'c', extensions });

  it('names the problem of each code the commands answer, and the general one for any other', () => {
    const cases: Array<[string, string]> = [
      ['DECISION_DOCUMENT_NOT_EFFECTIVE', 'decisionNotEffective'],
      ['ENGAGEMENT_STATE_INVALID', 'stateInvalid'],
      ['CONCLUSION_REVISION_INVALID', 'revisionInvalid'],
      ['VERSION_CONFLICT', 'versionConflict'],
      ['SCOPE_DENIED', 'scopeDenied'],
      ['VALIDATION_FAILED', 'validation'],
      ['INVALID_REQUEST', 'validation'],
      ['FIELD_NOT_ALLOWED', 'validation'],
      ['RESOURCE_NOT_FOUND', 'notFound'],
      ['FINDING_CODE_DUPLICATE', 'findingDuplicate'],
      ['REC_CODE_DUPLICATE', 'recommendationDuplicate'],
      ['AMOUNT_REQUIRED', 'amountRequired'],
      ['FINANCIAL_TOTAL_MISMATCH', 'totalMismatch'],
      ['TARGET_OUT_OF_ENGAGEMENT', 'targetOutside'],
      ['SOMETHING_ELSE', 'general'],
    ];
    for (const [code, problem] of cases) expect(describeProblem(refused(code)).problem).toBe(problem);
    expect(describeProblem(new Error('offline')).problem).toBe('general');
    expect(describeProblem(undefined)).toEqual({ problem: 'general', remainingVnd: undefined });
  });

  it('carries what is left of the total when the total refused the amount, and nothing otherwise', () => {
    expect(describeProblem(refused('FINANCIAL_TOTAL_MISMATCH', { remaining_vnd: '50000000' }))).toEqual({ problem: 'totalMismatch', remainingVnd: '50000000' });
    expect(describeProblem(refused('FINANCIAL_TOTAL_MISMATCH', { remaining_vnd: 'many' }))).toEqual({ problem: 'totalMismatch', remainingVnd: undefined });
    expect(describeProblem(refused('AMOUNT_REQUIRED', { remaining_vnd: '5' }))).toEqual({ problem: 'amountRequired', remainingVnd: undefined });
  });
});
