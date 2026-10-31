import type { DomainError } from '../src/errors';
import { CLAIM_RESPONSE_DAYS, CLAIM_SEVERITIES, COST_BEARERS, assertClaimVerifier, assertWithinWarranty, isResponseOverdue, nextClaimStatus, responseDueOn } from '../src/ast-claim';
import type { ClaimMove } from '../src/ast-claim';
import type { ClaimStatus } from '../src/ast-warranty';

const failure = (work: () => unknown): DomainError => {
  try {
    work();
  } catch (error) {
    return error as DomainError;
  }
  throw new Error('expected a refusal');
};

describe('a warranty claim and the answer to it (ST-AST-004, UAT-AC390, UAT-AC391)', () => {
  it('has the contractor answer within seven days of the report, across the end of a month and of a year', () => {
    expect(CLAIM_RESPONSE_DAYS).toBe(7);
    expect(responseDueOn('2027-01-10')).toBe('2027-01-17');
    expect(responseDueOn('2027-01-28')).toBe('2027-02-04');
    expect(responseDueOn('2027-12-29')).toBe('2028-01-05');
    expect(responseDueOn('2028-02-26')).toBe('2028-03-04');
    expect([CLAIM_SEVERITIES.length, COST_BEARERS.length]).toEqual([3, 4]);
  });

  it('UAT-AC390: takes a claim reported before the last day of the warranty and refuses one from that day on', () => {
    expect(() => assertWithinWarranty('2027-08-31', '2027-09-01')).not.toThrow();
    expect(failure(() => assertWithinWarranty('2027-09-01', '2027-09-01'))).toMatchObject({ code: 'WARRANTY_EXPIRED', status: 422, extensions: { ends_on: '2027-09-01' } });
    expect(failure(() => assertWithinWarranty('2027-09-02', '2027-09-01'))).toMatchObject({ code: 'WARRANTY_EXPIRED' });
  });

  it('UAT-AC391: a claim is overdue the day after its due day, and only while nobody has answered', () => {
    expect(isResponseOverdue('OPEN', '2027-01-17', '2027-01-17')).toBe(false);
    expect(isResponseOverdue('OPEN', '2027-01-17', '2027-01-18')).toBe(true);
    for (const status of ['ACKNOWLEDGED', 'REPAIRING', 'FIXED', 'VERIFIED', 'CLOSED', 'DISPUTED'] as const) expect(isResponseOverdue(status, '2027-01-17', '2027-02-01')).toBe(false);
  });

  it('moves a claim from open to acknowledged to fixed to verified or disputed, and a disputed one back to fixed, by no other way', () => {
    expect(nextClaimStatus('OPEN', 'ACKNOWLEDGE')).toBe('ACKNOWLEDGED');
    for (const from of ['ACKNOWLEDGED', 'REPAIRING', 'DISPUTED'] as const) expect(nextClaimStatus(from, 'FIX')).toBe('FIXED');
    expect(nextClaimStatus('FIXED', 'VERIFY')).toBe('VERIFIED');
    expect(nextClaimStatus('FIXED', 'DISPUTE')).toBe('DISPUTED');
    const all: ClaimStatus[] = ['OPEN', 'ACKNOWLEDGED', 'REPAIRING', 'FIXED', 'VERIFIED', 'CLOSED', 'DISPUTED'];
    const allowed: Record<ClaimMove, ClaimStatus[]> = { ACKNOWLEDGE: ['OPEN'], FIX: ['ACKNOWLEDGED', 'REPAIRING', 'DISPUTED'], VERIFY: ['FIXED'], DISPUTE: ['FIXED'] };
    for (const move of Object.keys(allowed) as ClaimMove[]) {
      for (const from of all.filter((status) => !allowed[move].includes(status))) {
        expect(failure(() => nextClaimStatus(from, move))).toMatchObject({ code: 'CLAIM_STATE_INVALID', status: 409, extensions: { status: from } });
      }
    }
  });

  it('UAT-AC391: the repair is verified by neither the person who reported the defect nor the one who said it was put right', () => {
    expect(() => assertClaimVerifier('c', 'a', 'b')).not.toThrow();
    expect(() => assertClaimVerifier('c', 'a', null)).not.toThrow();
    expect(failure(() => assertClaimVerifier('a', 'a', 'b'))).toMatchObject({ code: 'SELF_APPROVAL_DENIED', status: 403 });
    expect(failure(() => assertClaimVerifier('B', 'a', 'b'))).toMatchObject({ code: 'SELF_APPROVAL_DENIED' });
  });
});
