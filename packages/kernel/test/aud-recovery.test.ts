import { DomainError } from '../src/errors.ts';
import { MANUAL_SOURCE_KINDS, PAY_RECOVERY_KINDS, RECOVERY_SOURCE_KINDS, assertWithinRecommendation, rateOf, readRecordedRecovery, readReversedRecovery, remaining, reopensOnReversal } from '../src/aud-recovery.ts';

const refusal = (work: () => unknown): DomainError => {
  try {
    work();
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    return error as DomainError;
  }
  throw new Error('expected a refusal');
};

const RECOVERY = '00000000-0000-4000-8000-0000000000a1';
const RECOMMENDATION = '00000000-0000-4000-8000-0000000000b2';

describe('the ledger of recoveries of a recommendation (AUD 3.4, BR-AUD-01, BR-AUD-02)', () => {
  it('names the sources of a line, the ones PAY owns and the ones a person may enter', () => {
    expect(new Set(RECOVERY_SOURCE_KINDS).size).toBe(4);
    expect(PAY_RECOVERY_KINDS).toEqual({ RECOVERY: 'PAY_RECOVERY', DEDUCTION: 'PAY_DEDUCTION' });
    expect([...MANUAL_SOURCE_KINDS]).toEqual(['TREASURY_REMITTANCE', 'MANUAL_EVIDENCE']);
  });

  it('AC-ST-AUD-004-1: 500,000,000 and 300,000,000 recovered of 800,000,000 leave nothing; one more dong is 409 RECOVERY_EXCEEDS_RECOMMENDATION', () => {
    expect(() => assertWithinRecommendation({ amountVnd: '800000000', recoveredVnd: '500000000' }, '300000000')).not.toThrow();
    expect(remaining({ amountVnd: '800000000', recoveredVnd: '800000000' })).toBe('0');
    const error = refusal(() => assertWithinRecommendation({ amountVnd: '800000000', recoveredVnd: '800000000' }, '1'));
    expect([error.status, error.code, error.detail]).toEqual([409, 'RECOVERY_EXCEEDS_RECOMMENDATION', 'amount_vnd']);
  });

  it('AC-ST-AUD-004-2: 80,000,000 on a recommendation of 400,000,000 with 300,000,000 recovered fits once and the second is refused with the figures; a reversal takes it back', () => {
    expect(() => assertWithinRecommendation({ amountVnd: '400000000', recoveredVnd: '300000000' }, '80000000')).not.toThrow();
    const error = refusal(() => assertWithinRecommendation({ amountVnd: '400000000', recoveredVnd: '380000000' }, '80000000'));
    expect(error.extensions).toEqual({ amount_vnd: '400000000', recovered_vnd: '380000000', line_vnd: '80000000', remaining_vnd: '20000000', excess_vnd: '60000000' });
    // a line of the opposite sign always fits while something was recovered
    expect(() => assertWithinRecommendation({ amountVnd: '400000000', recoveredVnd: '380000000' }, '-80000000')).not.toThrow();
  });

  it('never leaves less than nothing to recover, and adds up beyond the range of a double', () => {
    expect(remaining({ amountVnd: '100', recoveredVnd: '250' })).toBe('0');
    const big = '9'.repeat(24);
    expect(() => assertWithinRecommendation({ amountVnd: big, recoveredVnd: '0' }, big)).not.toThrow();
    expect(refusal(() => assertWithinRecommendation({ amountVnd: big, recoveredVnd: big }, '1')).extensions?.excess_vnd).toBe('1');
  });
});

describe('the rate of completion with its numerator and its denominator (BR-AUD-04)', () => {
  it('AC-ST-AUD-004-1: 800,000,000 of 800,000,000 is 100.00 percent, with both figures', () => {
    expect(rateOf('800000000', '800000000')).toEqual({ numerator: '800000000', denominator: '800000000', percent: '100.00' });
  });

  it('rounds half up to two decimals of a percent, and is not applicable (not 0 percent) when nothing was recommended', () => {
    expect(rateOf('1', '3')).toEqual({ numerator: '1', denominator: '3', percent: '33.33' });
    expect(rateOf('2', '3').percent).toBe('66.67');
    expect(rateOf('1', '8').percent).toBe('12.50');
    expect(rateOf('1', '16').percent).toBe('6.25');
    expect(rateOf('1', '1600').percent).toBe('0.06');
    expect(rateOf('1', '800').percent).toBe('0.13');
    expect(rateOf('0', '5').percent).toBe('0.00');
    expect(rateOf('0', '0')).toEqual({ numerator: '0', denominator: '0', percent: null });
    expect(rateOf('5', '0').percent).toBeNull();
    expect(rateOf('9'.repeat(24), '9'.repeat(24)).percent).toBe('100.00');
  });
});

describe('what a PAY event says of a recovery', () => {
  const payload = { recovery_id: RECOVERY, audit_recommendation_id: RECOMMENDATION, amount_vnd: '500000000', kind: 'RECOVERY', recorded_on: '2026-10-20' };

  it('reads the recorded and the reversed event, the kind as the source of the line, the ids in lower case', () => {
    expect(readRecordedRecovery(payload)).toEqual({ recoveryId: RECOVERY, recommendationId: RECOMMENDATION, amountVnd: '500000000', sourceKind: 'PAY_RECOVERY', day: '2026-10-20' });
    expect(readRecordedRecovery({ ...payload, kind: 'DEDUCTION', recovery_id: RECOVERY.toUpperCase() })).toMatchObject({ sourceKind: 'PAY_DEDUCTION', recoveryId: RECOVERY });
    const rest = { recovery_id: payload.recovery_id, audit_recommendation_id: payload.audit_recommendation_id, amount_vnd: payload.amount_vnd, kind: payload.kind };
    expect(readReversedRecovery({ ...rest, reversed_on: '2026-10-21' })).toEqual({ recoveryId: RECOVERY, recommendationId: RECOMMENDATION, amountVnd: '500000000', sourceKind: 'PAY_RECOVERY', day: '2026-10-21' });
  });

  it('refuses a payload that does not read with 422 VALIDATION_FAILED naming the field', () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ ...payload, recovery_id: 'x' }, 'recovery_id'],
      [{ ...payload, audit_recommendation_id: undefined }, 'audit_recommendation_id'],
      [{ ...payload, amount_vnd: '0' }, 'amount_vnd'],
      [{ ...payload, amount_vnd: '12.5' }, 'amount_vnd'],
      [{ ...payload, amount_vnd: 500 }, 'amount_vnd'],
      [{ ...payload, kind: 'GIFT' }, 'kind'],
      [{ ...payload, kind: undefined }, 'kind'],
      [{ ...payload, recorded_on: '2026-13-01' }, 'recorded_on'],
      [{ ...payload, recorded_on: '20 Oct' }, 'recorded_on'],
      [{ ...payload, recorded_on: 3 }, 'recorded_on'],
    ];
    for (const [bad, field] of cases) {
      const error = refusal(() => readRecordedRecovery(bad));
      expect([error.status, error.code, error.detail]).toEqual([422, 'VALIDATION_FAILED', field]);
    }
    expect(refusal(() => readReversedRecovery({ ...payload })).detail).toBe('reversed_on');
    expect(refusal(() => readReversedRecovery({ ...payload, kind: 'x', reversed_on: '2026-10-21' })).detail).toBe('kind');
  });
});

describe('the reopening of a closed recommendation (AUD 3.4)', () => {
  it('AC-ST-AUD-004-3: a closed recommendation with less recovered than recommended goes back to work', () => {
    expect(reopensOnReversal({ status: 'CLOSED', amountVnd: '800000000', recoveredVnd: '500000000', disputeAccepted: false })).toBe(true);
  });

  it('does not reopen one that is not closed, one that is still fully recovered, or one closed on an accepted dispute', () => {
    expect(reopensOnReversal({ status: 'IN_PROGRESS', amountVnd: '800000000', recoveredVnd: '500000000', disputeAccepted: false })).toBe(false);
    expect(reopensOnReversal({ status: 'CLOSED', amountVnd: '800000000', recoveredVnd: '800000000', disputeAccepted: false })).toBe(false);
    expect(reopensOnReversal({ status: 'CLOSED', amountVnd: '800000000', recoveredVnd: '300000000', disputeAccepted: true })).toBe(false);
  });
});
