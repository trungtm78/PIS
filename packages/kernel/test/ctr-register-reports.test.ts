import { CTR_INDICATORS } from '../src/ctr-analytics.ts';
import {
  REGISTER_CATALOGUE,
  REGISTER_COLUMNS,
  REGISTER_REPORT_CODES,
  claimLimitationDefaults,
  claimLimitationParams,
  claimRow,
  defectRow,
  filterRegisterRows,
  findingRow,
  healthRow,
  limitationOf,
  obstacleRow,
  registerBreakdowns,
  registerDocumentOf,
  registerPage,
  registerTotals,
  sortRegisterRows,
} from '../src/ctr-register-reports.ts';
import type { ClaimRecord, DefectRecord, FindingRecord, ObstacleRecord, RegisterContract } from '../src/ctr-register-reports.ts';
import type { ContractFact } from '../src/ctr-reports.ts';
import { xlsxOf, csvOf } from '../src/dis-export.ts';

const AS_OF = '2026-11-08';
const contract = (code: string, ledgerOk = true): RegisterContract => ({ id: `c-${code}`, code, title: `Title ${code}`, projectCode: 'P-1', contractorName: 'Contractor', unitName: 'Unit', status: 'ACTIVE', ledgerOk });
const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const claim = (n: number, patch: Partial<ClaimRecord> = {}): ClaimRecord => ({
  id: uuid(n),
  contract: contract(`HD-${n}`),
  source: 'VARIATION',
  code: `CR-${n}`,
  kind: 'DESIGN_CHANGE',
  title: null,
  state: 'OPEN',
  filedOn: '2026-10-20',
  decidedOn: null,
  claimedAmountVnd: '1000',
  grantedAmountVnd: null,
  claimedDays: null,
  grantedDays: null,
  limitation: { basis: 'DECISION_WINDOW', startOn: '2026-10-20' },
  ...patch,
});

describe('the catalogue of the register reports', () => {
  it('has columns, a breakdown and indicator definitions for every report', () => {
    for (const code of REGISTER_REPORT_CODES) {
      const columns = REGISTER_COLUMNS[code];
      expect(columns.length).toBeGreaterThan(5);
      expect(new Set(columns.map((column) => column.key)).size).toBe(columns.length);
      expect(columns[0]?.key).toBe(REGISTER_CATALOGUE[code].idColumn);
      for (const column of columns) {
        if (column.total === 'RATIO') expect(column.indicator).not.toBeNull();
        if (column.indicator !== null) expect(CTR_INDICATORS[column.indicator].formula.length).toBeGreaterThan(10);
      }
      for (const indicator of REGISTER_CATALOGUE[code].indicators) expect(CTR_INDICATORS[indicator].sourceTables.length).toBeGreaterThan(0);
    }
  });
});

describe('claims and limitation', () => {
  const params = claimLimitationDefaults();

  it('judges the limitation of an open variation by its decision window', () => {
    // filed 20 Oct, window 28 days: the day is 17 Nov; today 8 Nov leaves 9 days, more than the 7 of "near"
    expect(limitationOf(claim(1), AS_OF, params)).toEqual({ on: '2026-11-17', status: 'RUNNING', daysLeft: 9 });
    expect(limitationOf(claim(1), '2026-11-12', params).status).toBe('NEAR');
    expect(limitationOf(claim(1), '2026-11-18', params)).toMatchObject({ status: 'LAPSED', daysLeft: null });
  });

  it('judges a warranty claim by the end of the warranty and a decided variation by the day it was decided', () => {
    expect(limitationOf(claim(2, { limitation: { basis: 'WARRANTY_END', on: '2026-12-31' }, filedOn: '2026-12-31' }), AS_OF, params).status).toBe('IN_TIME');
    expect(limitationOf(claim(2, { limitation: { basis: 'WARRANTY_END', on: '2026-10-01' }, filedOn: '2026-10-02' }), AS_OF, params).status).toBe('OUT_OF_TIME');
    expect(limitationOf(claim(3, { state: 'GRANTED', decidedOn: '2026-11-01' }), AS_OF, params).status).toBe('IN_TIME');
    expect(limitationOf(claim(3, { state: 'GRANTED', decidedOn: '2026-11-30' }), '2026-12-05', params).status).toBe('OUT_OF_TIME');
  });

  it('says a claim with no term is not judged, with the reason, and never as zero', () => {
    const row = claimRow(claim(4, { limitation: null }), AS_OF, params);
    expect(row.cells.limitation_status).toBe('NOT_JUDGED');
    expect(row.cells.limitation_on).toBeNull();
    expect(row.na.limitation_on).toBe('NO_LIMITATION_TERM');
    expect(row.cells.limitation_risk).toBeNull();
    expect(row.na.limitation_risk).toBe('NO_LIMITATION_TERM');
  });

  it('makes the totals from the rows: sums are the sums, the settlement rate is of the sums of decided claims', () => {
    const rows = [
      claimRow(claim(1, { state: 'GRANTED', decidedOn: '2026-11-01', claimedAmountVnd: '1000', grantedAmountVnd: '600' }), AS_OF, params),
      claimRow(claim(2, { state: 'REJECTED', decidedOn: '2026-11-02', claimedAmountVnd: '3000', grantedAmountVnd: null }), AS_OF, params),
      claimRow(claim(3, { claimedAmountVnd: '500' }), AS_OF, params),
      claimRow(claim(4, { state: 'WITHDRAWN', decidedOn: '2026-11-03', claimedAmountVnd: null }), AS_OF, params),
    ];
    const totals = registerTotals('claims-limitation', rows);
    expect(totals.rows).toBe(4);
    expect(totals.cells.claimed_amount_vnd).toBe('4500');
    expect(totals.cells.granted_amount_vnd).toBe('600');
    // 600 granted of 4000 claimed in the two decided claims that state an amount: 15.00 percent, not the mean of 60 and 0
    expect(totals.cells.settlement_pct).toBe('15.00');
    expect(totals.indicators.find((one) => one.code === 'CLAIM_SETTLEMENT_RATE')).toMatchObject({ numerator: '600', denominator: '4000' });
    // one open claim with a window that runs: no risk; the rate is 0 of 1, a figure, not "no data"
    expect(totals.cells.limitation_risk).toBe('0.00');
  });

  it('has no rate and a named reason when nothing was decided', () => {
    const totals = registerTotals('claims-limitation', [claimRow(claim(1), AS_OF, claimLimitationDefaults())]);
    expect(totals.cells.settlement_pct).toBeNull();
    expect(totals.na.settlement_pct).toBe('NO_DECIDED_CLAIM');
    expect(registerTotals('claims-limitation', []).cells.claimed_amount_vnd).toBeNull();
  });

  it('checks the params of the rule', () => {
    expect(claimLimitationParams({ decision_window_days: 30, near_days: 5 })).toEqual({ decision_window_days: 30, near_days: 5 });
    for (const bad of [{ decision_window_days: 0, near_days: 1 }, { decision_window_days: 5, near_days: -1 }, { decision_window_days: 5 }, { decision_window_days: 5, near_days: 1, other: 1 }, []]) {
      expect(() => claimLimitationParams(bad)).toThrow();
    }
  });
});

const defect = (n: number, patch: Partial<DefectRecord> = {}): DefectRecord => ({
  id: uuid(100 + n),
  contract: contract(`HD-${n}`),
  ncrNo: `NCR-${n}`,
  title: null,
  severity: 'MAJOR',
  status: 'OPEN',
  detectedOn: '2026-10-01',
  dueOn: '2026-10-31',
  closedOn: null,
  reopenCount: 0,
  blocksAcceptance: false,
  ...patch,
});

describe('quality defects', () => {
  it('counts the overdue rate over open defects only and the closure rate over all', () => {
    const rows = [
      defectRow(defect(1), AS_OF),
      defectRow(defect(2, { dueOn: '2026-12-01' }), AS_OF),
      defectRow(defect(3, { status: 'CLOSED', closedOn: '2026-10-20', reopenCount: 1 }), AS_OF),
      defectRow(defect(4, { status: 'VERIFIED', closedOn: '2026-10-25' }), AS_OF),
    ];
    expect(rows[0]?.cells.days_overdue).toBe(8);
    expect(rows[2]?.cells.days_overdue).toBeNull();
    expect(rows[2]?.na.days_overdue).toBe('NOT_OPEN');
    const totals = registerTotals('quality-defects', rows);
    expect(totals.cells.overdue).toBe('50.00');
    expect(totals.cells.closed).toBe('50.00');
    expect(totals.cells.reopened).toBe('25.00');
    expect(totals.cells.reopen_count).toBe(1);
    expect(totals.cells.days_overdue).toBe(8);
    const groups = registerBreakdowns('quality-defects', rows).find((one) => one.dimension === 'ncr_status');
    expect(groups?.groups.map((group) => group.key)).toEqual(['OPEN', 'VERIFIED', 'CLOSED']);
    // the groups add up to the total
    expect(groups?.groups.reduce((acc, group) => acc + group.totals.rows, 0)).toBe(totals.rows);
  });

  it('has no overdue rate when no defect is open', () => {
    const totals = registerTotals('quality-defects', [defectRow(defect(1, { status: 'CLOSED', closedOn: '2026-10-20' }), AS_OF)]);
    expect(totals.cells.overdue).toBeNull();
    expect(totals.na.overdue).toBe('NO_OPEN_DEFECT');
  });
});

const obstacle = (n: number, patch: Partial<ObstacleRecord> = {}): ObstacleRecord => ({
  id: uuid(200 + n),
  contract: contract(`HD-${n}`),
  code: `ISS-${n}`,
  title: null,
  severity: 'HIGH',
  status: 'IN_PROGRESS',
  sourceModule: null,
  openedOn: '2026-10-01',
  dueOn: '2026-11-01',
  closedOn: null,
  escalationLevel: 0,
  extensionCount: 1,
  reopenCount: 0,
  ...patch,
});

describe('obstacles', () => {
  it('judges overdue and escalation over the open issues', () => {
    const rows = [obstacleRow(obstacle(1), AS_OF), obstacleRow(obstacle(2, { dueOn: '2026-12-01', escalationLevel: 2 }), AS_OF), obstacleRow(obstacle(3, { status: 'CLOSED', closedOn: '2026-10-10' }), AS_OF)];
    const totals = registerTotals('obstacles', rows);
    expect(totals.cells.overdue).toBe('50.00');
    expect(totals.cells.escalated).toBe('50.00');
    expect(totals.cells.escalation_level).toBe(2);
    expect(totals.cells.extension_count).toBe(3);
    expect(rows[2]?.na.overdue).toBe('NOT_OPEN');
  });
});

const finding = (n: number, patch: Partial<FindingRecord> = {}): FindingRecord => ({
  id: uuid(300 + n),
  contract: contract(`HD-${n}`),
  findingCode: `F-${n}`,
  category: 'FINANCIAL',
  severity: 'MAJOR',
  engagementCode: 'KT-1',
  amountVnd: '5000',
  recommendedVnd: '4000',
  recoveredVnd: '1000',
  financialRecommendationCount: 1,
  recommendationCount: 2,
  openRecommendationCount: 2,
  overdueRecommendationCount: 1,
  ...patch,
});

describe('audit findings and recoveries', () => {
  it('adds the recovery as a ratio of sums and leaves out a finding with no financial recommendation', () => {
    const rows = [findingRow(finding(1)), findingRow(finding(2, { recommendedVnd: '6000', recoveredVnd: '6000' })), findingRow(finding(3, { financialRecommendationCount: 0, recommendedVnd: '0', recoveredVnd: '0', openRecommendationCount: 0, overdueRecommendationCount: 0 }))];
    expect(rows[2]?.cells.recovery_pct).toBeNull();
    expect(rows[2]?.na.recovery_pct).toBe('NO_FINANCIAL_RECOMMENDATION');
    const totals = registerTotals('audit-findings', rows);
    expect(totals.cells.recommended_vnd).toBe('10000');
    expect(totals.cells.recovered_vnd).toBe('7000');
    expect(totals.cells.outstanding_vnd).toBe('3000');
    expect(totals.cells.recovery_pct).toBe('70.00');
    expect(totals.cells.overdue_recommendation_pct).toBe('50.00');
  });

  it('hides the money of a contract whose ledger the reader may not see, and the total leaves it out', () => {
    const hidden = findingRow(finding(1, { contract: contract('HD-1', false) }));
    expect(hidden.cells.recommended_vnd).toBeNull();
    expect(hidden.na.recommended_vnd).toBe('LEDGER_DENIED');
    const mixed = registerTotals('audit-findings', [hidden, findingRow(finding(2))]);
    expect(mixed.cells.recommended_vnd).toBe('4000');
    expect(mixed.ledgerRows).toBe(1);
    const none = registerTotals('audit-findings', [hidden]);
    expect(none.cells.recommended_vnd).toBeNull();
    expect(none.na.recommended_vnd).toBe('LEDGER_DENIED');
    expect(none.cells.recovery_pct).toBeNull();
    // counts are not money: they stay
    expect(none.cells.recommendation_count).toBe(2);
  });
});

const fact = (n: number, patch: Partial<ContractFact> = {}): ContractFact =>
  ({
    id: uuid(400 + n),
    code: `HD-${n}`,
    title: null,
    contractStatus: 'ACTIVE',
    contractType: 'LUMP_SUM',
    projectId: uuid(1),
    projectCode: 'P-1',
    projectName: 'Project',
    packageId: uuid(2),
    contractorId: uuid(3),
    contractorName: 'Contractor',
    isJointVenture: false,
    unitId: uuid(4),
    unitName: 'Unit',
    investorId: null,
    fundSourceVersionId: null,
    signedOn: '2026-01-01',
    originalDueDate: '2026-12-31',
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
    openNcrCount: 2,
    projectOpenIssueCount: 3,
    auditFindingCount: 0,
    daysLate: null,
    asOfDate: AS_OF,
    ledgerOk: true,
    ...patch,
  }) as ContractFact;

describe('the health of the contracts', () => {
  it('takes the colour from the worst indicator and counts the red share over the coloured contracts only', () => {
    const late = healthRow(fact(1, { originalDueDate: '2026-08-01' }), contract('HD-1'), AS_OF, undefined);
    const green = healthRow(fact(2), contract('HD-2'), AS_OF, undefined);
    const none = healthRow(fact(3, { originalDueDate: null, originalValueVnd: '0' }), contract('HD-3'), AS_OF, undefined);
    expect(late.cells.health).toBe('RED');
    expect(late.cells.health_driver).toBe('DAYS_LATE');
    expect(green.cells.health).toBe('GREEN');
    expect(none.cells.health).toBeNull();
    expect(none.na.health).toBe('NO_COLOURED_CONTRACT');
    const totals = registerTotals('contract-health', [late, green, none]);
    expect(totals.cells.red).toBe('50.00');
    expect(totals.indicators.find((one) => one.code === 'CONTRACT_RED_SHARE')).toMatchObject({ numerator: '1', denominator: '2' });
    // the project issue count belongs to the project, so it has no total
    expect(totals.cells.project_open_issue_count).toBeUndefined();
    expect(totals.cells.open_ncr_count).toBe(6);
    const groups = registerBreakdowns('contract-health', [late, green, none]).find((one) => one.dimension === 'health');
    expect(groups?.groups.map((group) => group.key)).toEqual(['RED', 'GREEN', 'NONE']);
  });
});

describe('order, pages, filters and files', () => {
  const rows = [3, 1, 2, 4].map((n) => defectRow(defect(n, { detectedOn: `2026-10-0${n}` }), AS_OF));

  it('sorts with a missing figure first and by id after, the same on every run', () => {
    expect(sortRegisterRows('quality-defects', rows, 'ncr_no', 'asc').map((row) => row.cells.ncr_no)).toEqual(['NCR-1', 'NCR-2', 'NCR-3', 'NCR-4']);
    expect(sortRegisterRows('quality-defects', rows, 'ncr_no', 'desc').map((row) => row.cells.ncr_no)).toEqual(['NCR-4', 'NCR-3', 'NCR-2', 'NCR-1']);
    expect(() => sortRegisterRows('quality-defects', rows, 'nope', 'asc')).toThrow();
  });

  it('pages by a keyset on the sort cell and the id, and every row appears once', () => {
    const sorted = sortRegisterRows('quality-defects', rows, 'detected_on', 'asc');
    const seen: string[] = [];
    let after: { value: string; id: string } | undefined;
    for (let guard = 0; guard < 10; guard += 1) {
      const page = registerPage('quality-defects', sorted, { sort: 'detected_on', direction: 'asc', limit: 3, after });
      seen.push(...page.items.map((row) => row.id));
      const last = page.items[page.items.length - 1];
      if (!page.more || last === undefined) break;
      after = { value: String(last.cells.detected_on ?? ''), id: last.id };
    }
    expect(seen).toEqual(sorted.map((row) => row.id));
  });

  it('filters by severity and state on the cells', () => {
    const mixed = [defectRow(defect(1, { severity: 'CRITICAL' }), AS_OF), defectRow(defect(2, { severity: 'MINOR', status: 'CLOSED', closedOn: '2026-10-05' }), AS_OF)];
    expect(filterRegisterRows('quality-defects', mixed, { severity: ['CRITICAL'] })).toHaveLength(1);
    expect(filterRegisterRows('quality-defects', mixed, { state: ['CLOSED'] })).toHaveLength(1);
    expect(filterRegisterRows('quality-defects', mixed, { severity: ['MINOR'], state: ['OPEN'] })).toHaveLength(0);
    // a report with no severity column cannot be filtered by it: nothing matches, never everything
    expect(filterRegisterRows('claims-limitation', [claimRow(claim(1), AS_OF, claimLimitationDefaults())], { severity: ['MAJOR'] })).toHaveLength(0);
  });

  it('writes the file with the totals row equal to the totals of the rows, and reads back through xlsx and csv', () => {
    const claims = [
      claimRow(claim(1, { state: 'GRANTED', decidedOn: '2026-11-01', claimedAmountVnd: '1000', grantedAmountVnd: '600' }), AS_OF, claimLimitationDefaults()),
      claimRow(claim(2, { claimedAmountVnd: '500' }), AS_OF, claimLimitationDefaults()),
    ];
    const totals = registerTotals('claims-limitation', claims);
    const document = registerDocumentOf({ code: 'claims-limitation', scopeDescription: 'scope', periodLabel: AS_OF, asOf: AS_OF, cutoffDate: '', snapshotId: '', snapshotRevision: '', stale: false, generatedAt: new Date('2026-11-08T01:00:00Z'), filterText: 'none', rows: claims, totals });
    const keys = document.columns.map((column) => column.key);
    const last = document.rows[document.rows.length - 1] as string[];
    expect(last[keys.indexOf('claimed_amount_vnd')]).toBe('1500');
    expect(last[keys.indexOf('granted_amount_vnd')]).toBe('600');
    expect(document.rows).toHaveLength(3);
    expect(csvOf(document)).toContain('1500');
    expect(xlsxOf(document).length).toBeGreaterThan(200);
    // a code is written as its word
    expect(document.rows[0]?.[keys.indexOf('claim_status')]).toBe('Chấp thuận');
  });
});
