import {
  CHANGE_TIER_KEYS,
  GUARANTEE_LADDER_KEYS,
  MATCH_STATUSES,
  RETENTION_LADDER_KEYS,
  advanceRecoveryOf,
  advanceRecoveryShortfallOfSums,
  contractEvmLines,
  evmCurveOf,
  evmOfContracts,
  guaranteeBandOf,
  guaranteeExposureOfSums,
  ladderOf,
  matchStatusOf,
  measuredToAcceptedOfSums,
  onTimePaymentRateOfCounts,
  paymentJudgement,
  retentionBandOf,
  selectionEvmOf,
  threeWayDefaults,
  threeWayParams,
  threeWaySqlArguments,
  tierKeyOf,
  tierSplitOf,
  timingOfRequests,
} from '../src/ctr-money-reports.ts';
import type { EvmLinkFact, EvmProjectFact, EvmSetup, PaymentSteps, ReportExtras, ReportTotalExtras, TierDelta } from '../src/ctr-money-reports.ts';
import { changeGrowthOfSums } from '../src/ctr-analytics.ts';
import { REPORT_COLUMNS, paymentClockDefaults, paymentClockOf, reportDocumentOf, reportRowOf, sumsOfFacts, totalsOfSums } from '../src/ctr-reports.ts';
import type { ContractFact, CtrReportCode, MoneyContext, ReportRow } from '../src/ctr-reports.ts';
import { lineEvm, sCurve } from '../src/prj-evm.ts';
import type { AcceptanceFact, EvmLineFacts, PaymentFact } from '../src/prj-evm.ts';

const AS_OF = '2030-06-30';
const thrown = (run: () => unknown): { code?: string; detail?: string } | undefined => {
  try {
    run();
  } catch (error) {
    return error as { code?: string; detail?: string };
  }
  return undefined;
};

/** A small deterministic generator, so the property tests run the same on every machine. */
function lcg(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) % 4_294_967_296;
    return state / 4_294_967_296;
  };
}

let seq = 0;
function fact(extra: Partial<ContractFact> = {}): ContractFact {
  seq += 1;
  return {
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    code: `HD-${seq}`,
    title: `Contract ${seq}`,
    contractStatus: 'ACTIVE',
    contractType: 'LUMP_SUM',
    projectId: 'p1',
    projectCode: 'DA-1',
    projectName: 'Project 1',
    packageId: 'k1',
    contractorId: 'c1',
    contractorName: 'Contractor 1',
    isJointVenture: false,
    unitId: 'u1',
    unitName: 'Unit 1',
    investorId: null,
    fundSourceVersionId: null,
    signedOn: '2030-01-01',
    originalDueDate: '2030-06-01',
    completedOn: null,
    terminatedOn: null,
    approvedExtensionDays: 0,
    milestoneCount: 0,
    milestonePastDueCount: 0,
    contractValueVnd: '1000000000',
    originalValueVnd: '1000000000',
    approvedChangeDeltaVnd: '0',
    approvedChangeCount: 0,
    maxChangeTier: null,
    maxCumulativeVariationPct: null,
    winningBidVnd: null,
    bidderCount: null,
    requestedVnd: '0',
    acceptedVnd: '0',
    paidVnd: '0',
    advancePaidVnd: '0',
    advanceRecoveredVnd: '0',
    retentionWithheldVnd: '0',
    retentionReleasedVnd: '0',
    guaranteeRequiredVnd: null,
    guaranteeValidVnd: null,
    guaranteeNextExpiryOn: null,
    measuredVnd: '0',
    firstAdvanceOn: null,
    lastAcceptanceOn: null,
    acceptanceToRequestDaysMax: null,
    requestToTreasuryDaysMax: null,
    paymentsSentCount: 0,
    openNcrCount: 0,
    projectOpenIssueCount: 0,
    auditFindingCount: 0,
    daysLate: null,
    asOfDate: AS_OF,
    ledgerOk: true,
    ...extra,
  };
}

describe('CA-2 the three-way match of measured work, acceptance, request and payment', () => {
  const params = { tolerance_pct: 2, tolerance_vnd: 1_000_000 };
  const figures = (measured: number, requested: number, accepted: number, paid: number) => ({ measuredVnd: String(measured), requestedVnd: String(requested), acceptedVnd: String(accepted), paidVnd: String(paid) });

  it('names the worst thing first: paid beyond accepted, accepted beyond measured, requested beyond accepted, measured not yet accepted', () => {
    expect(matchStatusOf(figures(0, 0, 0, 0), params)).toBe('NO_ACTIVITY');
    expect(matchStatusOf(figures(1_000_000_000, 900_000_000, 900_000_000, 900_000_000), params)).toBe('MEASURED_NOT_ACCEPTED');
    expect(matchStatusOf(figures(1_000_000_000, 1_000_000_000, 900_000_000, 800_000_000), params)).toBe('REQUEST_NOT_ACCEPTED');
    expect(matchStatusOf(figures(800_000_000, 900_000_000, 900_000_000, 900_000_000), params)).toBe('ACCEPTED_WITHOUT_MEASUREMENT');
    expect(matchStatusOf(figures(1_000_000_000, 1_000_000_000, 900_000_000, 950_000_000), params)).toBe('OVER_PAID');
    expect(matchStatusOf(figures(1_000_000_000, 1_000_000_000, 1_000_000_000, 1_000_000_000), params)).toBe('MATCHED');
    // Paid beyond accepted and measured not accepted at once: the payment is what is reported.
    expect(matchStatusOf(figures(2_000_000_000, 1_000_000_000, 900_000_000, 990_000_000), params)).toBe('OVER_PAID');
  });

  it('tolerates a gap up to the larger of a sum and a share of the larger figure, exactly, and not a dong more', () => {
    // 2 percent of 1,000,000,000 is 20,000,000: a gap of exactly that is within, one dong more is not.
    expect(matchStatusOf(figures(1_000_000_000, 980_000_000, 980_000_000, 980_000_000), params)).toBe('MATCHED');
    expect(matchStatusOf(figures(1_000_000_000, 979_999_999, 979_999_999, 979_999_999), params)).toBe('MEASURED_NOT_ACCEPTED');
    // A small figure uses the sum: 1,000,000 is 10 percent of 10,000,000, far above the share, and the sum covers it.
    expect(matchStatusOf(figures(10_000_000, 9_000_000, 9_000_000, 9_000_000), params)).toBe('MATCHED');
    expect(matchStatusOf(figures(10_000_000, 8_999_999, 8_999_999, 8_999_999), params)).toBe('MEASURED_NOT_ACCEPTED');
    // No tolerance at all: any gap counts.
    expect(matchStatusOf(figures(100, 99, 99, 99), { tolerance_pct: 0, tolerance_vnd: 0 })).toBe('MEASURED_NOT_ACCEPTED');
    expect(matchStatusOf(figures(100, 100, 100, 100), { tolerance_pct: 0, tolerance_vnd: 0 })).toBe('MATCHED');
  });

  it('does not lose a dong on figures beyond a float', () => {
    const huge = '9'.repeat(23);
    expect(matchStatusOf({ measuredVnd: huge, requestedVnd: huge, acceptedVnd: huge, paidVnd: huge }, { tolerance_pct: 0, tolerance_vnd: 0 })).toBe('MATCHED');
    const less = String(BigInt(huge) - 1n);
    expect(matchStatusOf({ measuredVnd: huge, requestedVnd: less, acceptedVnd: less, paidVnd: less }, { tolerance_pct: 0, tolerance_vnd: 0 })).toBe('MEASURED_NOT_ACCEPTED');
    expect(matchStatusOf({ measuredVnd: huge, requestedVnd: huge, acceptedVnd: less, paidVnd: less }, { tolerance_pct: 0, tolerance_vnd: 0 })).toBe('REQUEST_NOT_ACCEPTED');
  });

  it('judges the params of its rule and hands the database the same numbers', () => {
    expect(threeWayParams(threeWayDefaults())).toEqual({ tolerance_pct: 2, tolerance_vnd: 1_000_000 });
    for (const bad of [null, [], { tolerance_pct: 2 }, { tolerance_pct: -1, tolerance_vnd: 0 }, { tolerance_pct: 100.5, tolerance_vnd: 0 }, { tolerance_pct: 1.234, tolerance_vnd: 0 }, { tolerance_pct: 1, tolerance_vnd: 1.5 }, { tolerance_pct: 1, tolerance_vnd: 0, extra: 1 }]) {
      expect(thrown(() => threeWayParams(bad))?.code).toBe('GOVERNANCE_RULE_PARAMS_INVALID');
    }
    expect(threeWaySqlArguments({ tolerance_pct: 2.5, tolerance_vnd: 1000 })).toEqual({ toleranceVnd: '1000', toleranceHundredths: '250' });
    expect(MATCH_STATUSES).toHaveLength(6);
  });

  it('reads accepted against measured as a ratio of sums, and says why it has none instead of writing 0', () => {
    expect(measuredToAcceptedOfSums({ acceptedVnd: '900', measuredVnd: '1000' })).toMatchObject({ status: 'OK', value: '90.00' });
    expect(measuredToAcceptedOfSums({ acceptedVnd: '1100', measuredVnd: '1000' })).toMatchObject({ value: '110.00' });
    expect(measuredToAcceptedOfSums({ acceptedVnd: '500', measuredVnd: '0' })).toMatchObject({ status: 'NOT_APPLICABLE', value: null, reason: 'NO_MEASURED_WORK' });
  });
});

describe('CA-2 the payment clock, request by request', () => {
  const clock = paymentClockDefaults();
  const step = (a: number | null, b: number | null): PaymentSteps => ({ acceptanceToRequestDays: a, requestToTreasuryDays: b });

  it('judges a request late as soon as one step took longer than the rule allows, and not at all when no step is behind it', () => {
    expect(paymentJudgement(step(null, null), clock)).toBe('NOT_JUDGED');
    expect(paymentJudgement(step(14, 7), clock)).toBe('ON_TIME');
    expect(paymentJudgement(step(15, 0), clock)).toBe('LATE');
    expect(paymentJudgement(step(1, 8), clock)).toBe('LATE');
    expect(paymentJudgement(step(null, 7), clock)).toBe('ON_TIME');
    expect(paymentJudgement(step(null, 8), clock)).toBe('LATE');
  });

  it('counts the requests that were judged and those on time; the rate is of the counts and has no figure with nothing judged', () => {
    const timing = timingOfRequests([step(1, 1), step(30, 2), step(null, null), step(5, null), step(null, 40)], clock);
    expect(timing).toEqual({ judged: 4, onTime: 2 });
    expect(onTimePaymentRateOfCounts(timing)).toMatchObject({ status: 'OK', value: '50.00', numerator: '2', denominator: '4' });
    expect(onTimePaymentRateOfCounts({ judged: 0, onTime: 0 })).toMatchObject({ status: 'NOT_APPLICABLE', value: null, reason: 'NO_PAYMENT_JUDGED' });
  });

  it('agrees with the clock of a contract: it is late exactly when at least one of its requests is', () => {
    const next = lcg(7);
    for (let round = 0; round < 200; round += 1) {
      const requests = Array.from({ length: 1 + Math.floor(next() * 5) }, (): PaymentSteps => step(next() < 0.2 ? null : Math.floor(next() * 30), next() < 0.4 ? null : Math.floor(next() * 15)));
      const maxA = requests.reduce<number | null>((best, one) => (one.acceptanceToRequestDays === null ? best : best === null || one.acceptanceToRequestDays > best ? one.acceptanceToRequestDays : best), null);
      const maxB = requests.reduce<number | null>((best, one) => (one.requestToTreasuryDays === null ? best : best === null || one.requestToTreasuryDays > best ? one.requestToTreasuryDays : best), null);
      const contract = paymentClockOf({ acceptanceToRequestDaysMax: maxA, requestToTreasuryDaysMax: maxB }, clock);
      const timing = timingOfRequests(requests, clock);
      if (contract === 'NO_PAYMENT') expect(timing.judged).toBe(0);
      else expect(contract === 'LATE').toBe(timing.onTime < timing.judged);
    }
  });
});

describe('CA-2 an advance recovered as fast as the work was accepted', () => {
  const advance = (paid: number, recovered: number, accepted: number, value: number) => ({ advancePaidVnd: String(paid), advanceRecoveredVnd: String(recovered), acceptedVnd: String(accepted), contractValueVnd: String(value) });

  it('expects the advance back in step with the accepted share, rounded half up to the dong, and reports what is short of it', () => {
    expect(advanceRecoveryOf(advance(200, 50, 400, 1000), 0n)).toEqual({ expectedVnd: '80', shortfallVnd: '30', outstandingVnd: '150', status: 'BEHIND' });
    expect(advanceRecoveryOf(advance(200, 80, 400, 1000), 0n)).toMatchObject({ expectedVnd: '80', shortfallVnd: '0', status: 'ON_TRACK' });
    expect(advanceRecoveryOf(advance(200, 200, 400, 1000), 0n)).toMatchObject({ shortfallVnd: '0', status: 'RECOVERED' });
    // 100 x 1 / 3 = 33.33 -> 33; 100 x 2 / 3 = 66.67 -> 67.
    expect(advanceRecoveryOf(advance(100, 0, 1, 3), 0n)?.expectedVnd).toBe('33');
    expect(advanceRecoveryOf(advance(100, 0, 2, 3), 0n)?.expectedVnd).toBe('67');
    // Over-recovered is not a negative shortfall, and accepted beyond the value is capped at the value.
    expect(advanceRecoveryOf(advance(100, 90, 100, 1000), 0n)?.shortfallVnd).toBe('0');
    expect(advanceRecoveryOf(advance(100, 0, 5000, 1000), 0n)).toMatchObject({ expectedVnd: '100', shortfallVnd: '100' });
  });

  it('lets the tolerance of the money rule count a small rest as recovered, and a small shortfall as in step', () => {
    expect(advanceRecoveryOf(advance(1000, 995, 1000, 1000), 5n)?.status).toBe('RECOVERED');
    expect(advanceRecoveryOf(advance(1000, 994, 1000, 1000), 5n)?.status).toBe('BEHIND');
    expect(advanceRecoveryOf(advance(1000, 296, 300, 1000), 5n)?.status).toBe('ON_TRACK');
  });

  it('has nothing to say about a contract with no advance or no value, and writes no zero for it', () => {
    expect(advanceRecoveryOf(advance(0, 0, 100, 1000), 0n)).toBeNull();
    expect(advanceRecoveryOf(advance(100, 0, 100, 0), 0n)).toBeNull();
    expect(advanceRecoveryShortfallOfSums({ expectedVnd: '0', shortfallVnd: '0', rows: 0 })).toMatchObject({ status: 'NOT_APPLICABLE', reason: 'NO_ADVANCE', value: null });
    expect(advanceRecoveryShortfallOfSums({ expectedVnd: '80', shortfallVnd: '0', rows: 2 })).toMatchObject({ status: 'OK', value: '0' });
  });
});

describe('CA-2 the guarantee and the retention that fall due', () => {
  it('cuts retention by the day it may leave and a guarantee by the day it lapses, on the edges of every step', () => {
    expect(retentionBandOf(null, AS_OF)).toBe('NO_DATE');
    expect(retentionBandOf('2030-06-29', AS_OF)).toBe('DUE_NOW');
    expect(retentionBandOf('2030-06-30', AS_OF)).toBe('DUE_NOW');
    expect(retentionBandOf('2030-07-01', AS_OF)).toBe('WITHIN_30');
    expect(retentionBandOf('2030-07-30', AS_OF)).toBe('WITHIN_30');
    expect(retentionBandOf('2030-07-31', AS_OF)).toBe('WITHIN_90');
    expect(retentionBandOf('2030-09-28', AS_OF)).toBe('WITHIN_90');
    expect(retentionBandOf('2030-09-29', AS_OF)).toBe('LATER');
    expect(guaranteeBandOf('2030-06-29', AS_OF)).toBe('LAPSED');
    expect(guaranteeBandOf('2030-06-30', AS_OF)).toBe('WITHIN_30');
    expect(guaranteeBandOf('2030-07-30', AS_OF)).toBe('WITHIN_30');
    expect(guaranteeBandOf('2030-07-31', AS_OF)).toBe('WITHIN_90');
    expect(guaranteeBandOf('2030-09-29', AS_OF)).toBe('LATER');
    expect(thrown(() => retentionBandOf('2030-02-30', AS_OF))?.code).toBe('VALIDATION_FAILED');
  });

  it('keeps every step of a ladder, a step with nothing in it as a count of zero', () => {
    const ladder = ladderOf(RETENTION_LADDER_KEYS, [
      { key: 'DUE_NOW', count: 2, amountVnd: '300' },
      { key: 'DUE_NOW', count: 1, amountVnd: '50' },
      { key: 'LATER', count: 1, amountVnd: '9' },
    ]);
    expect(ladder.map((group) => group.key)).toEqual([...RETENTION_LADDER_KEYS]);
    expect(ladder[0]).toEqual({ key: 'DUE_NOW', count: 3, amountVnd: '350' });
    expect(ladder[1]).toEqual({ key: 'WITHIN_30', count: 0, amountVnd: '0' });
    expect(ladderOf(GUARANTEE_LADDER_KEYS, [])).toHaveLength(4);
  });

  it('reads the guarantee not in force as required less valid over the contracts that require one, and none when none does', () => {
    expect(guaranteeExposureOfSums({ requiredVnd: '500', validVnd: '300', rows: 2 })).toMatchObject({ status: 'OK', value: '200' });
    expect(guaranteeExposureOfSums({ requiredVnd: '500', validVnd: '500', rows: 1 })).toMatchObject({ value: '0' });
    expect(guaranteeExposureOfSums({ requiredVnd: '0', validVnd: '0', rows: 0 })).toMatchObject({ status: 'NOT_APPLICABLE', reason: 'NO_GUARANTEE_REQUIRED', value: null });
  });
});

describe('CA-2 the growth through changes by tier', () => {
  const delta = (tier: number | null, count: number, deltaVnd: string, max: string | null = null): TierDelta => ({ tier, count, deltaVnd, maxCumulativePct: max });

  it('adds the tiers up to the growth of the selection: one denominator for all of them', () => {
    const found = [delta(1, 2, '30'), delta(2, 1, '120', '11.11'), delta(3, 1, '-50', '14.00')];
    const split = tierSplitOf(found, '1000');
    expect(split.groups.map((group) => group.key)).toEqual(['TIER_1', 'TIER_2', 'TIER_3']);
    expect(split.groups.map((group) => group.growth.value)).toEqual(['3.00', '12.00', '-5.00']);
    expect(split.totalDeltaVnd).toBe('100');
    expect(split.totalCount).toBe(4);
    const whole = changeGrowthOfSums({ originalValueVnd: '1000', approvedDeltaVnd: split.totalDeltaVnd });
    expect(whole.value).toBe('10.00');
    expect(split.groups.reduce((acc, group) => acc + BigInt(group.deltaVnd ?? '0'), 0n)).toBe(BigInt(split.totalDeltaVnd));
    expect(split.groups[1]).toMatchObject({ maxCumulativePct: '11.11', shareOfGrowthPct: '120.00' });
  });

  it('says a tier with no change has no figure, which is not a growth of zero, and shows the untiered ones only when there are some', () => {
    const split = tierSplitOf([delta(2, 1, '120')], '1000');
    expect(split.groups[0]).toMatchObject({ key: 'TIER_1', count: 0, deltaVnd: null, growth: { status: 'NOT_APPLICABLE', reason: 'NO_CHANGE', value: null } });
    expect(split.groups.some((group) => group.key === 'UNTIERED')).toBe(false);
    const withLegacy = tierSplitOf([delta(null, 1, '40'), delta(2, 1, '120')], '1000');
    expect(withLegacy.groups.at(-1)).toMatchObject({ key: 'UNTIERED', deltaVnd: '40' });
    expect(withLegacy.totalDeltaVnd).toBe('160');
    expect(tierKeyOf(null)).toBe('UNTIERED');
    expect(CHANGE_TIER_KEYS).toHaveLength(4);
  });

  it('has no share of a growth that adds up to nothing, and no ratio over an original value of zero', () => {
    const split = tierSplitOf([delta(1, 1, '50'), delta(2, 1, '-50')], '1000');
    expect(split.groups.map((group) => group.shareOfGrowthPct)).toEqual([null, null, null]);
    expect(tierSplitOf([delta(1, 1, '50')], '0').groups[0]?.growth).toMatchObject({ status: 'NOT_APPLICABLE', reason: 'ZERO_DENOMINATOR' });
  });

  it('sums the same tier of several contracts and keeps the highest cumulative variation', () => {
    const split = tierSplitOf([delta(2, 1, '10', '5.00'), delta(2, 2, '15', '9.50')], '1000');
    expect(split.groups[1]).toMatchObject({ count: 3, deltaVnd: '25', maxCumulativePct: '9.50' });
  });
});

describe('CA-2 the earned value of a contract, of a selection and its S-curve', () => {
  const setup: EvmSetup = { asOf: '2030-03-31', method: 'CPI_CUMULATIVE', policy: { amberBelow: 0.95, redBelow: 0.85 } };
  const projects: EvmProjectFact[] = [
    {
      projectId: 'P1',
      parents: new Map([
        ['A', null],
        ['A1', 'A'],
        ['B', null],
      ]),
      versions: [
        { version: 0, lines: [{ key: 'A', code: 'A', name: 'A', bacVnd: '1000', plannedStart: '2030-01-01', plannedFinish: '2030-04-30' }, { key: 'B', code: 'B', name: 'B', bacVnd: '400', plannedStart: '2030-02-01', plannedFinish: '2030-05-31' }] },
        { version: 1, lines: [{ key: 'A', code: 'A', name: 'A', bacVnd: '1000', plannedStart: '2030-01-01', plannedFinish: '2030-06-30' }, { key: 'B', code: 'B', name: 'B', bacVnd: '400', plannedStart: '2030-02-01', plannedFinish: '2030-05-31' }] },
      ],
    },
    { projectId: 'P2', parents: new Map([['X', null]]), versions: [] },
  ];
  const links: EvmLinkFact[] = [
    { contractId: 'k1', projectId: 'P1', componentId: 'A', valueVnd: '600' },
    { contractId: 'k2', projectId: 'P1', componentId: 'A1', valueVnd: '400' },
    { contractId: 'k3', projectId: 'P1', componentId: 'B', valueVnd: '400' },
    { contractId: 'k4', projectId: 'P2', componentId: 'X', valueVnd: '100' },
    { contractId: 'k5', projectId: 'P1', componentId: 'B', valueVnd: '0' },
  ];
  const acceptances: AcceptanceFact[] = [
    { contractId: 'k1', day: '2030-02-10', amountVnd: '200' },
    { contractId: 'k1', day: '2030-04-10', amountVnd: '100' },
    { contractId: 'k2', day: '2030-03-05', amountVnd: '100' },
    { contractId: 'k3', day: '2030-03-20', amountVnd: '100' },
  ];
  const payments: PaymentFact[] = [
    { contractId: 'k1', day: '2030-02-12', reversedDay: null, grossVnd: '150' },
    { contractId: 'k2', day: '2030-03-06', reversedDay: '2030-03-25', grossVnd: '80' },
    { contractId: 'k3', day: '2030-03-21', reversedDay: null, grossVnd: '120' },
  ];

  it('cuts a package between the contracts that carry it by their values, a lower component read as its first-level package', () => {
    const lines = contractEvmLines(links, projects);
    expect(lines.get('k1')?.current?.bacVnd).toBe('600');
    expect(lines.get('k2')?.current?.bacVnd).toBe('400');
    expect(lines.get('k1')?.current?.plannedFinish).toBe('2030-06-30');
    expect(lines.get('k1')?.v0?.plannedFinish).toBe('2030-04-30');
    expect(lines.get('k3')?.current?.bacVnd).toBe('400');
    expect(lines.get('k4')).toMatchObject({ current: null, missing: 'NO_BASELINE' });
  });

  it('gives the figures of each contract on the day, an index with nothing to divide by named and never zero, and what it cannot know with its reason', () => {
    const reading = evmOfContracts({ links, projects, facts: { acceptances, payments }, unlinkedContracts: 2, setup });
    const k1 = reading.rows.get('k1');
    // k1 carries 600 of the 1000 of package A and was accepted 200 of its 600 by the day (the later acceptance does not count): it earned 600 x 200 / 600 = 200, and cost 150.
    expect(k1).toMatchObject({ reason: null, bacVnd: '600', evVnd: '200', acVnd: '150', cpi: '1.3333' });
    expect(reading.rows.get('k2')).toMatchObject({ reason: null, acVnd: '0' });
    // A payment reversed by the day takes nothing: AC is 0 so CPI has no figure, and the reason is named.
    expect(reading.rows.get('k2')?.cpi).toBeNull();
    expect(reading.rows.get('k2')?.cpiReason).toBe('AC_ZERO');
    expect(reading.rows.get('k4')).toMatchObject({ reason: 'NO_BASELINE', bacVnd: null, evVnd: null, spi: null });
    expect(reading.rows.get('k5')).toMatchObject({ reason: 'CONTRACT_VALUE_ZERO', bacVnd: null });
  });

  it('adds the selection up from the contracts that have figures; SPI and CPI are ratios of the sums, and the contracts without figures are counted by reason', () => {
    const reading = evmOfContracts({ links, projects, facts: { acceptances, payments }, unlinkedContracts: 2, setup });
    const covered = [...reading.rows.values()].filter((row) => row.reason === null);
    const total = (pick: (row: (typeof covered)[number]) => string | null): bigint => covered.reduce((acc, row) => acc + BigInt(pick(row) ?? '0'), 0n);
    expect(reading.selection).toMatchObject({ contracts: 7, covered: 3, missing: { NO_CONTRACT_LINK: 2, NO_BASELINE: 1, CONTRACT_VALUE_ZERO: 1 } });
    expect(reading.selection.evVnd).toBe(total((row) => row.evVnd).toString());
    expect(reading.selection.pvVnd).toBe(total((row) => row.pvVnd).toString());
    expect(reading.selection.acVnd).toBe(total((row) => row.acVnd).toString());
    expect(reading.selection.svVnd).toBe((total((row) => row.evVnd) - total((row) => row.pvVnd)).toString());
    const ev = total((row) => row.evVnd);
    const ac = total((row) => row.acVnd);
    expect(reading.selection.cpi).toMatchObject({ status: 'OK', numerator: ev.toString(), denominator: ac.toString() });
    expect(reading.selection.spi.denominator).toBe(total((row) => row.pvVnd).toString());
  });

  it('has no sum and a named reason when no contract of the selection has figures', () => {
    const none = selectionEvmOf([], 5, 0, setup);
    expect(none).toMatchObject({ contracts: 5, covered: 0, bacVnd: null, evVnd: null, acVnd: null, spi: { status: 'NOT_APPLICABLE', reason: 'NO_CONTRACT_LINK' }, cpi: { status: 'NOT_APPLICABLE' } });
    const noBaseline = evmOfContracts({ links: [links[3] as EvmLinkFact], projects, facts: { acceptances, payments }, unlinkedContracts: 0, setup });
    expect(noBaseline.selection).toMatchObject({ covered: 0, bacVnd: null, spi: { reason: 'NO_BASELINE' } });
  });

  it('draws a curve whose point on the day of the view is the sum of the rows, and whose every point is what lineEvm gives for that day', () => {
    const reading = evmOfContracts({ links, projects, facts: { acceptances, payments }, unlinkedContracts: 0, setup });
    const curve = evmCurveOf(reading, { acceptances, payments }, setup.asOf);
    const today = curve.points.find((point) => point.day === setup.asOf);
    expect(today).toMatchObject({ pvCurrentVnd: reading.selection.pvVnd, evVnd: reading.selection.evVnd, acVnd: reading.selection.acVnd });
    expect(curve.points.map((point) => point.day)).toEqual([...curve.points.map((point) => point.day)].sort());
    for (const point of curve.points) {
      if (point.day > setup.asOf) {
        expect(point.evVnd).toBeNull();
        expect(point.acVnd).toBeNull();
        continue;
      }
      let ev = 0n;
      let ac = 0n;
      for (const row of reading.rows.values()) {
        if (row.reason !== null) continue;
        const line = reading.lines.get(row.contractId)?.current as EvmLineFacts;
        const own = lineEvm(line, point.day, acceptances.filter((a) => a.contractId === row.contractId), payments.filter((p) => p.contractId === row.contractId));
        ev += own.evVnd ?? 0n;
        ac += own.acVnd ?? 0n;
      }
      expect([point.evVnd, point.acVnd]).toEqual([ev.toString(), ac.toString()]);
    }
    // The plan by version 0 ends earlier than the plan in force (the finish of package A was moved).
    expect(curve.v0Complete).toBe(true);
    const last = curve.points.at(-1);
    expect(last?.pvCurrentVnd).toBe('1400');
    expect(BigInt(curve.points.find((point) => point.day === '2030-04-30')?.pvV0Vnd ?? '0')).toBeGreaterThan(BigInt(curve.points.find((point) => point.day === '2030-04-30')?.pvCurrentVnd ?? '0'));
  });

  it('agrees with the project: the contracts of one package add up to the earned value of the package to within a dong each', () => {
    const own = links.filter((link) => link.projectId === 'P1' && link.contractId !== 'k5');
    const reading = evmOfContracts({ links: own, projects, facts: { acceptances, payments }, unlinkedContracts: 0, setup });
    const project = projects[0] as EvmProjectFact;
    const current = (project.versions[1]?.lines ?? []).map((line) => ({ ...line, contracts: own.filter((link) => (link.componentId === 'A1' ? 'A' : link.componentId) === line.key).map((link) => ({ contractId: link.contractId, valueVnd: link.valueVnd })) }));
    const v0 = (project.versions[0]?.lines ?? []).map((line) => ({ ...line, contracts: [] }));
    const curve = sCurve({ v0, current, asOf: setup.asOf, acceptances, payments });
    const wholeToday = curve.points.find((point) => point.day === setup.asOf);
    expect(Math.abs(Number(BigInt(reading.selection.evVnd ?? '0') - BigInt(wholeToday?.evVnd ?? '0')))).toBeLessThanOrEqual(own.length);
    expect(reading.selection.acVnd).toBe(wholeToday?.acVnd);
    expect(Math.abs(Number(BigInt(reading.selection.pvVnd ?? '0') - BigInt(wholeToday?.pvCurrentVnd ?? '0')))).toBeLessThanOrEqual(own.length);
  });

  it('draws no curve and no flat zero when nothing of the selection has figures', () => {
    const reading = evmOfContracts({ links: [links[3] as EvmLinkFact], projects, facts: { acceptances, payments }, unlinkedContracts: 0, setup });
    expect(evmCurveOf(reading, { acceptances, payments }, setup.asOf)).toMatchObject({ points: [], contracts: 0 });
  });
});

describe('CA-2 the rows and the totals of the money reports', () => {
  const money = (extras: ReportExtras | null): MoneyContext => ({ threeWay: { tolerance_pct: 0, tolerance_vnd: 0 }, advanceToleranceVnd: 0n, extras });
  const empty = (): ReportExtras => ({ evm: new Map(), timing: new Map(), tiers: new Map(), exposure: new Map() });
  const cell = (row: ReportRow, key: string): string | number | null => row.cells[key] ?? null;
  const rowsOf = (code: Exclude<CtrReportCode, 'contractor-concentration'>, facts: ContractFact[], context: MoneyContext): ReportRow[] => facts.map((one) => reportRowOf(code, one, { asOf: AS_OF, money: context }));
  const sumColumn = (rows: ReportRow[], key: string): bigint => rows.reduce((acc, row) => acc + BigInt(cell(row, key) ?? '0'), 0n);

  const facts = [
    fact({ measuredVnd: '1000', requestedVnd: '900', acceptedVnd: '900', paidVnd: '800', advancePaidVnd: '200', advanceRecoveredVnd: '30', contractValueVnd: '1000', guaranteeRequiredVnd: '100', guaranteeValidVnd: '60', retentionWithheldVnd: '40', retentionReleasedVnd: '10' }),
    fact({ measuredVnd: '500', requestedVnd: '700', acceptedVnd: '600', paidVnd: '650', advancePaidVnd: '100', advanceRecoveredVnd: '100', contractValueVnd: '2000', guaranteeRequiredVnd: '300', guaranteeValidVnd: '300' }),
    fact({ measuredVnd: '0', requestedVnd: '0', acceptedVnd: '0', paidVnd: '0', contractValueVnd: '500' }),
    fact({ measuredVnd: '300', requestedVnd: '300', acceptedVnd: '300', paidVnd: '300', advancePaidVnd: '90', advanceRecoveredVnd: '10', contractValueVnd: '300', ledgerOk: false }),
  ];

  it('gives the three-way match its columns and the totals of them as sums, with no figure for a reader who may not see the ledger', () => {
    const rows = rowsOf('payment-three-way', facts, money(empty()));
    expect(rows.map((row) => cell(row, 'match_status'))).toEqual(['MEASURED_NOT_ACCEPTED', 'OVER_PAID', 'NO_ACTIVITY', null]);
    expect(rows[3]?.na.match_status).toBe('LEDGER_DENIED');
    expect(rows[0]?.cells.measured_not_accepted_vnd).toBe('100');
    expect(rows[1]?.cells.measured_not_accepted_vnd).toBe('-100');
    const sums = sumsOfFacts(facts, AS_OF);
    const timing = { judged: 5, onTime: 4 };
    const totals = totalsOfSums('payment-three-way', sums, { extras: { evm: null, timing, tiers: null, exposure: null } });
    expect(totals.cells.measured_not_accepted_vnd).toBe(sumColumn(rows, 'measured_not_accepted_vnd').toString());
    expect(totals.cells.measured_to_accepted_pct).toBe('100.00');
    expect(totals.cells.on_time_payment_pct).toBe('80.00');
    expect(totals.indicators.map((one) => one.code)).toEqual(expect.arrayContaining(['MEASURED_TO_ACCEPTED', 'ON_TIME_PAYMENT_RATE']));
  });

  it('reads the on-time payments of a contract from the requests, none judged is not a hundred percent and not zero', () => {
    const one = facts[0] as ContractFact;
    const extras = empty();
    const row = reportRowOf('payment-three-way', one, { asOf: AS_OF, money: money(extras) });
    expect(cell(row, 'payments_judged')).toBe(0);
    expect(cell(row, 'on_time_payment_pct')).toBeNull();
    expect(row.na.on_time_payment_pct).toBe('NO_PAYMENT_JUDGED');
    const withTiming = reportRowOf('payment-three-way', one, { asOf: AS_OF, money: money({ ...extras, timing: new Map([[one.id, { judged: 3, onTime: 2 }]]) }) });
    expect(cell(withTiming, 'on_time_payment_pct')).toBe('66.67');
  });

  it('says a frozen snapshot does not hold what it did not freeze, and never fills the gap with a zero', () => {
    const rows = rowsOf('payment-three-way', facts, money(null));
    expect(rows[0]?.cells.payments_judged).toBeNull();
    expect(rows[0]?.na.payments_judged).toBe('NOT_IN_SNAPSHOT');
    expect(rows[3]?.na.payments_judged).toBe('LEDGER_DENIED');
    const totals = totalsOfSums('payment-three-way', sumsOfFacts(facts, AS_OF), { frozen: true });
    expect(totals.cells.payments_judged).toBeNull();
    expect(totals.na.payments_judged).toBe('NOT_IN_SNAPSHOT');
    const schedule = rowsOf('schedule-delay', facts, money(null));
    expect(schedule[0]?.na.spi).toBe('NOT_IN_SNAPSHOT');
    expect(rowsOf('change-growth', facts, money(null))[0]?.na.tier_1_delta_vnd).toBe('NOT_IN_SNAPSHOT');
    expect(rowsOf('retention-guarantee', facts, money(null))[0]?.na.guarantee_expiring_vnd).toBe('NOT_IN_SNAPSHOT');
  });

  it('adds the advance recovery up: the total of the rows is the total, the shortfall is the sum of what each contract is short and not the sum less the sum', () => {
    const rows = rowsOf('advance-ageing', facts, money(null));
    expect(rows.map((row) => cell(row, 'recovery_status'))).toEqual(['BEHIND', 'RECOVERED', null, null]);
    expect(rows[2]?.na.recovery_status).toBe('NO_ADVANCE');
    expect(rows[3]?.na.recovery_status).toBe('LEDGER_DENIED');
    const sums = sumsOfFacts(facts, AS_OF);
    const totals = totalsOfSums('advance-ageing', sums);
    expect(totals.cells.advance_expected_recovery_vnd).toBe(sumColumn(rows, 'advance_expected_recovery_vnd').toString());
    expect(totals.cells.advance_recovery_shortfall_vnd).toBe(sumColumn(rows, 'advance_recovery_shortfall_vnd').toString());
    // Contract 1 expects 180 and has 30: short by 150... accepted 900 of 1000 = 90 percent of 200 = 180. Contract 2 is over-recovered and adds nothing.
    expect(totals.cells.advance_recovery_shortfall_vnd).toBe('150');
    expect(totals.indicators.find((one) => one.code === 'ADVANCE_RECOVERY_SHORTFALL')).toMatchObject({ value: '150' });
  });

  it('puts the guarantee exposure and what falls due beside the retention: sums of rows, no zero where there is nothing', () => {
    const extras = empty();
    const [a, b] = facts as [ContractFact, ContractFact];
    const withDue: ReportExtras = { ...extras, exposure: new Map([[a.id, { retentionDueNowVnd: '25', guaranteeExpiringVnd: '40' }]]) };
    const rows = rowsOf('retention-guarantee', facts, money(withDue));
    expect(cell(rows[0] as ReportRow, 'retention_releasable_vnd')).toBe('25');
    expect(cell(rows[0] as ReportRow, 'guarantee_expiring_vnd')).toBe('40');
    // Contract b has a guarantee and no retention: the retention figure is absent with its reason and the guarantee one is a counted zero.
    expect(rows[1]?.na.retention_releasable_vnd).toBe('NO_RETENTION');
    expect(cell(rows[1] as ReportRow, 'guarantee_expiring_vnd')).toBe('0');
    expect(rows[2]?.na.guarantee_expiring_vnd).toBe('NO_GUARANTEE_REQUIRED');
    expect(b.guaranteeRequiredVnd).toBe('300');
    const total: ReportTotalExtras = { evm: null, timing: null, tiers: null, exposure: { retentionDueNowVnd: '25', guaranteeExpiringVnd: '40' } };
    const totals = totalsOfSums('retention-guarantee', sumsOfFacts(facts, AS_OF), { extras: total });
    expect(totals.cells.guarantee_expiring_vnd).toBe(sumColumn(rows, 'guarantee_expiring_vnd').toString());
    expect(totals.cells.retention_releasable_vnd).toBe(sumColumn(rows, 'retention_releasable_vnd').toString());
    expect(totals.cells.guarantee_exposure_vnd).toBe('40');
    expect(totals.indicators.find((one) => one.code === 'GUARANTEE_EXPOSURE')).toMatchObject({ value: '40' });
    // Nothing requires a guarantee: no figure, never 0.
    const none = totalsOfSums('retention-guarantee', sumsOfFacts([facts[2] as ContractFact], AS_OF), { extras: total });
    expect(none.cells.guarantee_exposure_vnd).toBeNull();
    expect(none.na.guarantee_exposure_vnd).toBe('NO_GUARANTEE_REQUIRED');
  });

  it('cuts the growth of each contract by tier and the total is the sum of the rows', () => {
    const a = facts[0] as ContractFact;
    const b = facts[1] as ContractFact;
    const tiers = new Map<string, readonly TierDelta[]>([
      [a.id, [{ tier: 1, count: 2, deltaVnd: '30', maxCumulativePct: '3.00' }, { tier: 2, count: 1, deltaVnd: '70', maxCumulativePct: '9.00' }]],
      [b.id, [{ tier: 2, count: 1, deltaVnd: '-20', maxCumulativePct: '8.00' }, { tier: null, count: 1, deltaVnd: '5', maxCumulativePct: null }]],
    ]);
    const extras: ReportExtras = { ...empty(), tiers };
    const rows = rowsOf('change-growth', facts, money(extras));
    expect(cell(rows[0] as ReportRow, 'tier_1_delta_vnd')).toBe('30');
    expect(cell(rows[0] as ReportRow, 'tier_3_delta_vnd')).toBeNull();
    expect(rows[0]?.na.tier_3_delta_vnd).toBe('NO_CHANGE');
    expect(cell(rows[1] as ReportRow, 'tier_none_delta_vnd')).toBe('5');
    const found: TierDelta[] = [...tiers.values()].flat();
    const totals = totalsOfSums('change-growth', sumsOfFacts(facts, AS_OF), { extras: { evm: null, timing: null, tiers: found, exposure: null } });
    for (const key of ['tier_1_delta_vnd', 'tier_2_delta_vnd', 'tier_none_delta_vnd']) expect(totals.cells[key]).toBe(sumColumn(rows, key).toString());
    expect(totals.cells.tier_3_delta_vnd).toBeNull();
    expect(totals.na.tier_3_delta_vnd).toBe('NO_CHANGE');
  });

  it('shows the earned value columns of a contract, the same figures as the sums, and why a contract has none', () => {
    const setup: EvmSetup = { asOf: AS_OF, method: 'CPI_CUMULATIVE', policy: { amberBelow: 0.95, redBelow: 0.85 } };
    const one = fact();
    const two = fact();
    const three = fact();
    const projects: EvmProjectFact[] = [{ projectId: 'P', parents: new Map([['A', null]]), versions: [{ version: 0, lines: [{ key: 'A', code: 'A', name: 'A', bacVnd: '1000', plannedStart: '2030-01-01', plannedFinish: '2030-12-31' }] }] }];
    const reading = evmOfContracts({
      links: [
        { contractId: one.id, projectId: 'P', componentId: 'A', valueVnd: '600' },
        { contractId: two.id, projectId: 'P', componentId: 'A', valueVnd: '400' },
      ],
      projects,
      facts: { acceptances: [{ contractId: one.id, day: '2030-03-01', amountVnd: '300' }, { contractId: two.id, day: '2030-03-01', amountVnd: '100' }], payments: [{ contractId: one.id, day: '2030-03-02', reversedDay: null, grossVnd: '250' }] },
      unlinkedContracts: 1,
      setup,
    });
    const extras: ReportExtras = { ...empty(), evm: reading.rows };
    const set = [one, two, three];
    const rows = rowsOf('schedule-delay', set, money(extras));
    expect(cell(rows[0] as ReportRow, 'bac_vnd')).toBe('600');
    expect(cell(rows[0] as ReportRow, 'earned_value_vnd')).toBe('300');
    expect(rows[2]?.na.spi).toBe('NO_CONTRACT_LINK');
    // The second contract has nothing certified yet: its CPI has no figure and the reason is the cost, not the plan.
    expect(rows[1]?.cells.cpi).toBeNull();
    expect(rows[1]?.na.cpi).toBe('AC_ZERO');
    const totals = totalsOfSums('schedule-delay', sumsOfFacts(set, AS_OF), { extras: { evm: reading.selection, timing: null, tiers: null, exposure: null } });
    for (const key of ['bac_vnd', 'planned_value_vnd', 'earned_value_vnd', 'actual_cost_vnd', 'schedule_variance_vnd']) expect(totals.cells[key]).toBe(sumColumn(rows, key).toString());
    expect(totals.indicators.map((one) => one.code)).toEqual(expect.arrayContaining(['SPI', 'CPI']));
    expect(totals.cells.cpi).toBe('1.6000');
    // A reader without the ledger sees none of it.
    const denied = reportRowOf('schedule-delay', fact({ ledgerOk: false }), { asOf: AS_OF, money: money(extras) });
    expect(denied.na.earned_value_vnd).toBe('LEDGER_DENIED');
  });

  it('writes the words of a status in a file, not its code, and keeps the totals row of every new column', () => {
    const rows = rowsOf('payment-three-way', facts, money(empty()));
    const totals = totalsOfSums('payment-three-way', sumsOfFacts(facts, AS_OF), { extras: { evm: null, timing: { judged: 1, onTime: 1 }, tiers: null, exposure: null } });
    const document = reportDocumentOf({
      code: 'payment-three-way',
      scopeDescription: 'scope',
      periodLabel: AS_OF,
      asOf: AS_OF,
      cutoffDate: '',
      snapshotId: '',
      snapshotRevision: '',
      stale: false,
      generatedAt: new Date('2030-07-01T00:00:00Z'),
      filterText: 'none',
      columns: REPORT_COLUMNS['payment-three-way'],
      rows,
      totals,
    });
    const at = REPORT_COLUMNS['payment-three-way'].findIndex((column) => column.key === 'match_status');
    expect(document.rows[0]?.[at]).not.toBe('MEASURED_NOT_ACCEPTED');
    expect((document.rows[0]?.[at] ?? '').length).toBeGreaterThan(3);
    expect(document.rows.at(-1)?.[REPORT_COLUMNS['payment-three-way'].findIndex((column) => column.key === 'payments_judged')]).toBe('1');
  });
});
