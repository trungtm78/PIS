import { DomainError } from '../src/errors.ts';
import type { StoredFigure } from '../src/fnd-actuals.ts';
import { assertResolverIsNotPreparer, assertYearMayClose, currentAsOf, officialActual, periodHistory, varianceExplanation, varianceOf } from '../src/fnd-actuals.ts';
import {
  assertCumulativeIdentity,
  assertEstimateAllowed,
  assertGrainSum,
  assertNegativeExplained,
  assertPhasing,
  assertSubsetWithinParent,
  cumulativeOf,
  deriveActuals,
  nonNegativeVnd,
  signedVnd,
} from '../src/fnd-checks.ts';
import { figureRowsOf, snapshotHashFor } from '../src/fnd-snapshot.ts';
import type { SnapshotFigure } from '../src/fnd-snapshot.ts';
import { builtInPack } from '../src/fnd-taxonomy.ts';
import { cellFigures } from '../src/fnd-figures.ts';

const fails = (run: () => unknown, code: string, status: number, detail?: string): void => {
  try {
    run();
  } catch (failure) {
    expect(failure).toBeInstanceOf(DomainError);
    expect(failure).toMatchObject({ code, status, ...(detail === undefined ? {} : { detail }) });
    return;
  }
  throw new Error(`expected ${code}`);
};

let counter = 0;
const fig = (over: Partial<StoredFigure> & Pick<StoredFigure, 'kind' | 'amountVnd'>): StoredFigure => {
  counter += 1;
  return { id: `c-${counter}`, classCode: 'EQUITY', tierCode: 'ALL', measure: 'DISBURSED', grain: 'MONTH', planYear: 2026, ordinal: 3, basis: 'REPORTED', asOfDate: '2026-04-01', revision: 1, status: 'ACCEPTED', ...over };
};

describe('identities checked when a figure is written (8, I4)', () => {
  it('I-CUM: the year to date is the one before plus the actual; the first month is its own actual (422 CUMULATIVE_IDENTITY_BROKEN)', () => {
    assertCumulativeIdentity({ previousYtdVnd: '100', actualVnd: '50', ytdVnd: '150' });
    assertCumulativeIdentity({ previousYtdVnd: null, actualVnd: '50', ytdVnd: '50' });
    assertCumulativeIdentity({ previousYtdVnd: '100', actualVnd: '-30', ytdVnd: '70' });
    fails(() => assertCumulativeIdentity({ previousYtdVnd: '100', actualVnd: '50', ytdVnd: '151' }), 'CUMULATIVE_IDENTITY_BROKEN', 422, 'cumulative_vnd');
  });

  it('entry mode CUMULATIVE_ENTRY derives the actual as deltaOf does (null when nothing is before, a fall kept); PERIOD_ENTRY makes the first month its own actual', () => {
    const entries = [{ ordinal: 1, cumulativeVnd: '100' }, { ordinal: 2, cumulativeVnd: '250' }, { ordinal: 3, cumulativeVnd: '200' }, { ordinal: 5, cumulativeVnd: '300' }];
    expect(deriveActuals('CUMULATIVE_ENTRY', entries)).toEqual([{ ordinal: 1, actualVnd: null }, { ordinal: 2, actualVnd: '150' }, { ordinal: 3, actualVnd: '-50' }, { ordinal: 5, actualVnd: null }]);
    expect(deriveActuals('PERIOD_ENTRY', entries)[0]).toEqual({ ordinal: 1, actualVnd: '100' });
    expect(cumulativeOf([{ ordinal: 2, actualVnd: '5' }, { ordinal: 1, actualVnd: '10' }])).toEqual([{ ordinal: 1, cumulativeVnd: '10' }, { ordinal: 2, cumulativeVnd: '15' }]);
  });

  it('Σ months = quarter when both exist (422 GRAIN_SUM_MISMATCH); a quarter with fewer than three months is not judged', () => {
    assertGrainSum({ quarterVnd: '60', monthVnds: ['10', '20', '30'] });
    assertGrainSum({ quarterVnd: '60', monthVnds: ['10', null, '30'] });
    assertGrainSum({ quarterVnd: null, monthVnds: ['1', '2', '3'] });
    fails(() => assertGrainSum({ quarterVnd: '61', monthVnds: ['10', '20', '30'] }), 'GRAIN_SUM_MISMATCH', 422, 'quarter_vnd');
  });

  it('with phasing_must_sum the four quarters add up to the year plan in force (422 PHASING_SUM_MISMATCH) and the months of a quarter to the quarter; without the rule nothing is judged', () => {
    const quarters = new Map([[1, '25'], [2, '25'], [3, '25'], [4, '25']]);
    assertPhasing(true, { planInForceVnd: '100', quarters, months: new Map() });
    assertPhasing(true, { planInForceVnd: '100', quarters: new Map([[1, '25']]), months: new Map() });
    assertPhasing(false, { planInForceVnd: '100', quarters: new Map([[1, '1'], [2, '1'], [3, '1'], [4, '1']]), months: new Map() });
    fails(() => assertPhasing(true, { planInForceVnd: '101', quarters, months: new Map() }), 'PHASING_SUM_MISMATCH', 422, 'quarters');
    fails(() => assertPhasing(true, { planInForceVnd: null, quarters, months: new Map() }), 'PHASING_SUM_MISMATCH', 422);
    assertPhasing(true, { planInForceVnd: '100', quarters, months: new Map([[1, '10'], [2, '10'], [3, '5']]) });
    fails(() => assertPhasing(true, { planInForceVnd: '100', quarters, months: new Map([[1, '10'], [2, '10'], [3, '6']]) }), 'GRAIN_SUM_MISMATCH', 422, 'months');
  });

  it('I3: an estimate after the actual is refused (422 ESTIMATE_AFTER_ACTUAL); a subset above its parent is 422 SUBSET_EXCEEDS_PARENT; a negative actual needs an explanation', () => {
    assertEstimateAllowed(false);
    fails(() => assertEstimateAllowed(true), 'ESTIMATE_AFTER_ACTUAL', 422);
    assertSubsetWithinParent('100', '100');
    fails(() => assertSubsetWithinParent('100', '101'), 'SUBSET_EXCEEDS_PARENT', 422, 'subset_vnd');
    assertNegativeExplained('5', null);
    assertNegativeExplained('-5', 'a reversal booked by the accounting division');
    fails(() => assertNegativeExplained('-5', 'short'), 'NEGATIVE_DELTA_EXPLANATION_REQUIRED', 422);
    fails(() => assertNegativeExplained('-5', null), 'NEGATIVE_DELTA_EXPLANATION_REQUIRED', 422);
  });

  it('money is whole dong as text: no sign for a plan, a sign for a reversal, never a float or a separator', () => {
    expect(nonNegativeVnd('0', 'a')).toBe('0');
    expect(signedVnd('-12', 'a')).toBe('-12');
    for (const value of ['-1', '1.5', '1,000', '', '01', '1e3', ' 1']) fails(() => nonNegativeVnd(value, 'amount_vnd'), 'VALIDATION_FAILED', 422, 'amount_vnd');
    fails(() => signedVnd('--1', 'a'), 'VALIDATION_FAILED', 422);
  });
});

describe('variance between the report and the books (6.4)', () => {
  const tolerance = { pct: 1, absVnd: 1_000_000 };

  it('needs an explanation above the larger of the floor and the percent of the books figure, and not at or below it', () => {
    expect(varianceOf('100000000', '100000000', tolerance)).toMatchObject({ varianceVnd: '0', needsExplanation: false });
    // 1 percent of 1,000,000,000 is 10,000,000: the floor of 1,000,000 is smaller.
    expect(varianceOf('1010000000', '1000000000', tolerance)).toMatchObject({ varianceVnd: '10000000', thresholdVnd: '10000000', needsExplanation: false });
    expect(varianceOf('1010000001', '1000000000', tolerance).needsExplanation).toBe(true);
    // For a small figure the floor of 1,000,000 governs.
    expect(varianceOf('5000000', '4000001', tolerance).needsExplanation).toBe(false);
    expect(varianceOf('5000001', '4000000', tolerance).needsExplanation).toBe(true);
    expect(varianceOf('3000001', '4000001', tolerance).needsExplanation).toBe(false);
    expect(varianceOf('3000000', '4000001', tolerance).needsExplanation).toBe(true);
  });

  it('a source with no figure gives no variance (not zero)', () => {
    expect(varianceOf(null, '5', tolerance)).toEqual({ varianceVnd: null, thresholdVnd: null, needsExplanation: false });
    expect(varianceOf('5', null, tolerance).needsExplanation).toBe(false);
  });

  it('the explanation is 20 to 2000 characters; the resolver is not the preparer; an unresolved variance blocks the close of the year', () => {
    expect(varianceExplanation('  the accrual of March was booked in April  ')).toBe('the accrual of March was booked in April');
    fails(() => varianceExplanation('too short'), 'ACTUALS_VARIANCE_UNEXPLAINED', 422, 'explanation');
    fails(() => varianceExplanation(undefined), 'ACTUALS_VARIANCE_UNEXPLAINED', 422);
    fails(() => varianceExplanation('x'.repeat(2001)), 'ACTUALS_VARIANCE_UNEXPLAINED', 422);
    assertResolverIsNotPreparer('b', 'a');
    assertResolverIsNotPreparer('b', null);
    fails(() => assertResolverIsNotPreparer('a', 'a'), 'SELF_APPROVAL_DENIED', 403);
    assertYearMayClose(0);
    fails(() => assertYearMayClose(2), 'YEAR_CLOSE_BLOCKED_BY_VARIANCE', 409, 'plan_year');
  });
});

describe('the transition history of a period (7.3)', () => {
  it('lists the estimate revisions in knowledge-date order, then the actual, each linked to what it replaced, with the changes', () => {
    const history = periodHistory([
      fig({ kind: 'ACTUAL', amountVnd: '125', asOfDate: '2026-04-05', convertedFromId: 'e3', estimateAmountVnd: '130', conversionReason: 'PERIOD_ACTUAL_IN' }),
      fig({ id: 'e2', kind: 'ESTIMATE', amountVnd: '120', asOfDate: '2026-03-25', revision: 2, status: 'SUPERSEDED' }),
      fig({ id: 'e1', kind: 'ESTIMATE', amountVnd: '100', asOfDate: '2026-03-10', revision: 1, status: 'SUPERSEDED' }),
      fig({ id: 'e3', kind: 'ESTIMATE', amountVnd: '130', asOfDate: '2026-04-02', revision: 3, status: 'SUPERSEDED' }),
      fig({ kind: 'ESTIMATE', amountVnd: '999', asOfDate: '2026-04-03', revision: 4, status: 'DRAFT' }),
    ]);
    expect(history.map((entry) => [entry.kind, entry.amountVnd, entry.changeVnd])).toEqual([['ESTIMATE', '100', null], ['ESTIMATE', '120', '20'], ['ESTIMATE', '130', '10'], ['ACTUAL', '125', null]]);
    expect(history[3]).toMatchObject({ convertedFromId: 'e3', estimateAmountVnd: '130', conversionReason: 'PERIOD_ACTUAL_IN', conversionDeltaVnd: '-5' });
  });

  it('reads the current figure as of a day from the ever-accepted revisions', () => {
    const figures = [fig({ id: 'a', kind: 'ACTUAL', amountVnd: '1', asOfDate: '2026-01-01', status: 'SUPERSEDED' }), fig({ id: 'b', kind: 'ACTUAL', amountVnd: '2', asOfDate: '2026-02-01', revision: 2 })];
    expect(currentAsOf(figures, '2026-01-15')?.id).toBe('a');
    expect(currentAsOf(figures, '2026-02-01')?.id).toBe('b');
    expect(currentAsOf(figures, '2025-12-31')).toBeUndefined();
  });

  it('the official actual of a month adds the adjustments that count in the view and says which bases went into it', () => {
    const figures = [fig({ kind: 'ACTUAL', amountVnd: '100' }), fig({ kind: 'ACTUAL', amountVnd: '7', basis: 'ADJUSTMENT', ordinal: 5, adjusts: { planYear: 2026, ordinal: 3 }, asOfDate: '2026-06-01' })];
    const input = { figures, asOf: '2026-12-31', precedence: 'REPORTED_UNTIL_RECONCILED' as const, yearClosed: false, planYear: 2026, ordinal: 3 };
    expect(officialActual({ ...input, view: 'AS_REPORTED' })).toMatchObject({ amountVnd: '100', bases: ['REPORTED'] });
    expect(officialActual({ ...input, view: 'RESTATED' })).toMatchObject({ amountVnd: '107', bases: ['REPORTED', 'ADJUSTMENT'] });
    expect(officialActual({ ...input, ordinal: 5, view: 'AS_REPORTED' })).toMatchObject({ amountVnd: '7', bases: ['ADJUSTMENT'] });
  });
});

describe('the snapshot of a closed period (6.5)', () => {
  const header = { periodId: 'p1', snapshotKind: 'PERIOD_CLOSE', asOfDate: '2026-03-31', treasuryCutoffDate: '2026-03-31', metricSetVersion: 'DIS-METRICS-R1-PROPOSED', definitionStatus: 'PROPOSED_PENDING_SIGNOFF' };
  const line = (projectId: string, bucket: string): { projectId: string; unitId: string; bucket: string; budgetLevel: string; amount: string } => ({ projectId, unitId: 'u', bucket, budgetLevel: 'ALL', amount: '1' });
  const figure = (over: Partial<SnapshotFigure> = {}): SnapshotFigure => ({ projectId: 'p', unitId: 'u', classCode: 'EQUITY', tierCode: 'ALL', measure: 'DISBURSED', figureKind: 'ACTUAL', grain: 'MONTH', planYear: 2026, ordinal: 3, amountVnd: '5', nullReason: null, basis: 'REPORTED', sourceFigureId: null, ...over });
  const extras = (figures: SnapshotFigure[]) => ({ taxonomyPack: 'ENTERPRISE', taxonomyVersion: 1, actualsPrecedence: 'REPORTED_UNTIL_RECONCILED', figures });

  it('does not depend on the order lines and figures were read in, and a changed figure changes the hash', () => {
    const lines = [line('a', 'X'), line('b', 'X')];
    expect(snapshotHashFor(1, header, lines)).toBe(snapshotHashFor(1, header, [...lines].reverse()));
    const one = [figure({ ordinal: 1 }), figure({ ordinal: 2 })];
    expect(snapshotHashFor(2, header, lines, extras(one))).toBe(snapshotHashFor(2, header, lines, extras([...one].reverse())));
    expect(snapshotHashFor(2, header, lines, extras(one))).not.toBe(snapshotHashFor(2, header, lines, extras([figure({ ordinal: 1 }), figure({ ordinal: 2, amountVnd: '6' })])));
  });

  it('the two schemas never give the same hash for the same lines; schema 2 needs its extras', () => {
    const lines = [line('a', 'X')];
    expect(snapshotHashFor(1, header, lines)).not.toBe(snapshotHashFor(2, header, lines, extras([])));
    expect(() => snapshotHashFor(2, header, lines)).toThrow('hash schema 2');
    expect(snapshotHashFor(2, header, lines, extras([]))).not.toBe(snapshotHashFor(2, header, lines, { ...extras([]), taxonomyVersion: 2 }));
    expect(snapshotHashFor(2, header, lines, extras([]))).not.toBe(snapshotHashFor(2, header, lines, { ...extras([]), actualsPrecedence: 'TREASURY_HEADLINE' }));
  });

  it('writes one row for each figure of a cell, a figure nobody has with its reason, and the stored figure it came from', () => {
    const pack = builtInPack('ENTERPRISE');
    const figures = [fig({ id: 'plan-1', kind: 'PLAN_YEAR', grain: 'YEAR', ordinal: 0, amountVnd: '1000' }), fig({ id: 'act-3', kind: 'ACTUAL', amountVnd: '125' })];
    const query = { period: { grain: 'MONTH' as const, planYear: 2026, ordinal: 3 }, asOf: '2026-04-10', measure: 'DISBURSED' as const, view: 'AS_REPORTED' as const };
    const book = { pack, figures, tmdt: [], yearsClosed: new Set<number>() };
    const cells = pack.classes.flatMap((one) => pack.tiers.map((tier) => cellFigures(book, one.code, tier.code, query)));
    const rows = figureRowsOf({ projectId: 'p', unitId: 'u' }, { projectId: 'p', cells, tmdtInForce: null }, query);
    const equity = rows.filter((row) => row.classCode === 'EQUITY');
    expect(equity.find((row) => row.figureKind === 'PLAN_YEAR')).toMatchObject({ amountVnd: '1000', sourceFigureId: 'plan-1', nullReason: null });
    expect(equity.find((row) => row.figureKind === 'ACTUAL')).toMatchObject({ amountVnd: '125', basis: 'REPORTED', sourceFigureId: 'act-3' });
    expect(equity.find((row) => row.figureKind === 'PLAN_ADJUSTED')).toMatchObject({ amountVnd: null, nullReason: 'NO_DATA' });
    expect(rows.filter((row) => row.classCode === 'LOAN' && row.figureKind === 'ACTUAL')[0]).toMatchObject({ amountVnd: null, nullReason: 'NO_DATA' });
    expect(new Set(rows.map((row) => `${row.classCode}|${row.figureKind}|${row.grain}|${row.ordinal}`)).size).toBe(rows.length);
  });
});
