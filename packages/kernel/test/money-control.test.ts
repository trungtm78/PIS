import type { DomainError } from '../src/errors';
import {
  advancePosition,
  assertDrawdown,
  assertFinalPaymentClearsAdvance,
  changeFunding,
  classifyChangeOrder,
  contractAvailability,
  eacControl,
  openRiskExpectedValue,
  pctHundredths,
  recoveryTable,
  reserveCover,
  reserveKindOf,
  sharePct,
} from '../src/money-control';
import { DEFAULT_RULE_CODE, MONEY_RULE_DEFAULTS, defaultMoneyRule, parseMoneyRuleParams } from '../src/money-control-policy';

function refusal(work: () => unknown): DomainError {
  try {
    work();
  } catch (error) {
    return error as DomainError;
  }
  throw new Error('expected a refusal');
}

const figures = { currentPriceVnd: '10000000000', originalPriceVnd: '9000000000', requestedTotalVnd: '4000000000', paidTotalVnd: '3000000000', advancePaidVnd: '1000000000', advanceRecoveredVnd: '400000000', pendingIncreaseVnd: '200000000' };
const tier = MONEY_RULE_DEFAULTS.CHANGE_ORDER_TIER;

describe('the policy of the money control is data with built-in defaults (G1-6 to G1-11)', () => {
  it('reads the default as a reading with no version, and refuses parameters that are not as they must be', () => {
    expect(defaultMoneyRule('CHANGE_ORDER_TIER')).toMatchObject({ type: 'CHANGE_ORDER_TIER', code: DEFAULT_RULE_CODE, version: null, source: 'DEFAULT' });
    expect(parseMoneyRuleParams('CHANGE_ORDER_TIER', tier)).toEqual(tier);
    expect(parseMoneyRuleParams('RESERVE_POLICY', { coverAlertBelowPct: '80.5' })).toEqual({ coverAlertBelowPct: '80.5' });
    expect(parseMoneyRuleParams('CONTRACT_AVC', { eacAlertAbovePct: '2' })).toEqual({ eacAlertAbovePct: '2' });
    expect(parseMoneyRuleParams('ADVANCE_RECOVERY', { finalPaymentRequiresFullRecovery: false, toleranceVnd: '10' })).toEqual({ finalPaymentRequiresFullRecovery: false, toleranceVnd: '10' });
    const swapped = { ...tier, bands: [tier.bands[1], tier.bands[0]] };
    expect(refusal(() => parseMoneyRuleParams('CHANGE_ORDER_TIER', swapped)).extensions).toMatchObject({ reason: 'BANDS_NOT_INCREASING' });
    expect(refusal(() => parseMoneyRuleParams('CHANGE_ORDER_TIER', { ...tier, bands: [tier.bands[0]] })).extensions).toMatchObject({ reason: 'TWO_BANDS_REQUIRED' });
    expect(refusal(() => parseMoneyRuleParams('CHANGE_ORDER_TIER', { ...tier, projectAdjustmentPct: '5' })).extensions).toMatchObject({ reason: 'BELOW_SECOND_BAND' });
    expect(refusal(() => parseMoneyRuleParams('CHANGE_ORDER_TIER', { ...tier, requireReserveCover: 'yes' })).extensions).toMatchObject({ reason: 'NOT_A_BOOLEAN' });
    expect(refusal(() => parseMoneyRuleParams('RESERVE_POLICY', { coverAlertBelowPct: '1000' })).extensions).toMatchObject({ reason: 'NOT_A_PERCENT' });
    expect(refusal(() => parseMoneyRuleParams('ADVANCE_RECOVERY', { finalPaymentRequiresFullRecovery: true, toleranceVnd: '-1' })).extensions).toMatchObject({ reason: 'NOT_A_WHOLE_AMOUNT' });
    expect(refusal(() => parseMoneyRuleParams('NOPE' as never, {})).extensions).toMatchObject({ reason: 'UNKNOWN_RULE_TYPE' });
  });
});

describe('the contract against its price in force (G1-6)', () => {
  it('works out what is left to pay and the cash that left, advances not yet recovered included', () => {
    const position = contractAvailability(figures);
    expect(position).toMatchObject({
      approvedVariationVnd: '1000000000',
      advanceOutstandingVnd: '600000000',
      cashOutVnd: '3600000000',
      remainingPayableVnd: '6000000000',
      cashHeadroomVnd: '6400000000',
      withinPrice: true,
      requestedPct: '40.00',
      pendingIncreaseVnd: '200000000',
    });
  });

  it('a price of nothing has no share', () => {
    expect(contractAvailability({ ...figures, currentPriceVnd: '0', requestedTotalVnd: '0', paidTotalVnd: '0', advancePaidVnd: '0', advanceRecoveredVnd: '0' }).requestedPct).toBeNull();
  });

  it('reports a contract that went above its price as not within it', () => {
    expect(contractAvailability({ ...figures, requestedTotalVnd: '10000000001' }).withinPrice).toBe(false);
    expect(contractAvailability({ ...figures, paidTotalVnd: '9500000000', advanceRecoveredVnd: '0' }).withinPrice).toBe(false);
  });
});

describe('the estimate at completion against the approved total investment (G1-6)', () => {
  it('is within when it does not go above, over with the gap when it does, and the alert has a tolerance', () => {
    expect(eacControl('90', '100', '0')).toMatchObject({ verdict: 'WITHIN', overByVnd: '0', raisesAlert: false });
    expect(eacControl('100', '100', '0')).toMatchObject({ verdict: 'WITHIN', raisesAlert: false });
    expect(eacControl('101', '100', '0')).toMatchObject({ verdict: 'OVER', overByVnd: '1', overPct: '1.00', raisesAlert: true });
    expect(eacControl('102', '100', '2')).toMatchObject({ verdict: 'OVER', raisesAlert: false });
    expect(eacControl('103', '100', '2')).toMatchObject({ raisesAlert: true });
    expect(eacControl('5', '0', '0')).toMatchObject({ verdict: 'OVER', overPct: null, raisesAlert: true });
  });
});

describe('the two reserves and the open risks (G1-7)', () => {
  it('names two kinds and recognises only them', () => {
    expect(reserveKindOf('CONTINGENCY')).toBe('CONTINGENCY');
    expect(reserveKindOf('MGMT_RESERVE')).toBe('MGMT_RESERVE');
    expect(reserveKindOf('SLUSH')).toBeUndefined();
  });

  it('the expected value is probability times cost, rounded down once at the end', () => {
    expect(openRiskExpectedValue([])).toBe('0');
    expect(openRiskExpectedValue([{ probabilityPct: '50', costImpactVnd: '1000000000' }, { probabilityPct: '12.5', costImpactVnd: '800000000' }])).toBe('600000000');
    expect(openRiskExpectedValue([{ probabilityPct: '0.01', costImpactVnd: '9999' }])).toBe('0');
  });

  it('the balance covers the expected value or lacks a stated amount, and the alert share is the policy', () => {
    expect(reserveCover('600000000', '600000000', '100')).toMatchObject({ covered: true, shortfallVnd: '0', coverPct: '100.00' });
    expect(reserveCover('500000000', '600000000', '100')).toMatchObject({ covered: false, shortfallVnd: '100000000', coverPct: '83.33' });
    expect(reserveCover('300000000', '600000000', '50')).toMatchObject({ covered: true });
    expect(reserveCover('0', '0', '100')).toMatchObject({ covered: true, coverPct: null });
  });

  it('a drawdown is for a risk or a change order, never both nor neither, above nothing and within the balance', () => {
    expect(assertDrawdown({ amountVnd: '5', balanceVnd: '10', riskId: 'r', changeRequestId: null })).toBe(5n);
    expect(refusal(() => assertDrawdown({ amountVnd: '5', balanceVnd: '10', riskId: null, changeRequestId: null }))).toMatchObject({ code: 'RESERVE_LINK_REQUIRED' });
    expect(refusal(() => assertDrawdown({ amountVnd: '5', balanceVnd: '10', riskId: 'r', changeRequestId: 'c' }))).toMatchObject({ code: 'RESERVE_LINK_REQUIRED' });
    expect(refusal(() => assertDrawdown({ amountVnd: '0', balanceVnd: '10', riskId: 'r', changeRequestId: null }))).toMatchObject({ code: 'VALIDATION_FAILED' });
    const over = refusal(() => assertDrawdown({ amountVnd: '11', balanceVnd: '10', riskId: null, changeRequestId: 'c' }));
    expect(over).toMatchObject({ code: 'RESERVE_BALANCE_INSUFFICIENT', status: 422 });
    expect(over.extensions).toMatchObject({ balance_vnd: '10', exceeds_by_vnd: '1' });
  });
});

describe('the tier of a change order and where an increase is paid from (G1-8)', () => {
  const original = '10000000000';
  it('a small change on a small cumulative variation is tier 1, a larger one tier 2, above the bands tier 3', () => {
    expect(classifyChangeOrder(tier, { deltaVnd: '100000000', approvedCumulativeVnd: '0', originalPriceVnd: original })).toMatchObject({ tier: 1, cumulativePct: '1.00', forcesAdjustment: false, authorityAmountVnd: '100000000' });
    expect(classifyChangeOrder(tier, { deltaVnd: '400000000', approvedCumulativeVnd: '0', originalPriceVnd: original }).tier).toBe(2);
    expect(classifyChangeOrder(tier, { deltaVnd: '100000000', approvedCumulativeVnd: '250000000', originalPriceVnd: original }).tier).toBe(2);
    expect(classifyChangeOrder(tier, { deltaVnd: '600000000', approvedCumulativeVnd: '0', originalPriceVnd: original }).tier).toBe(2);
    expect(classifyChangeOrder(tier, { deltaVnd: '5000000001', approvedCumulativeVnd: '0', originalPriceVnd: original }).tier).toBe(3);
  });

  it('the cumulative variation, not the single change, decides when changes are cut small, and it forces the project adjustment at the threshold', () => {
    const step = classifyChangeOrder(tier, { deltaVnd: '100000000', approvedCumulativeVnd: '900000000', originalPriceVnd: original });
    expect(step).toMatchObject({ tier: 2, cumulativePct: '10.00', forcesAdjustment: true, authorityAmountVnd: '1000000000' });
    expect(classifyChangeOrder(tier, { deltaVnd: '200000000', approvedCumulativeVnd: '900000000', originalPriceVnd: original })).toMatchObject({ tier: 3, cumulativePct: '11.00', forcesAdjustment: true });
    expect(classifyChangeOrder(tier, { deltaVnd: '99999999', approvedCumulativeVnd: '900000000', originalPriceVnd: original }).forcesAdjustment).toBe(false);
  });

  it('a decrease counts by its size and takes from the cumulative variation, an original of nothing leaves only the amounts', () => {
    expect(classifyChangeOrder(tier, { deltaVnd: '-100000000', approvedCumulativeVnd: '300000000', originalPriceVnd: original })).toMatchObject({ cumulativeAfterVnd: '200000000', tier: 1 });
    expect(classifyChangeOrder(tier, { deltaVnd: '5', approvedCumulativeVnd: '0', originalPriceVnd: '0' })).toMatchObject({ tier: 3, cumulativePct: null, forcesAdjustment: true });
    expect(classifyChangeOrder(tier, { deltaVnd: '0', approvedCumulativeVnd: '0', originalPriceVnd: '0' })).toMatchObject({ tier: 1, forcesAdjustment: false });
  });

  it('an increase needs a source, a decrease or the policy that asks none does not', () => {
    expect(changeFunding(tier, { deltaVnd: '-5', approvedDrawdownVnd: '0', adjustmentCleared: false })).toEqual({ needsCover: false, covered: true, coveredBy: null, shortfallVnd: '0' });
    expect(changeFunding({ ...tier, requireReserveCover: false }, { deltaVnd: '5', approvedDrawdownVnd: '0', adjustmentCleared: false }).needsCover).toBe(false);
    expect(changeFunding(tier, { deltaVnd: '100', approvedDrawdownVnd: '40', adjustmentCleared: false })).toEqual({ needsCover: true, covered: false, coveredBy: null, shortfallVnd: '60' });
    expect(changeFunding(tier, { deltaVnd: '100', approvedDrawdownVnd: '100', adjustmentCleared: false })).toMatchObject({ covered: true, coveredBy: 'RESERVE' });
    expect(changeFunding(tier, { deltaVnd: '100', approvedDrawdownVnd: '0', adjustmentCleared: true })).toMatchObject({ covered: true, coveredBy: 'PROJECT_ADJUSTMENT' });
  });
});

describe('the advance against what is left to pay (G1-11)', () => {
  it('owing more than the payments left can recover is flagged with the amount that cannot come back', () => {
    expect(advancePosition('500', '500')).toMatchObject({ exceedsRemaining: false, unrecoverableVnd: '0' });
    expect(advancePosition('501', '500')).toMatchObject({ exceedsRemaining: true, unrecoverableVnd: '1' });
  });

  it('the table puts what the formula says next to what was recovered, then the milestones not reached yet', () => {
    const table = recoveryTable({
      paidVnd: '1000',
      workValueVnd: '10000',
      thresholdPct: '80',
      grossToDateVnd: '2000',
      recoveredVnd: '100',
      events: [
        { requestNo: 'TT-01', on: '2026-03-01', grossCumVnd: '1000', recoveredCumVnd: '50' },
        { requestNo: 'TT-02', on: '2026-04-01', grossCumVnd: '2000', recoveredCumVnd: '100' },
      ],
    });
    expect(table.filter((row) => row.kind === 'ACTUAL')).toEqual([
      { kind: 'ACTUAL', requestNo: 'TT-01', on: '2026-03-01', atPct: null, grossCumVnd: '1000', plannedRecoveredVnd: '125', actualRecoveredVnd: '50', behindVnd: '75' },
      { kind: 'ACTUAL', requestNo: 'TT-02', on: '2026-04-01', atPct: null, grossCumVnd: '2000', plannedRecoveredVnd: '250', actualRecoveredVnd: '100', behindVnd: '150' },
    ]);
    // The threshold is 8000: 25 percent is 2000 (reached), 50 percent is 4000, 75 percent 6000 and 100 percent 8000.
    expect(table.filter((row) => row.kind === 'PLANNED').map((row) => [row.atPct, row.grossCumVnd, row.plannedRecoveredVnd, row.actualRecoveredVnd])).toEqual([
      [50, '4000', '500', null],
      [75, '6000', '750', null],
      [100, '8000', '1000', null],
    ]);
  });

  it('with no payment yet every milestone is planned, and a work value of nothing plans the whole advance at once', () => {
    const none = recoveryTable({ paidVnd: '1000', workValueVnd: '10000', thresholdPct: '80', grossToDateVnd: '0', recoveredVnd: '0', events: [] });
    expect(none.map((row) => row.atPct)).toEqual([25, 50, 75, 100]);
    expect(recoveryTable({ paidVnd: '1000', workValueVnd: '0', thresholdPct: '80', grossToDateVnd: '0', recoveredVnd: '0', events: [] })[0]).toMatchObject({ plannedRecoveredVnd: '1000' });
  });

  it('a final payment is refused while the advance is still owed after its own recovery', () => {
    expect(() => assertFinalPaymentClearsAdvance('0', '0')).not.toThrow();
    expect(() => assertFinalPaymentClearsAdvance('10', '10')).not.toThrow();
    const owed = refusal(() => assertFinalPaymentClearsAdvance('11', '10'));
    expect(owed).toMatchObject({ code: 'FINAL_PAYMENT_ADVANCE_OUTSTANDING', status: 422 });
    expect(owed.extensions).toMatchObject({ outstanding_after_vnd: '11' });
  });
});

describe('percentages as whole numbers', () => {
  it('reads two decimals and refuses what is not a percent, and a share rounds down with its sign', () => {
    expect(pctHundredths('12.5')).toBe(1250n);
    expect(pctHundredths('100')).toBe(10000n);
    expect(refusal(() => pctHundredths('1.234')).code).toBe('VALIDATION_FAILED');
    expect(sharePct(1n, 3n)).toBe('33.33');
    expect(sharePct(-1n, 3n)).toBe('-33.33');
    expect(sharePct(1n, 0n)).toBeNull();
  });
});
