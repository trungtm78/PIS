import type { DomainError } from '../src/errors';
import {
  LEDGER_ENTRY_KINDS,
  REVERSAL_OF,
  ZERO_BALANCE,
  ZERO_DELTA,
  advanceOutstanding,
  applyDelta,
  assertEntryShape,
  assertLedgerInvariants,
  brokenRule,
  dong,
  isReversal,
  negate,
  totalOf,
} from '../src/pay-ledger';
import type { LedgerBalance, LedgerDelta } from '../src/pay-ledger';

function refusal(work: () => unknown): DomainError {
  try {
    work();
  } catch (error) {
    return error as DomainError;
  }
  throw new Error('expected a refusal');
}

const balance = (overrides: Partial<LedgerBalance> = {}): LedgerBalance => ({ ...ZERO_BALANCE, ...overrides });
const delta = (overrides: Partial<LedgerDelta> = {}): LedgerDelta => ({ ...ZERO_DELTA, ...overrides });

describe('the cumulative ledger (ST-PAY-001)', () => {
  it('knows the kinds of entry and which entry each reversal reverses', () => {
    expect(LEDGER_ENTRY_KINDS).toHaveLength(11);
    expect(LEDGER_ENTRY_KINDS.at(-1)).toBe('ADJUSTMENT');
    expect(Object.keys(REVERSAL_OF).sort()).toEqual(['ADVANCE_RECOVERY_REVERSAL', 'CLAIM_RELEASE', 'PAYMENT_REVERSAL', 'REVOKE_ACCEPTANCE']);
    expect(LEDGER_ENTRY_KINDS.filter(isReversal)).toEqual(['REVOKE_ACCEPTANCE', 'CLAIM_RELEASE', 'PAYMENT_REVERSAL', 'ADVANCE_RECOVERY_REVERSAL']);
    expect(REVERSAL_OF.REVOKE_ACCEPTANCE).toBe('RECOGNIZE_ACCEPTANCE');
  });

  it('reads whole dong only, to 24 digits', () => {
    expect(dong('400000000', 'amount')).toBe(400000000n);
    expect(dong('-5', 'amount')).toBe(-5n);
    for (const bad of ['1.5', '01', '', 'x', '1'.repeat(25)]) expect(refusal(() => dong(bad, 'amount'))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'amount' });
  });

  it('adds an entry to a balance and takes it away again with its negation, without losing a digit', () => {
    const entry = delta({ accepted: '999999999999999999999999', requested: '5', paid: '3', advanceRecovery: '1', retention: '2' });
    const after = applyDelta(balance(), entry);
    expect(after).toEqual({ acceptedVnd: '999999999999999999999999', requestedVnd: '5', paidVnd: '3', advanceRecoveredVnd: '1', retentionHeldVnd: '2' });
    expect(applyDelta(after, negate(entry))).toEqual(ZERO_BALANCE);
    expect(negate(ZERO_DELTA)).toEqual(ZERO_DELTA);
  });

  it('UAT-AC321: names the first rule of the ledger a balance breaks', () => {
    expect(brokenRule(balance({ acceptedVnd: '10', requestedVnd: '10', paidVnd: '10', advanceRecoveredVnd: '4', retentionHeldVnd: '6' }))).toBeUndefined();
    expect(brokenRule(balance({ acceptedVnd: '-1' }))).toBe('NONNEGATIVE');
    expect(brokenRule(balance({ acceptedVnd: '10', requestedVnd: '11' }))).toBe('REQUESTED_LE_ACCEPTED');
    expect(brokenRule(balance({ acceptedVnd: '10', requestedVnd: '10', paidVnd: '11' }))).toBe('PAID_LE_REQUESTED');
    expect(brokenRule(balance({ acceptedVnd: '10', requestedVnd: '10', advanceRecoveredVnd: '6', retentionHeldVnd: '5' }))).toBe('DEDUCTIONS_LE_REQUESTED');
    expect(brokenRule(balance({ acceptedVnd: '10', requestedVnd: '10', paidVnd: '3', advanceRecoveredVnd: '1', retentionHeldVnd: '-1' }))).toBe('NONNEGATIVE');
  });

  it('refuses a balance that breaks a rule as 409 VALUE_EXCEEDED, with the rule and the figures', () => {
    expect(() => assertLedgerInvariants(balance({ acceptedVnd: '10', requestedVnd: '10' }))).not.toThrow();
    const error = refusal(() => assertLedgerInvariants(balance({ acceptedVnd: '2000000000', requestedVnd: '2000000001' })));
    expect(error).toMatchObject({ code: 'VALUE_EXCEEDED', status: 409, extensions: { rule: 'REQUESTED_LE_ACCEPTED', accepted_vnd: '2000000000', requested_vnd: '2000000001' } });
  });

  it('holds the signs of an entry to its kind', () => {
    expect(() => assertEntryShape('RECOGNIZE_ACCEPTANCE', delta({ accepted: '5' }), null)).not.toThrow();
    expect(() => assertEntryShape('REVOKE_ACCEPTANCE', delta({ accepted: '-5' }), 'e')).not.toThrow();
    expect(() => assertEntryShape('RETENTION_RELEASE', delta({ retention: '-3' }), null)).not.toThrow();
    expect(() => assertEntryShape('RETENTION_HOLD', delta({ retention: '3' }), null)).not.toThrow();
    expect(refusal(() => assertEntryShape('RECOGNIZE_ACCEPTANCE', delta({ accepted: '-5' }), null))).toMatchObject({ detail: 'delta' });
    expect(refusal(() => assertEntryShape('RETENTION_HOLD', delta({ retention: '-1' }), null))).toMatchObject({ detail: 'delta' });
    expect(refusal(() => assertEntryShape('REVOKE_ACCEPTANCE', delta({ accepted: '5' }), 'e'))).toMatchObject({ detail: 'delta' });
    expect(refusal(() => assertEntryShape('REVOKE_ACCEPTANCE', delta({ accepted: '-5' }), null))).toMatchObject({ detail: 'reversal_of_id' });
    expect(refusal(() => assertEntryShape('CLAIM', delta({ requested: '5' }), 'e'))).toMatchObject({ detail: 'reversal_of_id' });
  });

  it('AC-ST-CTR-016-1: lets an adjustment move the accepted amount either way, and nothing else, without reversing an entry', () => {
    expect(() => assertEntryShape('ADJUSTMENT', delta({ accepted: '50' }), null)).not.toThrow();
    expect(() => assertEntryShape('ADJUSTMENT', delta({ accepted: '-50' }), null)).not.toThrow();
    expect(isReversal('ADJUSTMENT')).toBe(false);
    expect(refusal(() => assertEntryShape('ADJUSTMENT', delta(), null))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'delta' });
    for (const field of ['requested', 'paid', 'advanceRecovery', 'retention'] as const) {
      expect(refusal(() => assertEntryShape('ADJUSTMENT', delta({ accepted: '5', [field]: '1' }), null))).toMatchObject({ detail: 'delta' });
      expect(refusal(() => assertEntryShape('ADJUSTMENT', delta({ accepted: '5', [field]: '-1' }), null))).toMatchObject({ detail: 'delta' });
    }
    expect(refusal(() => assertEntryShape('ADJUSTMENT', delta({ accepted: '5' }), 'e'))).toMatchObject({ detail: 'reversal_of_id' });
  });

  it('counts the advance still to be recovered, never below zero, and adds balances together', () => {
    expect(advanceOutstanding('1000', '300')).toBe('700');
    expect(advanceOutstanding('1000', '1200')).toBe('0');
    expect(totalOf([])).toEqual(ZERO_BALANCE);
    expect(totalOf([balance({ acceptedVnd: '5', requestedVnd: '2' }), balance({ acceptedVnd: '7', paidVnd: '1', advanceRecoveredVnd: '1', retentionHeldVnd: '1' })])).toEqual({
      acceptedVnd: '12',
      requestedVnd: '2',
      paidVnd: '1',
      advanceRecoveredVnd: '1',
      retentionHeldVnd: '1',
    });
  });
});
