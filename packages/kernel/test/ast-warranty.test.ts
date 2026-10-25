import type { DomainError } from '../src/errors';
import { CLAIM_STATUSES, CONSTRUCTION_GRADES, assertWarrantyClosure, assertWarrantyPeriod, effectiveWarrantyStatus, hasRunOut, isOpenClaim, minimumMonths, warrantyEndsOn } from '../src/ast-warranty';

const failure = (work: () => unknown): DomainError => {
  try {
    work();
  } catch (error) {
    return error as DomainError;
  }
  throw new Error('expected a refusal');
};

const MINIMUMS = { SPECIAL: 24, I: 24, II: 12, III: 12, IV: 12 };

describe('the warranty of a work (ST-AST-003, BR-AST-03, BR-AST-05, UAT-AC390, UAT-AC392)', () => {
  it('takes the minimum term from the rule for the grade, and the longest one when the grade is not stated', () => {
    expect(CONSTRUCTION_GRADES.map((grade) => minimumMonths(MINIMUMS, grade))).toEqual([24, 24, 12, 12, 12]);
    expect(minimumMonths(MINIMUMS, null)).toBe(24);
    expect(minimumMonths({ II: 12, III: 18 }, null)).toBe(18);
    expect(minimumMonths({ II: 12 }, 'I')).toBeUndefined();
    expect(minimumMonths({}, null)).toBeUndefined();
  });

  it('AC-ST-AST-003-1, UAT-AC390: refuses a term below the minimum and creates one at or above it', () => {
    expect(failure(() => assertWarrantyPeriod(6, 12))).toMatchObject({ code: 'WARRANTY_PERIOD_BELOW_MINIMUM', status: 422, extensions: { minimum_months: 12, period_months: 6 } });
    expect(failure(() => assertWarrantyPeriod(11, 12)).code).toBe('WARRANTY_PERIOD_BELOW_MINIMUM');
    expect(() => assertWarrantyPeriod(12, 12)).not.toThrow();
    expect(() => assertWarrantyPeriod(36, 12)).not.toThrow();
  });

  it('AC-ST-AST-003-1, UAT-AC390: ends the warranty the term after it starts, on the last day of a shorter month', () => {
    expect(warrantyEndsOn('2026-09-01', 12)).toBe('2027-09-01');
    expect(warrantyEndsOn('2026-01-31', 1)).toBe('2026-02-28');
    expect(warrantyEndsOn('2024-02-29', 12)).toBe('2025-02-28');
    expect(warrantyEndsOn('2026-09-01', 24)).toBe('2028-09-01');
  });

  it('counts the warranty as run out from its last day: a claim the day before is valid, the day after is not', () => {
    expect(hasRunOut('2027-09-01', '2027-08-31')).toBe(false);
    expect(hasRunOut('2027-09-01', '2027-09-01')).toBe(true);
    expect(hasRunOut('2027-09-01', '2027-09-02')).toBe(true);
  });

  it('reads an active obligation whose last day has come as expired, and leaves the others as they are', () => {
    expect(effectiveWarrantyStatus('ACTIVE', '2027-09-01', '2027-08-31')).toBe('ACTIVE');
    expect(effectiveWarrantyStatus('ACTIVE', '2027-09-01', '2027-09-02')).toBe('EXPIRED');
    expect(effectiveWarrantyStatus('EXPIRED', '2027-09-01', '2027-08-01')).toBe('EXPIRED');
    expect(effectiveWarrantyStatus('CLOSED', '2027-09-01', '2030-01-01')).toBe('CLOSED');
  });

  it('holds a claim open until its repair is verified', () => {
    expect(CLAIM_STATUSES.filter(isOpenClaim)).toEqual(['OPEN', 'ACKNOWLEDGED', 'REPAIRING', 'FIXED', 'DISPUTED']);
  });

  it('AC-ST-AST-003-2, UAT-AC392: closes an obligation that has run out and has no claim open', () => {
    expect(() => assertWarrantyClosure({ status: 'EXPIRED', endsOn: '2027-09-01', today: '2027-09-02', openClaims: [] })).not.toThrow();
    expect(() => assertWarrantyClosure({ status: 'ACTIVE', endsOn: '2027-09-01', today: '2027-09-01', openClaims: [] })).not.toThrow();
  });

  it('AC-ST-AST-003-2, UAT-AC392: refuses to close while a claim is open, with the numbers of the claims', () => {
    expect(failure(() => assertWarrantyClosure({ status: 'EXPIRED', endsOn: '2027-09-01', today: '2027-09-02', openClaims: ['WC-002', 'WC-003'] }))).toMatchObject({
      code: 'OPEN_WARRANTY_CLAIMS',
      status: 422,
      extensions: { open_claims: 2, claim_nos: ['WC-002', 'WC-003'] },
    });
  });

  it('refuses to close before the last day, whatever the claims, and to close twice', () => {
    expect(failure(() => assertWarrantyClosure({ status: 'ACTIVE', endsOn: '2027-09-01', today: '2027-08-31', openClaims: ['WC-001'] }))).toMatchObject({
      code: 'WARRANTY_NOT_EXPIRED',
      status: 422,
      extensions: { ends_on: '2027-09-01' },
    });
    expect(failure(() => assertWarrantyClosure({ status: 'CLOSED', endsOn: '2027-09-01', today: '2028-01-01', openClaims: [] }))).toMatchObject({
      code: 'WARRANTY_STATE_INVALID',
      status: 409,
      extensions: { status: 'CLOSED' },
    });
  });
});
