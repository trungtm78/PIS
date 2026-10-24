import {
  TECHNICAL_CLASSES,
  TECHNICAL_RETENTION_DAYS,
  addYears,
  isCalendarDate,
  recordKindOf,
  retentionFindings,
  technicalCutoff,
  validateRetentionPolicy,
} from './retention.ts';
import type { RetentionPolicyContent } from './retention.ts';

const valid = (overrides: Partial<RetentionPolicyContent> = {}): RetentionPolicyContent => ({
  record_class: 'project_dossier',
  retention_years: 10,
  retention_basis: 'FROM_CLOSED',
  legal_basis_ref: 'TT 10/2022/TT-BNV',
  end_action: 'REVIEW_FOR_DESTRUCTION',
  effective_from: '2026-01-01',
  ...overrides,
});

const codes = (content: RetentionPolicyContent): string[] => retentionFindings(content).map((found) => `${found.field}:${found.code}`);

describe('recordKindOf', () => {
  it.each(['project_dossier', 'payment_dossier', 'report_revision', 'contract', 'contract_revision', 'payment_request', 'audit_event'])('%s is a business class', (name) => {
    expect(recordKindOf(name)).toBe('BUSINESS');
  });

  it('knows exactly the five technical classes', () => {
    expect([...TECHNICAL_CLASSES].sort()).toEqual(['delivery_attempt', 'idempotency_record', 'integration_event_inbox', 'outbox_event', 'user_session']);
    for (const name of TECHNICAL_CLASSES) expect(recordKindOf(name)).toBe('TECHNICAL');
  });

  it.each(['widget', 'dossier', 'project_dossiers', 'Payment', ''])('does not know %j', (name) => {
    expect(recordKindOf(name)).toBeUndefined();
  });

  it('takes every name that begins with contract or payment as business, as BR-ADM-11 says (contract*, payment*)', () => {
    expect(recordKindOf('contractor_register')).toBe('BUSINESS');
    expect(recordKindOf('payment')).toBe('BUSINESS');
  });
});

describe('retentionFindings (BR-ADM-11)', () => {
  it('accepts a business class reviewed after ten years, and a permanent one', () => {
    expect(retentionFindings(valid())).toEqual([]);
    expect(retentionFindings(valid({ retention_basis: 'PERMANENT', retention_years: undefined }))).toEqual([]);
    expect(retentionFindings(valid({ retention_basis: 'PERMANENT', retention_years: null, end_action: 'ARCHIVE_TRANSFER' }))).toEqual([]);
    expect(retentionFindings(valid({ record_class: 'audit_event', retention_basis: 'FROM_CREATED', end_action: 'ARCHIVE_TRANSFER' }))).toEqual([]);
  });

  it('refuses a job that purges a business class (AC-ST-ADM-017-1)', () => {
    expect(codes(valid({ end_action: 'AUTO_PURGE_TECHNICAL' }))).toEqual(['end_action:END_ACTION_NOT_ALLOWED']);
    expect(codes(valid({ record_class: 'audit_event', end_action: 'AUTO_PURGE_TECHNICAL' }))).toEqual(['end_action:END_ACTION_NOT_ALLOWED']);
  });

  it('refuses PERMANENT with a period of years, and a period that is missing, out of range or not whole (AC-ST-ADM-017-1)', () => {
    expect(codes(valid({ retention_basis: 'PERMANENT', retention_years: 10 }))).toEqual(['retention_years:YEARS_NOT_ALLOWED']);
    expect(codes(valid({ retention_years: undefined }))).toEqual(['retention_years:YEARS_REQUIRED']);
    expect(codes(valid({ retention_years: null }))).toEqual(['retention_years:YEARS_REQUIRED']);
    expect(codes(valid({ retention_years: 0 }))).toEqual(['retention_years:YEARS_RANGE']);
    expect(codes(valid({ retention_years: 101 }))).toEqual(['retention_years:YEARS_RANGE']);
    expect(codes(valid({ retention_years: 2.5 }))).toEqual(['retention_years:YEARS_RANGE']);
    expect(codes(valid({ retention_years: 100 }))).toEqual([]);
    expect(codes(valid({ retention_years: 1 }))).toEqual([]);
  });

  it('lets a technical class be purged only, from its creation, or kept for good', () => {
    const technical = valid({ record_class: 'outbox_event', retention_basis: 'FROM_CREATED', retention_years: 1, end_action: 'AUTO_PURGE_TECHNICAL' });
    expect(retentionFindings(technical)).toEqual([]);
    expect(retentionFindings({ ...technical, retention_basis: 'PERMANENT', retention_years: undefined })).toEqual([]);
    expect(codes({ ...technical, end_action: 'REVIEW_FOR_DESTRUCTION' })).toEqual(['end_action:END_ACTION_NOT_ALLOWED']);
    expect(codes({ ...technical, end_action: 'ARCHIVE_TRANSFER' })).toEqual(['end_action:END_ACTION_NOT_ALLOWED']);
    expect(codes({ ...technical, retention_basis: 'FROM_CLOSED' })).toEqual(['retention_basis:BASIS_NOT_ALLOWED']);
    expect(codes({ ...technical, retention_basis: 'FROM_CONTRACT_END' })).toEqual(['retention_basis:BASIS_NOT_ALLOWED']);
  });

  it('refuses a class that is malformed or that the platform does not know', () => {
    expect(codes(valid({ record_class: 'Project Dossier' }))).toEqual(['record_class:CLASS_FORMAT']);
    expect(codes(valid({ record_class: '' }))).toEqual(['record_class:CLASS_FORMAT']);
    expect(codes(valid({ record_class: 'widget' }))).toEqual(['record_class:CLASS_UNKNOWN']);
  });

  it('wants a legal basis of some length and a real effective day', () => {
    expect(codes(valid({ legal_basis_ref: '    ' }))).toEqual(['legal_basis_ref:LEGAL_BASIS_REQUIRED']);
    expect(codes(valid({ legal_basis_ref: 'x'.repeat(501) }))).toEqual(['legal_basis_ref:LEGAL_BASIS_REQUIRED']);
    expect(codes(valid({ effective_from: '2026-02-30' }))).toEqual(['effective_from:DATE_INVALID']);
    expect(codes(valid({ effective_from: '1/1/2026' }))).toEqual(['effective_from:DATE_INVALID']);
  });

  it('names every finding with the key of the sentence to show', () => {
    const found = retentionFindings(valid({ record_class: 'widget', retention_basis: 'PERMANENT', retention_years: 3, legal_basis_ref: '', effective_from: 'x' }));
    expect(found.map((entry) => entry.code)).toEqual(['CLASS_UNKNOWN', 'YEARS_NOT_ALLOWED', 'LEGAL_BASIS_REQUIRED', 'DATE_INVALID']);
    expect(found.every((entry) => /^adm\.retention\.error\.[a-zA-Z]+$/.test(entry.message))).toBe(true);
  });
});

describe('validateRetentionPolicy', () => {
  it('passes a valid policy and fails an invalid one with 422 RETENTION_POLICY_INVALID, the first field as detail and every finding in errors', () => {
    expect(() => validateRetentionPolicy(valid())).not.toThrow();
    try {
      validateRetentionPolicy(valid({ end_action: 'AUTO_PURGE_TECHNICAL', retention_basis: 'PERMANENT', retention_years: 10 }));
      throw new Error('expected a failure');
    } catch (error) {
      expect(error).toMatchObject({ code: 'RETENTION_POLICY_INVALID', status: 422, detail: 'end_action' });
      expect((error as { extensions: { errors: unknown[] } }).extensions.errors).toHaveLength(2);
    }
  });
});

describe('dates', () => {
  it('knows real days', () => {
    expect(isCalendarDate('2024-02-29')).toBe(true);
    expect(isCalendarDate('2026-02-29')).toBe(false);
    expect(isCalendarDate('2026-13-01')).toBe(false);
    expect(isCalendarDate('2026-1-1')).toBe(false);
  });

  it('adds whole years and moves 29 February to 28 February in a year without one', () => {
    expect(addYears('2026-03-15', 10)).toBe('2036-03-15');
    expect(addYears('2024-02-29', 1)).toBe('2025-02-28');
    expect(addYears('2024-02-29', 4)).toBe('2028-02-29');
    expect(() => addYears('soon', 1)).toThrow(RangeError);
  });
});

describe('technicalCutoff', () => {
  const now = new Date('2026-10-24T00:00:00.000Z');
  const daysBefore = (days: number): string => new Date(now.getTime() - days * 86_400_000).toISOString();

  it('is the platform period of the class when the tenant has no policy', () => {
    for (const name of TECHNICAL_CLASSES) expect(technicalCutoff(name, undefined, now)?.toISOString()).toBe(daysBefore(TECHNICAL_RETENTION_DAYS[name]));
  });

  it('can only be lengthened by a policy, never shortened, and is none for a class kept for good', () => {
    expect(technicalCutoff('outbox_event', { years: 1, permanent: false }, now)?.toISOString()).toBe(daysBefore(365));
    expect(technicalCutoff('delivery_attempt', { years: 1, permanent: false }, now)?.toISOString()).toBe(daysBefore(365));
    expect(technicalCutoff('user_session', { years: undefined, permanent: false }, now)?.toISOString()).toBe(daysBefore(180));
    expect(technicalCutoff('outbox_event', { years: undefined, permanent: true }, now)).toBeUndefined();
  });
});
