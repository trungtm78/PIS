import type { DomainError } from '../src/errors';
import { DOCUMENT_KINDS, PAYMENT_KINDS, PAYMENT_STATUSES, assertContractAllows, assertPlanYear, contractRefusal, disbursementEnd, isEditable } from '../src/pay-request';
import type { ContractFacts, PaymentKind } from '../src/pay-request';

function refusal(work: () => unknown): DomainError {
  try {
    work();
  } catch (error) {
    return error as DomainError;
  }
  throw new Error('expected a refusal');
}

const contract = (status: string, overrides: Partial<ContractFacts> = {}): ContractFacts => ({ status, suspendedFrom: null, terminatedOn: null, ...overrides });

describe('a payment request and the state of its contract (ST-PAY-002)', () => {
  it('names the kinds, the states and the kinds of document, and lets a request be edited while it is a draft or returned', () => {
    expect(PAYMENT_KINDS).toEqual(['ADVANCE', 'INTERIM', 'FINAL']);
    expect(PAYMENT_STATUSES.filter(isEditable)).toEqual(['DRAFT', 'RETURNED']);
    expect(DOCUMENT_KINDS).toHaveLength(6);
  });

  it('BR-PAY-09: an active contract takes every kind', () => {
    for (const kind of PAYMENT_KINDS) expect(contractRefusal(contract('ACTIVE'), kind, '2026-07-05')).toBeUndefined();
  });

  it('UAT-AC344: a suspended contract takes an interim request for an acceptance approved before the day it was suspended, and nothing else', () => {
    const suspended = contract('SUSPENDED', { suspendedFrom: '2026-07-10' });
    expect(contractRefusal(suspended, 'INTERIM', '2026-07-05')).toBeUndefined();
    expect(contractRefusal(suspended, 'INTERIM', '2026-07-12')).toBe('ACCEPTED_AFTER_SUSPENSION');
    expect(contractRefusal(suspended, 'INTERIM', '2026-07-10')).toBe('ACCEPTED_AFTER_SUSPENSION');
    expect(contractRefusal(suspended, 'ADVANCE', null)).toBe('KIND_NOT_ALLOWED_WHILE_SUSPENDED');
    expect(contractRefusal(suspended, 'FINAL', '2026-07-05')).toBe('KIND_NOT_ALLOWED_WHILE_SUSPENDED');
    expect(contractRefusal(contract('SUSPENDED'), 'INTERIM', '2026-07-05')).toBe('ACCEPTED_AFTER_SUSPENSION');
    expect(contractRefusal(suspended, 'INTERIM', null)).toBe('ACCEPTED_AFTER_SUSPENSION');
  });

  it('UAT-AC338: a terminated contract takes the final request for an acceptance approved up to the day it ended, and nothing else', () => {
    const terminated = contract('TERMINATED', { terminatedOn: '2026-08-15' });
    expect(contractRefusal(terminated, 'FINAL', '2026-08-01')).toBeUndefined();
    expect(contractRefusal(terminated, 'FINAL', '2026-08-15')).toBeUndefined();
    expect(contractRefusal(terminated, 'FINAL', '2026-08-16')).toBe('ACCEPTED_AFTER_TERMINATION');
    expect(contractRefusal(terminated, 'INTERIM', '2026-08-01')).toBe('KIND_NOT_ALLOWED_AFTER_TERMINATION');
    expect(contractRefusal(terminated, 'ADVANCE', null)).toBe('KIND_NOT_ALLOWED_AFTER_TERMINATION');
    expect(contractRefusal(contract('TERMINATED'), 'FINAL', '2026-08-01')).toBe('ACCEPTED_AFTER_TERMINATION');
    expect(contractRefusal(terminated, 'FINAL', null)).toBe('ACCEPTED_AFTER_TERMINATION');
  });

  it('a completed contract takes the final request only, and a contract that is not being performed takes none', () => {
    expect(contractRefusal(contract('COMPLETED'), 'FINAL', '2026-08-01')).toBeUndefined();
    expect(contractRefusal(contract('COMPLETED'), 'INTERIM', '2026-08-01')).toBe('KIND_NOT_ALLOWED_AFTER_COMPLETION');
    expect(contractRefusal(contract('COMPLETED'), 'ADVANCE', null)).toBe('KIND_NOT_ALLOWED_AFTER_COMPLETION');
    for (const status of ['DRAFT', 'IN_REVIEW', 'SIGNED', 'CLOSED', 'CANCELLED']) {
      for (const kind of PAYMENT_KINDS) expect(contractRefusal(contract(status), kind as PaymentKind, '2026-07-05')).toBe('CONTRACT_NOT_IN_PERFORMANCE');
    }
  });

  it('refuses as 409 CONTRACT_STATE_INVALID with the state, the kind and the reason', () => {
    expect(() => assertContractAllows(contract('ACTIVE'), 'INTERIM', null)).not.toThrow();
    expect(refusal(() => assertContractAllows(contract('SUSPENDED', { suspendedFrom: '2026-07-10' }), 'ADVANCE', null))).toMatchObject({
      code: 'CONTRACT_STATE_INVALID',
      status: 409,
      extensions: { contract_status: 'SUSPENDED', request_kind: 'ADVANCE', reason: 'KIND_NOT_ALLOWED_WHILE_SUSPENDED' },
    });
  });

  it('BR-PAY-14: the year of the capital line is no earlier than the year of the acceptance and still open for payment', () => {
    expect(disbursementEnd(2026, null)).toBe('2026-12-31');
    expect(disbursementEnd(2026, '2027-03-31')).toBe('2027-03-31');
    expect(() => assertPlanYear(2026, 2026, null, '2026-07-01')).not.toThrow();
    expect(() => assertPlanYear(2026, 2026, null, '2026-12-31')).not.toThrow();
    expect(() => assertPlanYear(2027, 2026, null, '2026-07-01')).not.toThrow();
    expect(() => assertPlanYear(2026, null, null, '2026-07-01')).not.toThrow();
    expect(refusal(() => assertPlanYear(2025, 2026, null, '2026-07-01'))).toMatchObject({ code: 'PLAN_YEAR_MISMATCH', status: 422, extensions: { reason: 'BEFORE_ACCEPTANCE', plan_year: 2025, acceptance_year: 2026 } });
    expect(refusal(() => assertPlanYear(2026, 2026, null, '2027-01-01'))).toMatchObject({ extensions: { reason: 'DISBURSEMENT_CLOSED', open_until: '2026-12-31' } });
    expect(() => assertPlanYear(2026, 2026, '2027-03-31', '2027-01-01')).not.toThrow();
    expect(refusal(() => assertPlanYear(2026, 2026, '2027-03-31', '2027-04-01'))).toMatchObject({ extensions: { reason: 'DISBURSEMENT_CLOSED', open_until: '2027-03-31' } });
  });
});
