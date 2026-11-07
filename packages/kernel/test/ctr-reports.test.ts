import {
  CTR_REPORT_CODES,
  REPORT_CATALOGUE,
  REPORT_COLUMNS,
  REPORT_SUMS,
  ageBucketOf,
  bidderBandOf,
  concentrationDefaults,
  concentrationDocumentOf,
  concentrationReport,
  contractorLoadOf,
  daysLateOfFact,
  delayBandOf,
  healthOfFact,
  indicatorOfColumn,
  paymentClockDefaults,
  paymentClockOf,
  paymentClockParams,
  reportDocumentOf,
  reportRowOf,
  sumsOfFacts,
  tierBandOf,
  totalsOfSums,
} from '../src/ctr-reports.ts';
import type { ConcentrationInput, ContractFact, CtrReportCode } from '../src/ctr-reports.ts';
import { concentrationOf } from '../src/ctr-analytics.ts';
import { csvOf, xlsxOf } from '../src/dis-export.ts';

const AS_OF = '2030-06-30';
let seq = 0;

/** A contract as the fact gives it; each test says only what it is about. */
function fact(extra: Partial<ContractFact> = {}): ContractFact {
  seq += 1;
  return {
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    code: `HD-${seq}`,
    title: `Hop dong ${seq}`,
    contractStatus: 'ACTIVE',
    contractType: 'LUMP_SUM',
    projectId: 'p1',
    projectCode: 'DA-1',
    projectName: 'Du an 1',
    packageId: 'k1',
    contractorId: 'c1',
    contractorName: 'Nha thau 1',
    isJointVenture: false,
    unitId: 'u1',
    unitName: 'Don vi 1',
    investorId: null,
    fundSourceVersionId: null,
    signedOn: '2030-01-01',
    originalDueDate: '2030-06-01',
    completedOn: null,
    terminatedOn: null,
    approvedExtensionDays: 0,
    milestoneCount: 0,
    milestonePastDueCount: 0,
    contractValueVnd: '1000',
    originalValueVnd: '1000',
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

const CODES = CTR_REPORT_CODES.filter((code): code is Exclude<CtrReportCode, 'contractor-concentration'> => code !== 'contractor-concentration');

const PORTFOLIO: ContractFact[] = [
  fact({ contractValueVnd: '1000', originalValueVnd: '900', approvedChangeDeltaVnd: '100', approvedChangeCount: 2, maxChangeTier: 2, maxCumulativeVariationPct: '11.11', winningBidVnd: '880', bidderCount: 1, requestedVnd: '500', acceptedVnd: '400', paidVnd: '440', measuredVnd: '420', advancePaidVnd: '200', advanceRecoveredVnd: '50', firstAdvanceOn: '2030-01-10', retentionWithheldVnd: '40', retentionReleasedVnd: '10', guaranteeRequiredVnd: '100', guaranteeValidVnd: '0', guaranteeNextExpiryOn: '2030-05-01', acceptanceToRequestDaysMax: 20, requestToTreasuryDaysMax: 5, paymentsSentCount: 2, originalDueDate: '2030-05-01' }),
  fact({ contractValueVnd: '3000', originalValueVnd: '3000', winningBidVnd: '3100', bidderCount: 4, requestedVnd: '2000', acceptedVnd: '1900', paidVnd: '1500', measuredVnd: '1900', advancePaidVnd: '600', advanceRecoveredVnd: '600', firstAdvanceOn: '2029-01-10', guaranteeRequiredVnd: '300', guaranteeValidVnd: '300', guaranteeNextExpiryOn: '2031-01-01', acceptanceToRequestDaysMax: 3, requestToTreasuryDaysMax: 2, completedOn: '2030-06-10', contractStatus: 'COMPLETED' }),
  fact({ contractValueVnd: '500', originalValueVnd: '500', contractStatus: 'DRAFT', originalDueDate: null }),
  fact({ contractValueVnd: '700', originalValueVnd: '650', approvedChangeDeltaVnd: '50', approvedChangeCount: 1, maxChangeTier: 1, maxCumulativeVariationPct: '7.69', bidderCount: 2, requestedVnd: '100', acceptedVnd: '100', paidVnd: '90', ledgerOk: false }),
];

describe('the catalogue of the reports of the portfolio', () => {
  it('has eight reports, each with its reference, and every column of a report is a known column', () => {
    expect(CTR_REPORT_CODES).toHaveLength(8);
    expect(new Set(CTR_REPORT_CODES.map((code) => REPORT_CATALOGUE[code].ref))).toEqual(new Set(['R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7', 'R14']));
    for (const code of CODES) {
      const keys = REPORT_COLUMNS[code].map((column) => column.key);
      expect(new Set(keys).size).toBe(keys.length);
      expect(REPORT_SUMS[code].length).toBeGreaterThan(0);
    }
  });

  it('points the "i" of a ratio column at an indicator that is defined once', () => {
    expect(indicatorOfColumn('bid-variance', 'bid_variance_pct')).toBe('BID_PRICE_VARIANCE');
    expect(indicatorOfColumn('portfolio-status', 'paid_to_accepted_pct')).toBe('PAID_TO_ACCEPTED');
    expect(indicatorOfColumn('retention-guarantee', 'guarantee_coverage_pct')).toBe('GUARANTEE_COVERAGE');
    expect(indicatorOfColumn('portfolio-status', 'code')).toBeNull();
  });

  it('builds a document for every report: titles and labels are all in the messages', () => {
    for (const code of CODES) {
      const rows = PORTFOLIO.map((one) => reportRowOf(code, one, { asOf: AS_OF }));
      const totals = totalsOfSums(code, sumsOfFacts(PORTFOLIO, AS_OF));
      const document = reportDocumentOf({ code, scopeDescription: 's', periodLabel: AS_OF, asOf: AS_OF, cutoffDate: '', snapshotId: '', snapshotRevision: '', stale: false, generatedAt: new Date('2030-07-01T00:00:00Z'), filterText: '', columns: REPORT_COLUMNS[code], rows, totals });
      expect(document.columns).toHaveLength(REPORT_COLUMNS[code].length);
      expect(document.rows).toHaveLength(PORTFOLIO.length + 1);
      expect(document.rows.every((row) => row.length === document.columns.length)).toBe(true);
    }
  });
});

describe('the additive figures: the total is the sum of the rows', () => {
  it('adds up, to the dong, for every sum a report reads', () => {
    const sums = sumsOfFacts(PORTFOLIO, AS_OF);
    expect(sums.contract_value).toBe('5200');
    expect(sums.original_value).toBe('5050');
    expect(sums.change_delta).toBe('150');
    // The ledger sums leave out the contract whose ledger the reader may not see.
    expect(sums.requested).toBe('2500');
    expect(sums.paid).toBe('1940');
    expect(sums.rows).toBe(4);
    expect(sums.ledgerRows).toBe(3);
    const rows = PORTFOLIO.map((one) => reportRowOf('portfolio-status', one, { asOf: AS_OF }));
    const totals = totalsOfSums('portfolio-status', sums);
    const column = (key: string): bigint => rows.reduce((acc, row) => acc + BigInt((row.cells[key] as string | null) ?? '0'), 0n);
    expect(totals.cells.contract_value_vnd).toBe(column('contract_value_vnd').toString());
    expect(totals.cells.approved_change_delta_vnd).toBe(column('approved_change_delta_vnd').toString());
    expect(totals.cells.paid_vnd).toBe(column('paid_vnd').toString());
    expect(totals.cells.accepted_vnd).toBe(column('accepted_vnd').toString());
  });

  it('shows the ledger a reader may not see as denied, never as zero, in the row and (for all rows denied) in the total', () => {
    const denied = reportRowOf('portfolio-status', PORTFOLIO[3] as ContractFact, { asOf: AS_OF });
    expect(denied.cells.paid_vnd).toBeNull();
    expect(denied.na.paid_vnd).toBe('LEDGER_DENIED');
    expect(denied.cells.contract_value_vnd).toBe('700');
    const nothing = totalsOfSums('portfolio-status', sumsOfFacts([{ ...(PORTFOLIO[0] as ContractFact), ledgerOk: false }], AS_OF));
    expect(nothing.cells.paid_vnd).toBeNull();
    expect(nothing.na.paid_vnd).toBe('LEDGER_DENIED');
    expect(nothing.cells.paid_to_accepted_pct).toBeNull();
  });
});

describe('the ratios: the ratio of the totals, never the mean of the ratios', () => {
  it('gives the bid variance of the portfolio as sum(contract - bid) / sum(bid) over the contracts that have a bid', () => {
    // 900 vs 880 (+20), 3000 vs 3100 (-100): (3900 - 3980) / 3980 = -2.01 percent; the mean of the two rows would be about -0.5.
    const totals = totalsOfSums('bid-variance', sumsOfFacts(PORTFOLIO, AS_OF));
    expect(totals.cells.bid_variance_pct).toBe('-2.01');
    const rows = PORTFOLIO.slice(0, 2).map((one) => reportRowOf('bid-variance', one, { asOf: AS_OF }));
    expect(rows.map((row) => row.cells.bid_variance_pct)).toEqual(['2.27', '-3.23']);
    expect(PORTFOLIO[2] && reportRowOf('bid-variance', PORTFOLIO[2], { asOf: AS_OF }).na.bid_variance_pct).toBe('NO_WINNING_BID');
  });

  it('gives paid over accepted from the sums and says why a ratio has no figure', () => {
    const totals = totalsOfSums('payment-three-way', sumsOfFacts(PORTFOLIO, AS_OF));
    // ledger rows only: paid 440 + 1500 over accepted 400 + 1900
    expect(totals.cells.paid_to_accepted_pct).toBe('84.35');
    const empty = reportRowOf('payment-three-way', fact(), { asOf: AS_OF });
    expect(empty.cells.paid_to_accepted_pct).toBeNull();
    expect(empty.na.paid_to_accepted_pct).toBe('ZERO_DENOMINATOR');
  });

  it('counts the single-bidder rate over the contracts whose bidder count is known', () => {
    const totals = totalsOfSums('bid-variance', sumsOfFacts(PORTFOLIO, AS_OF));
    expect(totals.cells.single_bidder).toBe('33.33');
  });

  it('gives advance, retention and guarantee from the sums of the contracts that have them', () => {
    const advance = totalsOfSums('advance-ageing', sumsOfFacts(PORTFOLIO, AS_OF));
    expect(advance.cells.advance_outstanding_vnd).toBe('150');
    expect(advance.cells.advance_outstanding_pct).toBe('18.75');
    const keep = totalsOfSums('retention-guarantee', sumsOfFacts(PORTFOLIO, AS_OF));
    expect(keep.cells.retention_held_vnd).toBe('30');
    expect(keep.cells.guarantee_coverage_pct).toBe('75.00');
    expect(keep.cells.guarantee_exposure_vnd).toBe('100');
  });
});

describe('the days late, the age of an advance and the payment clock', () => {
  it('counts days late against the ORIGINAL due date, to the completion day or to the as-of day while open, never below 0', () => {
    expect(daysLateOfFact(fact({ originalDueDate: '2030-05-01' }), AS_OF)).toEqual({ value: 60, reason: null });
    expect(daysLateOfFact(fact({ originalDueDate: '2030-05-01', completedOn: '2030-05-11', contractStatus: 'COMPLETED' }), AS_OF)).toEqual({ value: 10, reason: null });
    expect(daysLateOfFact(fact({ originalDueDate: '2030-12-01' }), AS_OF)).toEqual({ value: 0, reason: null });
    expect(daysLateOfFact(fact({ originalDueDate: null }), AS_OF).value).toBeNull();
    expect(daysLateOfFact(fact({ contractStatus: 'DRAFT' }), AS_OF).value).toBeNull();
    expect(daysLateOfFact(fact({ originalDueDate: '2030-05-01', terminatedOn: '2030-05-21', contractStatus: 'TERMINATED' }), AS_OF).value).toBe(20);
  });

  it('bands the figures', () => {
    expect([ageBucketOf(0), ageBucketOf(90), ageBucketOf(91), ageBucketOf(365), ageBucketOf(366), ageBucketOf(null)]).toEqual(['UP_TO_90', 'UP_TO_90', 'D91_180', 'D181_365', 'OVER_365', null]);
    expect([delayBandOf(0), delayBandOf(1), delayBandOf(31), delayBandOf(91), delayBandOf(null)]).toEqual(['NOT_LATE', 'LATE_1_30', 'LATE_31_90', 'LATE_OVER_90', 'NOT_APPLICABLE']);
    expect([bidderBandOf(1), bidderBandOf(3), bidderBandOf(4), bidderBandOf(null)]).toEqual(['ONE', 'TWO_THREE', 'FOUR_PLUS', 'UNKNOWN']);
    expect([tierBandOf(null), tierBandOf(2)]).toEqual(['NONE', 'TIER_2']);
  });

  it('judges the payment clock by the rule: late when any step took longer, no payment is not within', () => {
    const rule = paymentClockDefaults();
    expect(paymentClockOf({ acceptanceToRequestDaysMax: 14, requestToTreasuryDaysMax: 7 }, rule)).toBe('WITHIN');
    expect(paymentClockOf({ acceptanceToRequestDaysMax: 15, requestToTreasuryDaysMax: 1 }, rule)).toBe('LATE');
    expect(paymentClockOf({ acceptanceToRequestDaysMax: 1, requestToTreasuryDaysMax: 8 }, rule)).toBe('LATE');
    expect(paymentClockOf({ acceptanceToRequestDaysMax: null, requestToTreasuryDaysMax: null }, rule)).toBe('NO_PAYMENT');
    expect(() => paymentClockParams({ acceptance_to_request_days: 0, request_to_treasury_days: 7 })).toThrow();
    expect(() => paymentClockParams({ acceptance_to_request_days: 10, request_to_treasury_days: 7, extra: 1 })).toThrow();
  });

  it('colours the portfolio row from the health rule and leaves the ledger out for a reader who may not see it', () => {
    const late = fact({ originalDueDate: '2030-01-01', requestedVnd: '100', acceptedVnd: '100', paidVnd: '130' });
    expect(healthOfFact(late, AS_OF).level).toBe('RED');
    expect(healthOfFact(late, AS_OF).drivers).toEqual(expect.arrayContaining(['DAYS_LATE', 'PAID_TO_ACCEPTED']));
    const row = reportRowOf('portfolio-status', { ...late, ledgerOk: false }, { asOf: AS_OF });
    expect(row.health?.readings.find((reading) => reading.dimension === 'PAID_TO_ACCEPTED')?.level).toBeNull();
    expect(row.cells.health).toBe('RED');
  });
});

describe('the concentration and load of the contractors (R14)', () => {
  const inputs: ConcentrationInput[] = [
    { id: 'a', status: 'ACTIVE', valueVnd: '600', investorKey: 'i1', unitKey: 'u1', fundKey: 'f1', contractorId: 'k1', bidderCount: 1 },
    { id: 'b', status: 'ACTIVE', valueVnd: '300', investorKey: 'i1', unitKey: 'u2', fundKey: 'f1', contractorId: 'k2', bidderCount: 3 },
    {
      id: 'c',
      status: 'ACTIVE',
      valueVnd: '100',
      investorKey: 'i2',
      unitKey: 'u2',
      fundKey: null,
      contractorId: 'k1',
      bidderCount: null,
      parties: [
        { contractorId: 'k1', sharePct: '50.0000', status: 'ACTIVE' },
        { contractorId: 'k3', sharePct: '50.0000', status: 'ACTIVE' },
      ],
    },
    { id: 'd', status: 'DRAFT', valueVnd: '9999', investorKey: 'i9', unitKey: 'u9', fundKey: 'f9', contractorId: 'k9', bidderCount: 1 },
  ];

  it('recomputes top share and HHI from the raw rows of the portfolio, a joint venture counted once by its shares', () => {
    const report = concentrationReport(inputs, { ...concentrationDefaults(), min_contracts: 1, top_n: 1 });
    const contractor = report.dimensions.find((one) => one.dimension === 'contractor');
    // k1 = 600 + 50, k2 = 300, k3 = 50: total 1000, top 1 = 65.00; HHI = 65^2 + 30^2 + 5^2 = 5150
    expect(contractor?.groups.map((group) => [group.key, group.valueVnd])).toEqual([['k1', '650'], ['k2', '300'], ['k3', '50']]);
    expect(contractor?.top.value).toBe('65.00');
    expect(contractor?.hhi.value).toBe('5150.00');
    expect(contractor?.totalVnd).toBe('1000');
    // the same figures straight from the part-1 function: one definition
    expect(concentrationOf(inputs.map((input) => ({ contractId: input.id, status: input.status, valueVnd: input.valueVnd, investorKey: input.investorKey, unitKey: input.unitKey, fundKey: input.fundKey, contractorId: input.contractorId, parties: input.parties })), 'contractor', 1).hhi.value).toBe('5150.00');
    // a contract that is only a draft is not exposure
    expect(report.dimensions.find((one) => one.dimension === 'unit')?.groups.map((group) => group.key)).toEqual(['u1', 'u2']);
    expect(report.activeValueVnd).toBe('1000');
    expect(report.activeContracts).toBe(3);
  });

  it('judges only a portfolio that is big enough, and says so', () => {
    const small = concentrationReport(inputs);
    expect(small.dimensions.every((dimension) => dimension.level === 'NOT_ENOUGH_DATA')).toBe(true);
    expect(small.singleBidderLevel).toBe('NOT_ENOUGH_DATA');
    const judged = concentrationReport(inputs, { ...concentrationDefaults(), min_contracts: 3, top_n: 1 });
    expect(judged.dimensions.find((one) => one.dimension === 'contractor')?.level).toBe('RED');
    // single bidder: 1 of the 2 contracts whose count is known
    expect(judged.singleBidder.value).toBe('50.00');
    expect(judged.singleBidderLevel).toBe('RED');
  });

  it('counts a contract by its value or by itself', () => {
    const count = concentrationReport(inputs, { ...concentrationDefaults(), basis: 'CONTRACT_COUNT', min_contracts: 1, top_n: 1 });
    const investor = count.dimensions.find((one) => one.dimension === 'investor');
    // i1 holds 2 of the 3 active contracts
    expect(investor?.top.value).toBe('66.67');
  });

  it('lists the load of each contractor, with what is awarded and not yet contracted', () => {
    const load = contractorLoadOf(inputs, new Map([['k2', '75'], ['k7', '40']]));
    expect(load.map((one) => [one.contractorId, one.activeContracts, one.activeValueVnd, one.pendingAwardVnd])).toEqual([
      ['k1', 2, '650', '0'],
      ['k2', 1, '300', '75'],
      ['k3', 1, '50', '0'],
      ['k7', 0, '0', '40'],
    ]);
  });

  it('writes a file whose groups add up to the total and whose figures can be read back', () => {
    const report = concentrationReport(inputs, { ...concentrationDefaults(), min_contracts: 1 });
    const document = concentrationDocumentOf(
      report,
      { scopeDescription: 's', periodLabel: AS_OF, asOf: AS_OF, cutoffDate: '', snapshotId: '', snapshotRevision: '', stale: false, generatedAt: new Date('2030-07-01T00:00:00Z'), filterText: '' },
      new Map([['k1', 'Nha thau 1']]),
    );
    const contractorRows = document.rows.filter((row) => row[0] === 'contractor' && !['TOP_N_SHARE', 'HHI', 'LEVEL'].includes(row[1] as string));
    expect(contractorRows.reduce((acc, row) => acc + BigInt(row[3] as string), 0n).toString()).toBe(report.dimensions.find((one) => one.dimension === 'contractor')?.totalVnd);
    expect(csvOf(document)).toContain('HHI');
    expect(xlsxOf(document).byteLength).toBeGreaterThan(100);
  });
});
