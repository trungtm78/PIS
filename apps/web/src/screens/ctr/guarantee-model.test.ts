import { ApiError } from '@machvon/api-client';
import { describe, expect, it } from 'vitest';
import {
  EMPTY_REGISTER,
  EMPTY_FILTER,
  canExtend,
  canRelease,
  canVerify,
  daysBetween,
  daysLeftOf,
  describeProblem,
  endOfDay,
  extendBody,
  filterGuarantees,
  guaranteesLink,
  isOwnRegistration,
  registerBody,
  releaseBody,
  toGuarantee,
  validateExtend,
  validateRegister,
  validateRelease,
  validateVerify,
  verifyBody,
  vietnamDay,
} from './guarantee-model';
import type { Guarantee, RegisterForm } from './guarantee-model';

const UUID = '00000000-0000-4000-8000-000000000001';
const raw = (overrides: Record<string, unknown> = {}) => ({
  id: UUID,
  contract_id: 'c1',
  contract_code: 'HD-A-001',
  kind: 'ADVANCE',
  issuer: 'Ngân hàng Tỉnh',
  guarantee_no: 'BL-A-001',
  party_name: null,
  amount_vnd: '2000000000',
  valid_from: '2026-03-01',
  expires_on: '2026-12-01',
  status: 'ACTIVE',
  verification_status: 'VERIFIED',
  last_alert_days: 30,
  extended_from_id: null,
  version: 2,
  registered_by: 'M1',
  advance_outstanding_vnd: '1250000000',
  ...overrides,
});
const guarantee = (overrides: Record<string, unknown> = {}): Guarantee => toGuarantee(raw(overrides)) as Guarantee;

describe('the guarantees as the server answers them', () => {
  it('reads a guarantee with its figures as exact strings, and refuses an answer that is not one', () => {
    expect(toGuarantee(raw({ days_left: 12, released_at: '2026-11-30T00:00:00.000Z', release_reason: 'Done' }))).toEqual({
      id: UUID,
      contractId: 'c1',
      contractCode: 'HD-A-001',
      kind: 'ADVANCE',
      issuer: 'Ngân hàng Tỉnh',
      guaranteeNo: 'BL-A-001',
      partyName: null,
      amountVnd: '2000000000',
      validFrom: '2026-03-01',
      expiresOn: '2026-12-01',
      status: 'ACTIVE',
      verificationStatus: 'VERIFIED',
      lastAlertDays: 30,
      extendedFromId: null,
      version: 2,
      registeredBy: 'M1',
      releasedAt: '2026-11-30T00:00:00.000Z',
      releaseReason: 'Done',
      advanceOutstandingVnd: '1250000000',
      daysLeft: 12,
    });
    expect(toGuarantee(raw({ kind: 'BOND' }))).toBeUndefined();
    expect(toGuarantee(raw({ status: 'LOST' }))).toBeUndefined();
    expect(toGuarantee(raw({ version: '2' }))).toBeUndefined();
    expect(toGuarantee({ id: 'x' })).toBeUndefined();
    expect(toGuarantee(null)).toBeUndefined();
    expect(toGuarantee([])).toBeUndefined();
    expect(toGuarantee({ id: 'x', kind: 'INSURANCE', status: 'REJECTED', amount_vnd: '1', expires_on: '2026-01-01', version: 1 })).toMatchObject({ contractCode: '', issuer: '', guaranteeNo: null, lastAlertDays: null, registeredBy: null, advanceOutstandingVnd: undefined, daysLeft: undefined });
  });

  it('counts calendar days in Vietnam: 23:59 on the 1st there is still the 1st', () => {
    expect(vietnamDay(new Date('2026-12-01T16:59:00Z'))).toBe('2026-12-01');
    expect(vietnamDay(new Date('2026-12-01T17:00:00Z'))).toBe('2026-12-02');
    expect(daysBetween('2026-11-01', '2026-12-01')).toBe(30);
    expect(daysBetween('2026-12-01', '2026-11-24')).toBe(-7);
    expect(daysBetween('2026-12-31', '2027-01-01')).toBe(1);
    expect(daysLeftOf(guarantee(), new Date('2026-11-01T00:00:00Z'))).toBe(30);
    expect(daysLeftOf(guarantee({ days_left: 3 }), new Date('2026-11-01T00:00:00Z'))).toBe(3);
  });

  it('knows which commands a status allows, and that a person cannot verify or release what they registered', () => {
    expect([canVerify, canExtend, canRelease].map((can) => can(guarantee({ status: 'PENDING_VERIFICATION' })))).toEqual([true, false, false]);
    expect([canVerify, canExtend, canRelease].map((can) => can(guarantee({ status: 'ACTIVE' })))).toEqual([false, true, true]);
    expect([canVerify, canExtend, canRelease].map((can) => can(guarantee({ status: 'EXPIRED' })))).toEqual([false, false, true]);
    expect([canVerify, canExtend, canRelease].map((can) => can(guarantee({ status: 'RELEASED' })))).toEqual([false, false, false]);
    expect(isOwnRegistration(guarantee({ registered_by: 'ABC' }), 'abc')).toBe(true);
    expect(isOwnRegistration(guarantee({ registered_by: 'ABC' }), 'other')).toBe(false);
    expect(isOwnRegistration(guarantee({ registered_by: null }), 'abc')).toBe(false);
    expect(isOwnRegistration(guarantee(), undefined)).toBe(false);
  });

  it('filters by contract, status, kind and a word of the issuer, the number or the contract', () => {
    const all = [guarantee(), guarantee({ id: 'g2', contract_id: 'c2', contract_code: 'HD-B-009', kind: 'PERFORMANCE', status: 'PENDING_VERIFICATION', issuer: 'Vietcombank', guarantee_no: null })];
    expect(filterGuarantees(all, EMPTY_FILTER, undefined)).toHaveLength(2);
    expect(filterGuarantees(all, EMPTY_FILTER, 'c2').map((g) => g.id)).toEqual(['g2']);
    expect(filterGuarantees(all, { ...EMPTY_FILTER, status: 'ACTIVE' }, undefined).map((g) => g.id)).toEqual([UUID]);
    expect(filterGuarantees(all, { ...EMPTY_FILTER, kind: 'PERFORMANCE' }, undefined).map((g) => g.id)).toEqual(['g2']);
    expect(filterGuarantees(all, { ...EMPTY_FILTER, query: ' VIETCOM ' }, undefined).map((g) => g.id)).toEqual(['g2']);
    expect(filterGuarantees(all, { ...EMPTY_FILTER, query: 'bl-a' }, undefined).map((g) => g.id)).toEqual([UUID]);
    expect(filterGuarantees(all, { ...EMPTY_FILTER, query: 'hd-b' }, undefined).map((g) => g.id)).toEqual(['g2']);
    expect(filterGuarantees(all, { ...EMPTY_FILTER, query: 'zzz' }, undefined)).toEqual([]);
  });

  it('links to the guarantees of a contract, or to all of them', () => {
    expect(guaranteesLink()).toBe('/ctr/ctr-05');
    expect(guaranteesLink('a b')).toBe('/ctr/ctr-05?id=a+b');
  });
});

describe('the forms of the commands', () => {
  const filled: RegisterForm = { ...EMPTY_REGISTER, issuer: ' Ngân hàng Tỉnh ', guaranteeNo: ' BL-1 ', amount: '500000000', validFrom: '2026-03-01', expiresOn: '2026-12-31', documentVersionId: UUID };

  it('takes the end of the day, in Vietnam, as the expiry', () => {
    expect(endOfDay('2026-12-01')).toBe('2026-12-01T23:59:00+07:00');
    expect(new Date(endOfDay('2026-12-01')).toISOString()).toBe('2026-12-01T16:59:00.000Z');
  });

  it('builds the body of the registration with trimmed texts, a whole amount and the member only when one is chosen', () => {
    expect(validateRegister(filled)).toEqual({});
    expect(registerBody(filled)).toEqual({
      kind: 'PERFORMANCE',
      issuer: 'Ngân hàng Tỉnh',
      guarantee_no: 'BL-1',
      amount_vnd: '500000000',
      valid_from: '2026-03-01',
      expires_at: '2026-12-31T23:59:00+07:00',
      document_version_id: UUID,
    });
    expect(registerBody({ ...filled, partyId: UUID, amount: '000500' })).toMatchObject({ party_id: UUID, amount_vnd: '500' });
  });

  it('names what is wrong with a registration before anything is sent', () => {
    expect(validateRegister(EMPTY_REGISTER)).toEqual({ issuer: 'required', guaranteeNo: 'required', amount: 'required', validFrom: 'required', expiresOn: 'required', documentVersionId: 'required' });
    expect(
      validateRegister({ ...filled, issuer: 'i'.repeat(301), guaranteeNo: 'n'.repeat(101), amount: '1.5', validFrom: '2026-02-30', expiresOn: 'soon', documentVersionId: 'x', partyId: 'y' }),
    ).toEqual({ issuer: 'tooLong', guaranteeNo: 'tooLong', amount: 'invalidAmount', validFrom: 'invalidDate', expiresOn: 'invalidDate', documentVersionId: 'invalidId', partyId: 'invalidId' });
    expect(validateRegister({ ...filled, amount: '0' })).toEqual({ amount: 'zeroAmount' });
    expect(validateRegister({ ...filled, expiresOn: '2026-02-28' })).toEqual({ expiresOn: 'endBeforeStart' });
    expect(validateRegister({ ...filled, amount: '9'.repeat(25) })).toEqual({ amount: 'invalidAmount' });
  });

  it('builds and checks the verification', () => {
    const form = { outcome: 'VERIFIED' as const, method: ' Letter ', evidenceId: ` ${UUID} ` };
    expect(validateVerify(form)).toEqual({});
    expect(verifyBody(form)).toEqual({ outcome: 'VERIFIED', method: 'Letter', evidence_document_version_id: UUID });
    expect(validateVerify({ outcome: 'FAILED', method: ' ', evidenceId: 'x' })).toEqual({ method: 'required', evidenceId: 'invalidId' });
    expect(validateVerify({ outcome: 'FAILED', method: 'm'.repeat(2001), evidenceId: '' })).toEqual({ method: 'tooLong', evidenceId: 'required' });
  });

  it('builds and checks the extension: the new expiry must come after the current one', () => {
    const form = { expiresOn: '2027-06-30', guaranteeNo: ' BL-2 ', documentVersionId: UUID };
    expect(validateExtend(form, '2026-12-31')).toEqual({});
    expect(extendBody(form)).toEqual({ new_expires_at: '2027-06-30T23:59:00+07:00', new_guarantee_no: 'BL-2', document_version_id: UUID });
    expect(validateExtend({ ...form, expiresOn: '2026-12-31' }, '2026-12-31')).toEqual({ expiresOn: 'notLater' });
    expect(validateExtend({ expiresOn: '', guaranteeNo: '', documentVersionId: 'x' }, '2026-12-31')).toEqual({ expiresOn: 'required', guaranteeNo: 'required', documentVersionId: 'invalidId' });
    expect(validateExtend({ ...form, expiresOn: '2027-13-01' }, '2026-12-31')).toEqual({ expiresOn: 'invalidDate' });
  });

  it('builds and checks the release: evidence and a reason are both required', () => {
    const form = { evidenceId: UUID, reason: ' Obligation completed ' };
    expect(validateRelease(form)).toEqual({});
    expect(releaseBody(form)).toEqual({ release_evidence_id: UUID, reason: 'Obligation completed' });
    expect(validateRelease({ evidenceId: '', reason: '' })).toEqual({ evidenceId: 'required', reason: 'required' });
  });
});

describe('refusals', () => {
  const refused = (code: string, status = 422, detail?: string, extensions: Record<string, unknown> = {}) => new ApiError({ status, code, correlationId: 'c', detail, extensions });

  it.each([
    ['GUARANTEE_DUPLICATE', 'duplicate'],
    ['SELF_APPROVAL_DENIED', 'selfApproval'],
    ['GUARANTEE_STATE_INVALID', 'stateInvalid'],
    ['CONTRACT_STATE_INVALID', 'contractState'],
    ['RELEASE_CONDITION_NOT_MET', 'releaseCondition'],
    ['VERSION_CONFLICT', 'versionConflict'],
    ['VALIDATION_FAILED', 'validation'],
    ['INVALID_REQUEST', 'validation'],
    ['FIELD_NOT_ALLOWED', 'validation'],
    ['RESOURCE_NOT_FOUND', 'notFound'],
    ['SCOPE_DENIED', 'denied'],
    ['OTHER', 'general'],
  ])('maps %s to %s', (code, reason) => {
    expect(describeProblem(refused(code)).reason).toBe(reason);
  });

  it('carries the field, and the advance that is still owed', () => {
    expect(describeProblem(refused('VALIDATION_FAILED', 422, 'amount_vnd'))).toEqual({ reason: 'validation', field: 'amount_vnd', advanceOutstanding: undefined });
    expect(describeProblem(refused('RELEASE_CONDITION_NOT_MET', 422, 'advance_outstanding_vnd', { advance_outstanding_vnd: '1250000000' })).advanceOutstanding).toBe('1250000000');
    expect(describeProblem(new Error('network'))).toEqual({ reason: 'general', field: undefined, advanceOutstanding: undefined });
  });
});
