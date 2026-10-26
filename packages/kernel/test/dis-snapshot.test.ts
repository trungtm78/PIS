import { COVERAGE, METRIC_SET_VERSION, SNAPSHOT_KINDS, buildLines, coverageOf, groupRate, planSplitOf, ratesOf, snapshotHash, treasuryDisbursed } from '../src/dis-snapshot.ts';
import type { SnapshotProject } from '../src/dis-snapshot.ts';

const project = (over: Partial<SnapshotProject> = {}): SnapshotProject => ({
  projectId: 'p1',
  unitId: 'u1',
  plans: [],
  reported: null,
  previous: null,
  treasury: [],
  planVersionId: null,
  ...over,
});

describe('the formulas of the period snapshot (ST-DIS-009, BR-DIS-02..06, proposals until D03 is signed)', () => {
  it('FX-DIS-004 / UAT-AC243: the two rates share one numerator: 600 of a plan of 1,000 given by the Prime Minister and 250 added by the province are 60.0000% and 48.0000%', () => {
    expect(ratesOf({ disbursedVnd: '600000000', planPmVnd: '1000000000', planLocalVnd: '250000000', coverage: COVERAGE.complete })).toEqual({ ratePmPct: '60.0000', rateTotalPct: '48.0000', nullReason: null });
    // The rate on the plan of the Prime Minister can pass 100% when the province adds capital.
    expect(ratesOf({ disbursedVnd: '1100000000', planPmVnd: '1000000000', planLocalVnd: '250000000', coverage: COVERAGE.complete })).toEqual({ ratePmPct: '110.0000', rateTotalPct: '88.0000', nullReason: null });
  });

  it('rounds half up at the fourth decimal and never goes through a float', () => {
    expect(ratesOf({ disbursedVnd: '1', planPmVnd: '3', planLocalVnd: '0', coverage: COVERAGE.complete })).toEqual({ ratePmPct: '33.3333', rateTotalPct: '33.3333', nullReason: null });
    expect(ratesOf({ disbursedVnd: '2', planPmVnd: '3', planLocalVnd: '0', coverage: COVERAGE.complete }).ratePmPct).toBe('66.6667');
    expect(ratesOf({ disbursedVnd: '123456789012345678', planPmVnd: '987654321098765432', planLocalVnd: '0', coverage: COVERAGE.complete }).ratePmPct).toBe('12.5000');
  });

  it('BR-DIS-08: a rate with nothing to divide by is null with its reason, never zero: no plan is ZERO_DENOMINATOR, no Treasury data is NO_DATA, no coverage is TREASURY_COVERAGE_NONE', () => {
    expect(ratesOf({ disbursedVnd: '5', planPmVnd: '0', planLocalVnd: '0', coverage: COVERAGE.complete })).toEqual({ ratePmPct: null, rateTotalPct: null, nullReason: 'ZERO_DENOMINATOR' });
    expect(ratesOf({ disbursedVnd: null, planPmVnd: '100', planLocalVnd: '0', coverage: COVERAGE.complete })).toEqual({ ratePmPct: null, rateTotalPct: null, nullReason: 'NO_DATA' });
    expect(ratesOf({ disbursedVnd: null, planPmVnd: '100', planLocalVnd: '0', coverage: COVERAGE.none })).toEqual({ ratePmPct: null, rateTotalPct: null, nullReason: 'TREASURY_COVERAGE_NONE' });
    // Only the plan of the Prime Minister is zero: the rate on the whole plan stands, the other says why it does not.
    expect(ratesOf({ disbursedVnd: '50', planPmVnd: '0', planLocalVnd: '100', coverage: COVERAGE.complete })).toEqual({ ratePmPct: null, rateTotalPct: '50.0000', nullReason: 'ZERO_DENOMINATOR' });
  });

  it('FX-DIS-003 / UAT-AC242 / BR-DIS-04: the rate of a group is the sum of the numerators over the sum of the denominators, not the mean of the rates: 50/100 and 90/900 are 14%', () => {
    expect(groupRate([{ numeratorVnd: '50', denominatorVnd: '100' }, { numeratorVnd: '90', denominatorVnd: '900' }])).toBe('14.0000');
    expect(groupRate([{ numeratorVnd: '0', denominatorVnd: '0' }])).toBeNull();
    expect(groupRate([])).toBeNull();
  });

  it('FX-DIS-005 / UAT-AC244 / BR-DIS-06: counts what the Treasury paid on or before the cutoff, by the day it paid it, and takes a refund off on the day of the refund', () => {
    const t1 = { amountVnd: '500000000', reversal: false, paidOn: '2026-09-30' };
    const t2 = { amountVnd: '300000000', reversal: false, paidOn: '2026-10-01' };
    expect(treasuryDisbursed([t1, t2], '2026-09-30')).toEqual({ totalVnd: '500000000', transactions: 1 });
    expect(treasuryDisbursed([t1, t2], '2026-10-01')).toEqual({ totalVnd: '800000000', transactions: 2 });
    // The refund of T1 on 1 October reduces from that day, not from the day of T1.
    const refund = { amountVnd: '100000000', reversal: true, paidOn: '2026-10-01' };
    expect(treasuryDisbursed([t1, t2, refund], '2026-09-30')).toEqual({ totalVnd: '500000000', transactions: 1 });
    expect(treasuryDisbursed([t1, t2, refund], '2026-10-01')).toEqual({ totalVnd: '700000000', transactions: 3 });
    expect(treasuryDisbursed([t2], '2026-09-30')).toBeNull();
    expect(treasuryDisbursed([], '2026-09-30')).toBeNull();
  });

  it('tells how much the Treasury data covers: none without a transaction, partial when there is no accepted report to compare with or the gap is above 5%, complete otherwise', () => {
    expect(coverageOf({ treasuryVnd: null, reportedVnd: '100' })).toBe(COVERAGE.none);
    expect(coverageOf({ treasuryVnd: '100', reportedVnd: null })).toBe(COVERAGE.partial);
    expect(coverageOf({ treasuryVnd: '940', reportedVnd: '1000' })).toBe(COVERAGE.partial);
    expect(coverageOf({ treasuryVnd: '950', reportedVnd: '1000' })).toBe(COVERAGE.complete);
    expect(coverageOf({ treasuryVnd: '1050', reportedVnd: '1000' })).toBe(COVERAGE.complete);
    expect(coverageOf({ treasuryVnd: '1051', reportedVnd: '1000' })).toBe(COVERAGE.partial);
    expect(coverageOf({ treasuryVnd: '10', reportedVnd: '0' })).toBe(COVERAGE.partial);
    expect(coverageOf({ treasuryVnd: '0', reportedVnd: '0' })).toBe(COVERAGE.complete);
  });

  it('splits a plan by the origin of its appropriation: the Prime Minister and the carried-over capital are the plan he gave, what a province or a ministry adds is the capital added', () => {
    expect([planSplitOf('PM_ASSIGNED'), planSplitOf('CARRYOVER'), planSplitOf(null)]).toEqual(['PM', 'PM', 'PM']);
    expect([planSplitOf('LOCAL_ADDED'), planSplitOf('CENTRAL_SUPPORT'), planSplitOf('REVENUE_INCREASE')]).toEqual(['LOCAL', 'LOCAL', 'LOCAL']);
  });

  it('knows the kinds of snapshot and the version of the formulas', () => {
    expect(SNAPSHOT_KINDS).toEqual(['PERIOD_CLOSE', 'ADHOC', 'MNE']);
    expect(METRIC_SET_VERSION).toMatch(/PROPOSED/);
  });
});

describe('the lines of a snapshot of a project', () => {
  const cell = (bucket: 'CURRENT_YEAR' | 'CARRYOVER' | 'OTHER', level: 'CENTRAL' | 'LOCAL', over: Record<string, string | null> = {}) => ({ bucket, budgetLevel: level, cumulativeVnd: '0', ctmtqgVnd: null, nextMonthVnd: '0', ...over });

  it('FX-DIS-002 / UAT-AC241 / BR-DIS-02: the cumulative is the one of the accepted report of the period, not the sum of the periods: W39 100 and W40 150 give 150 and a change of 50', () => {
    const lines = buildLines(
      project({
        reported: { reportRevisionId: 'r40', cells: [cell('CURRENT_YEAR', 'CENTRAL', { cumulativeVnd: '150000000' })] },
        previous: new Map([['CURRENT_YEAR/CENTRAL', '100000000']]),
      }),
      '2026-10-02',
    );
    const row = lines.find((line) => line.bucket === 'CURRENT_YEAR' && line.budgetLevel === 'CENTRAL');
    expect(row).toMatchObject({ disbursedReportedVnd: '150000000', periodDeltaVnd: '50000000', reportRevisionId: 'r40' });
  });

  it('gives a line for each of the six cells, with nothing reported as null (never zero) and no change when there is no period before', () => {
    const lines = buildLines(project({ plans: [{ bucket: 'CURRENT_YEAR', budgetLevel: 'CENTRAL', amountVnd: '1000', origin: 'PM_ASSIGNED', fundSourceVersionId: 'f1' }] }), '2026-10-02');
    expect(lines.map((line) => `${line.bucket}/${line.budgetLevel}`)).toEqual(['CURRENT_YEAR/CENTRAL', 'CURRENT_YEAR/LOCAL', 'CARRYOVER/CENTRAL', 'CARRYOVER/LOCAL', 'OTHER/CENTRAL', 'OTHER/LOCAL']);
    expect(lines[0]).toMatchObject({ planPmAssignedVnd: '1000', planLocalAddedVnd: '0', planTotalVnd: '1000', disbursedReportedVnd: null, periodDeltaVnd: null, fundSourceVersionId: 'f1', reportRevisionId: null });
    expect(lines[1]).toMatchObject({ planTotalVnd: '0', disbursedReportedVnd: null });
  });

  it('FX-DIS-004: carries the Treasury figure once, on the year plan of the central budget, and the rates of the year plan there, over the plan of both budget levels', () => {
    const lines = buildLines(
      project({
        plans: [
          { bucket: 'CURRENT_YEAR', budgetLevel: 'CENTRAL', amountVnd: '1000000000', origin: 'PM_ASSIGNED', fundSourceVersionId: null },
          { bucket: 'CURRENT_YEAR', budgetLevel: 'LOCAL', amountVnd: '250000000', origin: 'LOCAL_ADDED', fundSourceVersionId: null },
        ],
        treasury: [{ amountVnd: '600000000', reversal: false, paidOn: '2026-09-30' }, { amountVnd: '300000000', reversal: false, paidOn: '2026-10-01' }],
      }),
      '2026-09-30',
    );
    expect(lines[0]).toMatchObject({ disbursedTreasuryVnd: '600000000', ratePmPct: '60.0000', rateTotalPct: '48.0000', rateNullReason: null, treasuryCoverage: COVERAGE.partial });
    expect(lines[1]).toMatchObject({ disbursedTreasuryVnd: null, ratePmPct: null, rateTotalPct: null, rateNullReason: 'NO_DATA' });
    expect(lines.slice(2).every((line) => line.disbursedTreasuryVnd === null)).toBe(true);
  });

  it('a project with no Treasury transaction has coverage NONE and a rate that says so', () => {
    const lines = buildLines(project({ plans: [{ bucket: 'CURRENT_YEAR', budgetLevel: 'CENTRAL', amountVnd: '100', origin: 'PM_ASSIGNED', fundSourceVersionId: null }] }), '2026-09-30');
    expect(lines[0]).toMatchObject({ disbursedTreasuryVnd: null, ratePmPct: null, rateTotalPct: null, rateNullReason: 'TREASURY_COVERAGE_NONE', treasuryCoverage: COVERAGE.none });
  });

  it('keeps the CTMTQG and the registration for next month of the accepted report, and none of them for a cell nobody reported', () => {
    const lines = buildLines(project({ reported: { reportRevisionId: 'r1', cells: [cell('CURRENT_YEAR', 'CENTRAL', { cumulativeVnd: '100', ctmtqgVnd: '40', nextMonthVnd: '7' })] } }), '2026-10-02');
    expect(lines[0]).toMatchObject({ ctmtqgSubsetVnd: '40', registeredMonthVnd: '7', disbursedReportedVnd: '100' });
    expect(lines[1]).toMatchObject({ ctmtqgSubsetVnd: null, registeredMonthVnd: null });
  });
});

describe('a refund that leaves the net of the year below zero', () => {
  it('gives no rate (a rate of disbursement is not negative) and says the Treasury figure cannot be trusted next to the report', () => {
    expect(ratesOf({ disbursedVnd: '-100', planPmVnd: '1000', planLocalVnd: '0', coverage: 'PARTIAL' })).toEqual({ ratePmPct: null, rateTotalPct: null, nullReason: 'NO_DATA' });
    expect(coverageOf({ treasuryVnd: '-100', reportedVnd: '1000' })).toBe('PARTIAL');
    expect(coverageOf({ treasuryVnd: '-100', reportedVnd: '0' })).toBe('PARTIAL');
    const lines = buildLines(project({ plans: [{ bucket: 'CURRENT_YEAR', budgetLevel: 'CENTRAL', amountVnd: '1000', origin: 'PM_ASSIGNED', fundSourceVersionId: null }], treasury: [{ amountVnd: '100', reversal: true, paidOn: '2026-02-01' }] }), '2026-09-30');
    expect(lines[0]).toMatchObject({ disbursedTreasuryVnd: '-100', ratePmPct: null, rateTotalPct: null, rateNullReason: 'NO_DATA', treasuryCoverage: 'PARTIAL' });
  });
});

describe('the hash of a snapshot', () => {
  const header = { periodId: 'w40', snapshotKind: 'PERIOD_CLOSE', asOfDate: '2026-10-02', treasuryCutoffDate: '2026-09-30', metricSetVersion: METRIC_SET_VERSION, definitionStatus: 'PROPOSED_PENDING_SIGNOFF' } as const;
  const lines = buildLines(project({ plans: [{ bucket: 'CURRENT_YEAR', budgetLevel: 'CENTRAL', amountVnd: '1000', origin: 'PM_ASSIGNED', fundSourceVersionId: null }] }), '2026-09-30').map((line) => ({ ...line, projectId: 'p1', unitId: 'u1' }));

  it('is the same for the same content in any order, and changes with a figure, the cutoff or the layout of the formulas', () => {
    const hash = snapshotHash(header, lines);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(snapshotHash(header, [...lines].reverse())).toBe(hash);
    expect(snapshotHash({ ...header, treasuryCutoffDate: '2026-10-01' }, lines)).not.toBe(hash);
    expect(snapshotHash({ ...header, metricSetVersion: 'OTHER' }, lines)).not.toBe(hash);
    expect(snapshotHash(header, [{ ...(lines[0] as (typeof lines)[number]), planPmAssignedVnd: '1001', planTotalVnd: '1001' }, ...lines.slice(1)])).not.toBe(hash);
  });
});
