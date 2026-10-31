import type { DomainError } from '../src/errors';
import {
  ANNUAL_SETTLEMENT_FORM_CODES,
  PROJECT_SETTLEMENT_FORM_CODES,
  SETTLEMENT_DECISION_FORM,
  SETTLEMENT_FORM_CODES,
  settlementFormPayload,
  settlementFormsAskedFor,
  settlementFormsOf,
} from '../src/pay-settlement-forms';
import type { SettlementFormFacts } from '../src/pay-settlement-forms';

const failure = (work: () => unknown): DomainError => {
  try {
    work();
  } catch (error) {
    return error as DomainError;
  }
  throw new Error('expected a refusal');
};

const facts = (overrides: Partial<SettlementFormFacts> = {}): SettlementFormFacts => ({
  agency: 'Ban quản lý dự án',
  place: 'Cao Bằng',
  projectCode: 'DA-2026-001',
  projectName: 'Đường tỉnh lộ 205',
  scope: 'PROJECT',
  fiscalYear: null,
  revision: 1,
  projectGroup: 'B',
  settledAmountVnd: '1234567890',
  outstandingVnd: '0',
  unrecoveredAdvanceVnd: '1000',
  submittedOn: '2026-07-01',
  verifiedOn: '2026-07-20',
  ...overrides,
});

describe('the forms of a settlement (ST-PAY-012, CXN-09)', () => {
  it('knows the forms of a year, of a completed project and of nothing else', () => {
    expect(settlementFormsOf('ANNUAL')).toEqual(ANNUAL_SETTLEMENT_FORM_CODES);
    expect(settlementFormsOf('PROJECT')).toEqual(PROJECT_SETTLEMENT_FORM_CODES);
    expect(settlementFormsOf('CONTRACT')).toEqual([]);
    expect(SETTLEMENT_FORM_CODES).toHaveLength(17);
    expect(PROJECT_SETTLEMENT_FORM_CODES).toContain(SETTLEMENT_DECISION_FORM);
  });

  it('takes the forms of the scope, once each, in the order of the list', () => {
    expect(settlementFormsAskedFor('ANNUAL', ['02/QTNĐ', '01/QTNĐ'])).toEqual(['01/QTNĐ', '02/QTNĐ']);
    expect(settlementFormsAskedFor('PROJECT', ['10/QTDA', '01/QTDA'])).toEqual(['01/QTDA', '10/QTDA']);
  });

  it('refuses a form that is unknown, of the other scope or asked twice, none at all, and a settlement of one contract', () => {
    expect(failure(() => settlementFormsAskedFor('ANNUAL', ['01/QTDA']))).toMatchObject({ code: 'VALIDATION_FAILED', status: 422, detail: 'form_codes', extensions: { form_code: '01/QTDA' } });
    expect(failure(() => settlementFormsAskedFor('PROJECT', ['13/QTDA']))).toMatchObject({ detail: 'form_codes', extensions: { form_code: '13/QTDA' } });
    expect(failure(() => settlementFormsAskedFor('PROJECT', ['01/QTDA', '01/QTDA']))).toMatchObject({ detail: 'form_codes' });
    expect(failure(() => settlementFormsAskedFor('PROJECT', []))).toMatchObject({ detail: 'form_codes' });
    expect(failure(() => settlementFormsAskedFor('CONTRACT', ['01/QTDA']))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'id', extensions: { reason: 'SCOPE_HAS_NO_FORMS', settlement_scope: 'CONTRACT' } });
  });

  it('fills a form from the facts of the settlement, the same way every time', () => {
    const payload = settlementFormPayload(facts(), '01/QTDA');
    expect(payload).toMatchObject({
      agency: 'Ban quản lý dự án',
      place: 'Cao Bằng',
      form_code: '01/QTDA',
      summary: 'Báo cáo quyết toán dự án hoàn thành DA-2026-001',
      settlement_scope: 'PROJECT',
      revision: '1',
      project_group: 'B',
      fiscal_year: '',
      amount_vnd: '1234567890',
      settled_amount_text: '1.234.567.890',
      outstanding_text: '0',
      unrecovered_advance_text: '1.000',
      submitted_on: '2026-07-01',
      verified_on: '2026-07-20',
    });
    expect(settlementFormPayload(facts(), '01/QTDA')).toEqual(payload);
  });

  it('words the decision and the form of a year differently, and leaves the missing days and group empty', () => {
    expect(settlementFormPayload(facts(), SETTLEMENT_DECISION_FORM).summary).toBe('Quyết định phê duyệt quyết toán dự án hoàn thành DA-2026-001');
    const annual = settlementFormPayload(facts({ scope: 'ANNUAL', fiscalYear: 2026, projectGroup: null, submittedOn: null, verifiedOn: null }), '01/QTNĐ');
    expect(annual).toMatchObject({ summary: 'Báo cáo quyết toán niên độ 2026 của dự án DA-2026-001', fiscal_year: '2026', project_group: '', submitted_on: '', verified_on: '' });
    expect(failure(() => settlementFormPayload(facts({ outstandingVnd: '1.5' }), '01/QTDA'))).toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});
