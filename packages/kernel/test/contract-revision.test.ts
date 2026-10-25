import type { DomainError } from '../src/errors';
import {
  CHANGE_DECISIONS,
  assertNotRetroactive,
  assertValueAboveFloor,
  assertFollowsRevision,
  changeDecisionOf,
  valueAfterChange,
  valueFloorVnd,
} from '../src/contract-revision';
import type { ValueLedger } from '../src/contract-revision';

const ledger = (overrides: Partial<ValueLedger> = {}): ValueLedger => ({ acceptedTotalVnd: '3000000000', advancePaidVnd: '0', paidTotalVnd: '0', advanceRecoveredVnd: '0', ...overrides });

function refusal(work: () => void): DomainError {
  try {
    work();
  } catch (error) {
    return error as DomainError;
  }
  throw new Error('expected a refusal');
}

describe('the value floor of a contract (BR-CTR-06)', () => {
  it('is what was accepted, or what was paid net of the advance recovered when that is more', () => {
    expect(valueFloorVnd(ledger())).toBe('3000000000');
    expect(valueFloorVnd(ledger({ advancePaidVnd: '1000000000', paidTotalVnd: '2500000000', advanceRecoveredVnd: '200000000' }))).toBe('3300000000');
    expect(valueFloorVnd(ledger({ acceptedTotalVnd: '0' }))).toBe('0');
    expect(valueFloorVnd(ledger({ advancePaidVnd: '500', paidTotalVnd: '2999999500', advanceRecoveredVnd: '0' }))).toBe('3000000000');
  });

  it('AC-ST-CTR-007-1, UAT-AC308: refuses a value below the floor, with both figures, and accepts the floor itself', () => {
    const error = refusal(() => assertValueAboveFloor('2500000000', ledger()));
    expect(error).toMatchObject({ code: 'ACCEPTANCE_VALUE_EXCEEDS_CONTRACT', status: 422, detail: 'approved_delta_vnd', extensions: { new_value_vnd: '2500000000', floor_vnd: '3000000000', accepted_total_vnd: '3000000000' } });
    expect(() => assertValueAboveFloor('3000000000', ledger())).not.toThrow();
    expect(() => assertValueAboveFloor('10500000000', ledger())).not.toThrow();
    expect(refusal(() => assertValueAboveFloor('3299999999', ledger({ advancePaidVnd: '1000000000', paidTotalVnd: '2500000000', advanceRecoveredVnd: '200000000' }))).extensions).toMatchObject({ floor_vnd: '3300000000' });
  });
});

describe('the day a change takes effect', () => {
  it('AC-ST-CTR-007-2, UAT-AC58: is not before the day it is approved', () => {
    expect(refusal(() => assertNotRetroactive('2026-06-01', '2026-07-20'))).toMatchObject({ code: 'RETROACTIVE_NOT_ALLOWED', status: 422, detail: 'effective_on', extensions: { effective_on: '2026-06-01', approved_on: '2026-07-20' } });
    expect(() => assertNotRetroactive('2026-07-20', '2026-07-20')).not.toThrow();
    expect(() => assertNotRetroactive('2026-08-01', '2026-07-20')).not.toThrow();
  });

  it('begins after the revision it follows, never on its first day or before it', () => {
    expect(refusal(() => assertFollowsRevision('2026-08-01', '2026-08-01'))).toMatchObject({ code: 'VALIDATION_FAILED', status: 422, detail: 'effective_on', extensions: { reason: 'NOT_AFTER_REVISION', after: '2026-08-01' } });
    expect(() => assertFollowsRevision('2026-07-31', '2026-08-01')).toThrow();
    expect(() => assertFollowsRevision('2026-08-02', '2026-08-01')).not.toThrow();
  });
});

describe('the decision of a change order', () => {
  it('is to approve, return or reject; anything else is none', () => {
    expect([...CHANGE_DECISIONS]).toEqual(['approve', 'return', 'reject']);
    expect(changeDecisionOf('approve')).toBe('approve');
    expect(changeDecisionOf('REJECT')).toBeUndefined();
    expect(changeDecisionOf(undefined)).toBeUndefined();
  });

  it('adds the delta to the value, up or down, exactly', () => {
    expect(valueAfterChange('10000000000', '500000000')).toBe('10500000000');
    expect(valueAfterChange('10500000000', '-8000000000')).toBe('2500000000');
    expect(valueAfterChange('10000000000', '0')).toBe('10000000000');
  });

});
