import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DomainError } from '../src/errors';
import { PAYMENT_FORM_CODES, formPayload, formsAskedFor, formsMissing, groupedVnd, isPaymentFormCode } from '../src/pay-forms';

const failure = (work: () => unknown): DomainError => {
  try {
    work();
  } catch (error) {
    return error as DomainError;
  }
  throw new Error('expected a refusal');
};

const facts = {
  agency: 'BAN QUẢN LÝ DỰ ÁN',
  place: 'Cao Bằng',
  requestNo: 'DNTT-001',
  requestKind: 'INTERIM',
  contractCode: 'HD-A-001',
  contractTitle: 'Thi công cầu',
  contractorName: 'Nhà thầu A',
  projectCode: 'DA-01',
  projectName: 'Cầu A',
  planYear: 2026,
  grossVnd: '3000000000',
  advanceRecoveryVnd: '750000000',
  retentionVnd: '150000000',
  taxAdjustmentVnd: '-1000000',
  netVnd: '2099000000',
};

describe('the Treasury forms of a payment request (PAY 3.3)', () => {
  it('names the four forms and knows them', () => {
    expect(PAYMENT_FORM_CODES).toEqual(['03.a/TT', '04.a/TT', '04.b/TT', '05.a/TT']);
    expect(isPaymentFormCode('03.a/TT')).toBe(true);
    expect(isPaymentFormCode('06.z/TT')).toBe(false);
  });

  it('holds the same four codes as the database does (V1566)', () => {
    const sql = readFileSync(join(__dirname, '../../../db/migrations/V1566__pay1_treasury_forms.sql'), 'utf8');
    for (const code of PAYMENT_FORM_CODES) expect(sql).toContain(`'${code}'`);
  });

  it('says which forms a request still lacks, in order', () => {
    expect(formsMissing([])).toEqual([...PAYMENT_FORM_CODES]);
    expect(formsMissing(['04.a/TT', '03.a/TT', '03.a/TT'])).toEqual(['04.b/TT', '05.a/TT']);
    expect(formsMissing(PAYMENT_FORM_CODES)).toEqual([]);
  });

  it('takes the forms asked for in the order of the list, each once, and refuses what is not a form', () => {
    expect(formsAskedFor(['05.a/TT', '03.a/TT'])).toEqual(['03.a/TT', '05.a/TT']);
    expect(failure(() => formsAskedFor([])).code).toBe('VALIDATION_FAILED');
    expect(failure(() => formsAskedFor(['03.a/TT', '03.a/TT']))).toMatchObject({ code: 'VALIDATION_FAILED', extensions: { form_code: '03.a/TT' } });
    expect(failure(() => formsAskedFor(['99/XX']))).toMatchObject({ code: 'VALIDATION_FAILED', extensions: { form_code: '99/XX' } });
  });

  it('writes an amount in groups of three digits, a minus sign in front', () => {
    expect(groupedVnd('0')).toBe('0');
    expect(groupedVnd('999')).toBe('999');
    expect(groupedVnd('1000')).toBe('1.000');
    expect(groupedVnd('3000000000')).toBe('3.000.000.000');
    expect(groupedVnd('-1000000')).toBe('-1.000.000');
    expect(failure(() => groupedVnd('1.5')).code).toBe('VALIDATION_FAILED');
  });

  it('fills a form from the figures of the request, the same way every time', () => {
    const payload = formPayload(facts, '03.a/TT');
    expect(payload).toMatchObject({
      agency: 'BAN QUẢN LÝ DỰ ÁN',
      place: 'Cao Bằng',
      form_code: '03.a/TT',
      request_no: 'DNTT-001',
      contract_code: 'HD-A-001',
      gross_vnd: '3000000000',
      advance_recovery_vnd: '750000000',
      retention_vnd: '150000000',
      net_vnd: '2099000000',
      gross_text: '3.000.000.000',
      tax_adjustment_text: '-1.000.000',
      net_text: '2.099.000.000',
      plan_year: '2026',
    });
    expect(formPayload(facts, '03.a/TT')).toEqual(payload);
    expect(formPayload({ ...facts, planYear: null }, '04.a/TT').plan_year).toBe('');
    expect(failure(() => formPayload({ ...facts, grossVnd: '-1' }, '03.a/TT')).code).toBe('VALIDATION_FAILED');
  });
});
