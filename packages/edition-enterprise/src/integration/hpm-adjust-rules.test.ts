import { DomainError } from '@machvon/kernel';
import { assertAdjustable, hpmAdjustmentDecision, hpmAdjustmentLineOf, hpmAdjustmentRequestOf, hpmAdjustmentTotals, nextHpmPeriod } from './hpm-adjust-rules.ts';

const PROPOSER = '22222222-2222-4222-8222-222222222222';
const DECIDER = '33333333-3333-4333-8333-333333333333';

const codeOf = (run: () => unknown): { code?: string; status?: number; detail?: string } => {
  try {
    run();
  } catch (error) {
    if (error instanceof DomainError) return { code: error.code, status: error.status, detail: error.detail };
    throw error;
  }
  return {};
};

const body = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  layout_code: 'HPM_MONTHLY',
  source_period: '2026-M10',
  source_revision: 1,
  subject_code: 'DISBURSED_CUM',
  amount_vnd: '-1500000',
  reason: 'The accepted month counted an invoice twice',
  ...extra,
});

/** TH.01: put a figure of an accepted period right in the next period instead of overwriting it. */
describe('the adjustment in the next period (ENT-3c, TH.01)', () => {
  it('names the next period of the same grain, across the end of a year', () => {
    expect(nextHpmPeriod('2026-M10')).toBe('2026-M11');
    expect(nextHpmPeriod('2026-M12')).toBe('2027-M01');
    expect(nextHpmPeriod('2026-Q3')).toBe('2026-Q4');
    expect(nextHpmPeriod('2026-Q4')).toBe('2027-Q1');
    expect(nextHpmPeriod('2026-H1')).toBe('2026-H2');
    expect(nextHpmPeriod('2026-H2')).toBe('2027-H1');
    expect(nextHpmPeriod('2026')).toBe('2027');
  });

  it('has no next period for a day or for something that is not a period', () => {
    expect(nextHpmPeriod('2026-12-13')).toBeUndefined();
    expect(nextHpmPeriod('2026-M13')).toBeUndefined();
    expect(nextHpmPeriod('next month')).toBeUndefined();
  });

  it('reads a proposal, naming the next period itself so the caller cannot pick another', () => {
    expect(hpmAdjustmentRequestOf(body())).toEqual({
      layoutCode: 'HPM_MONTHLY',
      sourcePeriod: '2026-M10',
      sourceRevision: 1,
      targetPeriod: '2026-M11',
      subjectCode: 'DISBURSED_CUM',
      amountVnd: '-1500000',
      reason: 'The accepted month counted an invoice twice',
    });
    // A target the caller names is not read: the period after the source is the only one there is.
    expect(hpmAdjustmentRequestOf(body({ target_period: '2027-M05' })).targetPeriod).toBe('2026-M11');
  });

  it('refuses a proposal field by field', () => {
    for (const [field, value] of [
      ['layout_code', 'lower'],
      ['source_period', '2026-12-13'],
      ['source_period', 'x'],
      ['source_revision', 0],
      ['source_revision', 1.5],
      ['subject_code', ' bad'],
      ['amount_vnd', '0'],
      ['amount_vnd', '12.5'],
      ['amount_vnd', '-0'],
      ['amount_vnd', 1500],
      ['reason', 'short'],
    ] as const) {
      expect([field, codeOf(() => hpmAdjustmentRequestOf(body({ [field]: value })))]).toEqual([field, { code: 'VALIDATION_FAILED', status: 422, detail: field }]);
    }
  });

  it('is decided by somebody other than the proposer, once, with a reason', () => {
    expect(hpmAdjustmentDecision({ state: 'PROPOSED', proposedBy: PROPOSER }, { decision: 'APPROVE', actorId: DECIDER, reason: 'Checked against the ledger' })).toEqual({ to: 'APPROVED', reason: 'Checked against the ledger' });
    expect(hpmAdjustmentDecision({ state: 'PROPOSED', proposedBy: PROPOSER }, { decision: 'REJECT', actorId: DECIDER, reason: 'The invoice is correct' }).to).toBe('REJECTED');
    expect(codeOf(() => hpmAdjustmentDecision({ state: 'PROPOSED', proposedBy: PROPOSER }, { decision: 'APPROVE', actorId: PROPOSER, reason: 'Checked against the ledger' }))).toMatchObject({ code: 'SELF_APPROVAL_DENIED', status: 403 });
    for (const state of ['APPROVED', 'REJECTED', 'APPLIED'] as const) {
      expect(codeOf(() => hpmAdjustmentDecision({ state, proposedBy: PROPOSER }, { decision: 'APPROVE', actorId: DECIDER, reason: 'Checked against the ledger' }))).toMatchObject({ code: 'HPM_ADJUSTMENT_STATE_INVALID', status: 409 });
    }
    expect(codeOf(() => hpmAdjustmentDecision({ state: 'PROPOSED', proposedBy: PROPOSER }, { decision: 'APPROVE', actorId: DECIDER, reason: 'ok' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'reason' });
    expect(codeOf(() => hpmAdjustmentDecision({ state: 'PROPOSED', proposedBy: PROPOSER }, { decision: 'MAYBE', actorId: DECIDER, reason: 'Checked against the ledger' }))).toMatchObject({ code: 'VALIDATION_FAILED', detail: 'decision' });
  });

  it('is proposed only against the revision the receiver accepted, and only while the next period has not been sent', () => {
    expect(codeOf(() => assertAdjustable({ acceptedRevision: 1, targetAccepted: false }, { sourceRevision: 1 }))).toEqual({});
    expect(codeOf(() => assertAdjustable({ acceptedRevision: undefined, targetAccepted: false }, { sourceRevision: 1 }))).toMatchObject({ code: 'RESOURCE_NOT_FOUND', status: 404 });
    expect(codeOf(() => assertAdjustable({ acceptedRevision: 2, targetAccepted: false }, { sourceRevision: 1 }))).toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
    expect(codeOf(() => assertAdjustable({ acceptedRevision: 1, targetAccepted: true }, { sourceRevision: 1 }))).toMatchObject({ code: 'HPM_ADJUSTMENT_STATE_INVALID', status: 409, detail: 'target_period' });
  });

  it('adds the signed amounts per subject exactly, in whole dong, whatever their size', () => {
    const lines = [
      hpmAdjustmentLineOf({ id: 'a', sourcePeriod: '2026-M10', sourceRevision: 1, subjectCode: 'B', amountVnd: '-1500000' }),
      hpmAdjustmentLineOf({ id: 'b', sourcePeriod: '2026-M10', sourceRevision: 1, subjectCode: 'A', amountVnd: '999999999999999999999' }),
      hpmAdjustmentLineOf({ id: 'c', sourcePeriod: '2026-M09', sourceRevision: 2, subjectCode: 'A', amountVnd: '1' }),
      hpmAdjustmentLineOf({ id: 'd', sourcePeriod: '2026-M09', sourceRevision: 2, subjectCode: 'B', amountVnd: '1500000' }),
    ];
    expect(hpmAdjustmentTotals(lines)).toEqual([
      { subject_code: 'A', amount_vnd: '1000000000000000000000' },
      { subject_code: 'B', amount_vnd: '0' },
    ]);
    expect(hpmAdjustmentTotals([])).toEqual([]);
  });
});
