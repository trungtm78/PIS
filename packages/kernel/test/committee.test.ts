import { COMMITTEE_KPI_DEFAULTS, COMMITTEE_POLICY_DEFAULTS, committeePolicyParams, defaultCommitteePolicy, parseCommitteePolicy } from '../src/committee-policy';
import { factsDefects, feedStatusOf } from '../src/committee-facts';
import type { ProvinceFacts } from '../src/committee-facts';
import { seedProvinceFacts } from '../src/committee-seed';
import {
  aggregateBy,
  attentionSignalsOf,
  buildWorkspace,
  evaluateCommitteeAlerts,
  expectedPctOn,
  figuresOf,
  outlookBandOf,
  percentText,
  pointsBetween,
  provinceRowOf,
  rankAttention,
  unitReportingOf,
} from '../src/committee';
import { builtInDefault, registerAllGovernanceRules, validateRuleParams } from '../src/governance-rules';
import { message } from '../src/messages';
import { COMMITTEE_PACK_LAYOUT, packDatasetsOf } from '../src/committee-pack-form';
import { validateLayout } from '../src/report-layout';

const POLICY = COMMITTEE_POLICY_DEFAULTS;
const ASOF = '2026-09-30';

const project = (over: Partial<ProvinceFacts['projects'][number]> = {}): ProvinceFacts['projects'][number] => ({
  projectId: '00000000-0000-4000-8000-000000000001',
  code: 'P-1',
  name: 'Project one',
  status: 'IMPLEMENTATION',
  investorUnitId: '00000000-0000-4000-8100-000000000001',
  investorName: 'Investor',
  sectorCode: 'TRANSPORT',
  sectorName: 'Transport',
  districtCode: 'D01',
  districtName: 'District',
  totalInvestmentVnd: '100000000000',
  eacVnd: null,
  delayDays: null,
  stalledDays: null,
  stalledStep: null,
  lastReportedOn: '2026-09-28',
  ...over,
});
const line = (over: Partial<ProvinceFacts['lines'][number]> = {}): ProvinceFacts['lines'][number] => ({
  projectId: '00000000-0000-4000-8000-000000000001',
  fundSourceCode: 'NSDP',
  fundSourceName: 'Local',
  planVnd: '1000',
  disbursedVnd: '500',
  lastYearSamePeriodVnd: '400',
  lastYearFullYearVnd: '700',
  ...over,
});
const facts = (over: Partial<ProvinceFacts> = {}): ProvinceFacts => ({ asOf: ASOF, fiscalYear: 2026, projects: [project()], lines: [line()], units: [], feed: { basis: 'DIS_SNAPSHOT', reference: null, lastDeliveredAt: null }, ...over });

describe('percent and points', () => {
  it('writes two places by whole numbers, half up, and refuses a missing denominator', () => {
    expect(percentText(1n, 3n)).toBe('33.33');
    expect(percentText(2n, 3n)).toBe('66.67');
    expect(percentText(5n, 0n)).toBeNull();
    expect(percentText(0n, 10n)).toBe('0.00');
    expect(percentText(-1n, 3n)).toBe('-33.33');
    expect(pointsBetween('50.00', '62.50')).toBe('-12.50');
  });
});

describe('the expected curve', () => {
  it('is the month end value on the last day, interpolated inside the month and zero before the year', () => {
    expect(expectedPctOn(POLICY, '2026-06-30')).toBe('50.00');
    expect(expectedPctOn(POLICY, '2026-12-31')).toBe('100.00');
    expect(expectedPctOn(POLICY, '2026-01-31')).toBe('4.00');
    // 15 of 30 days of April, between 15 (March) and 25 (April): 20.
    expect(expectedPctOn(POLICY, '2026-04-15')).toBe('20.00');
  });
  it('refuses a day that does not exist', () => {
    expect(() => expectedPctOn(POLICY, '2026-02-30')).toThrow();
  });
});

describe('the policy', () => {
  it('round-trips through its rule params and refuses what it cannot understand', () => {
    expect(parseCommitteePolicy(committeePolicyParams(POLICY))).toEqual(POLICY);
    const params = committeePolicyParams(POLICY) as Record<string, unknown>;
    expect(() => parseCommitteePolicy({ ...params, extra: 1 })).toThrow();
    expect(() => parseCommitteePolicy({ ...params, rag_gap_amber: -1 })).toThrow();
    expect(() => parseCommitteePolicy({ ...params, curve: [] })).toThrow();
    const curve = (params.curve as Array<Record<string, number>>).map((point) => ({ ...point }));
    (curve[5] as Record<string, number>).cumulative_pct = 3;
    expect(() => parseCommitteePolicy({ ...params, curve })).toThrow();
    expect(() => parseCommitteePolicy({ ...params, weights: { delayed: 0, stalled: 0, over_budget: 0, far_below: 0, not_reporting: 0 } })).toThrow();
  });
  it('is a registered governance rule flagged unverified, with a source and a day', () => {
    registerAllGovernanceRules();
    const built = builtInDefault('COMMITTEE_POLICY', 'DEFAULT');
    expect(built?.unverified).toBe(true);
    expect(built?.source.length).toBeGreaterThan(10);
    expect(built?.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(() => validateRuleParams('COMMITTEE_POLICY', committeePolicyParams(POLICY))).not.toThrow();
    expect(defaultCommitteePolicy().unverified).toBe(true);
  });
  it('gives every figure of the workspace a definition with formula, source and an unverified flag, and the four alert types an owner, an action and a consequence', () => {
    registerAllGovernanceRules();
    for (const [code, one] of Object.entries(COMMITTEE_KPI_DEFAULTS)) {
      expect(one.unverified).toBe(true);
      const built = builtInDefault('KPI_DEFINITION', code);
      expect(built?.params.formula).toBeTruthy();
      expect(built?.params.source).toBeTruthy();
      expect(built?.params.unit).toBeTruthy();
    }
    for (const code of ['COMMITTEE_PROVINCE_BEHIND', 'COMMITTEE_SECTOR_BEHIND', 'COMMITTEE_UNIT_NOT_REPORTING', 'COMMITTEE_DIRECTIVE_OVERDUE']) {
      const built = builtInDefault('ALERT_TYPE', code);
      expect(built?.params.owner).toBeTruthy();
      expect(String(built?.params.expected_action).length).toBeGreaterThan(10);
      expect(String(built?.params.consequence).length).toBeGreaterThan(10);
    }
    expect(message('committee.kpi.committee_plan_total.name')).not.toBe('');
  });
});

describe('the figures of a group of lines', () => {
  it('gives plan, disbursed, rate, last year, gap and colour; unknown is never zero', () => {
    const figures = figuresOf([line(), line({ fundSourceCode: 'NSTW', planVnd: '1000', disbursedVnd: null, lastYearSamePeriodVnd: null })], ASOF, POLICY);
    expect(figures.planVnd).toBe('2000');
    expect(figures.disbursedVnd).toBe('500');
    expect(figures.ratePct).toBe('25.00');
    expect(figures.unknownLines).toBe(1);
    // One of the two lines has no figure of last year: the figure is not given and the coverage is named.
    expect(figures.lastYearVnd).toBeNull();
    expect(figures.lastYearCoverage).toEqual({ known: 1, total: 2 });
    expect(figures.changeVsLastYearVnd).toBeNull();
    // The curve says 80 on the 30th of September; 25 is far behind.
    expect(figures.expectedPct).toBe('80.00');
    expect(figures.gapPoints).toBe('-55.00');
    expect(figures.rag).toBe('RED');
  });
  it('has no rate and no colour when nothing was disbursed at all or there is no plan', () => {
    const none = figuresOf([line({ disbursedVnd: null })], ASOF, POLICY);
    expect(none.disbursedVnd).toBeNull();
    expect(none.ratePct).toBeNull();
    expect(none.rag).toBe('NO_DATA');
    const noPlan = figuresOf([line({ planVnd: '0', disbursedVnd: '0' })], ASOF, POLICY);
    expect(noPlan.ratePct).toBeNull();
    expect(noPlan.outlook.reason).toBe('NO_PLAN');
  });
  it('compares with the same period of last year when every line has it', () => {
    const figures = figuresOf([line(), line({ fundSourceCode: 'NSTW', disbursedVnd: '300', lastYearSamePeriodVnd: '100' })], ASOF, POLICY);
    expect(figures.lastYearVnd).toBe('500');
    expect(figures.changeVsLastYearVnd).toBe('300');
  });
});

describe('the band of the year end', () => {
  const input = { asOf: '2026-07-01', curve: POLICY, planVnd: 1000n, disbursedVnd: 300n, lastYearSamePeriodVnd: 250n as bigint | null, lastYearFullYearVnd: 600n as bigint | null };
  it('is the lowest to the highest of the usable methods, each held at the plan', () => {
    const band = outlookBandOf(input);
    expect(band.methods.map((one) => one.method)).toEqual(['RUN_RATE', 'CURVE', 'LAST_YEAR']);
    const values = band.methods.map((one) => BigInt(one.vnd));
    expect(BigInt(band.lowVnd as string)).toBe(values.reduce((a, b) => (b < a ? b : a)));
    expect(BigInt(band.highVnd as string)).toBe(values.reduce((a, b) => (b > a ? b : a)));
    expect(band.thin).toBe(false);
    expect(Number(band.highVnd)).toBeLessThanOrEqual(1000);
  });
  it('holds a method that passes the plan at the plan and says so', () => {
    const band = outlookBandOf({ ...input, disbursedVnd: 900n });
    expect(band.methods.some((one) => one.capped)).toBe(true);
    expect(band.highVnd).toBe('1000');
    expect(band.highPct).toBe('100.00');
  });
  it('is thin with one method and has a reason without data', () => {
    const thin = outlookBandOf({ ...input, lastYearSamePeriodVnd: null, lastYearFullYearVnd: null, asOf: '2026-01-01' });
    expect(thin.methods.length).toBe(2);
    expect(outlookBandOf({ ...input, disbursedVnd: null }).reason).toBe('NO_DATA');
  });
});

describe('the dimensions', () => {
  it('rolls the same lines up by sector, district, investor and fund source, and each rolls up to the province', () => {
    const seed = seedProvinceFacts(ASOF, { });
    expect(factsDefects(seed)).toEqual([]);
    const province = provinceRowOf(seed, POLICY);
    for (const dimension of ['SECTOR', 'DISTRICT', 'INVESTOR', 'FUND_SOURCE'] as const) {
      const rows = aggregateBy(seed, dimension, POLICY);
      expect(rows.reduce((sum, row) => sum + BigInt(row.planVnd), 0n).toString()).toBe(province.planVnd);
      expect(rows.reduce((sum, row) => sum + BigInt(row.disbursedVnd ?? '0'), 0n).toString()).toBe(province.disbursedVnd);
      expect(rows.map((row) => BigInt(row.planVnd))).toEqual([...rows.map((row) => BigInt(row.planVnd))].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0)));
    }
  });
  it('is the same facts to the same figures every time', () => {
    expect(seedProvinceFacts(ASOF)).toEqual(seedProvinceFacts(ASOF));
    expect(seedProvinceFacts(ASOF, { seed: 7 })).not.toEqual(seedProvinceFacts(ASOF));
  });
});

describe('units that do not report', () => {
  const units = [
    { unitId: 'u1', unitName: 'A', expected: 4, received: 4, lastReportedOn: '2026-09-29', },
    { unitId: 'u2', unitName: 'B', expected: 4, received: 4, lastReportedOn: '2026-08-01', },
    { unitId: 'u3', unitName: 'C', expected: 4, received: 4, lastReportedOn: null, },
    { unitId: 'u4', unitName: 'D', expected: 10, received: 3, lastReportedOn: '2026-09-29', },
    { unitId: 'u5', unitName: 'E', expected: 0, received: 0, lastReportedOn: null, },
  ];
  it('names why: never, stale, or too few', () => {
    const rows = unitReportingOf(units, ASOF, POLICY);
    const by = new Map(rows.map((row) => [row.unitId, row]));
    expect(by.get('u1')?.notReporting).toBe(false);
    expect(by.get('u2')?.reason).toBe('STALE');
    expect(by.get('u3')?.reason).toBe('NEVER_REPORTED');
    expect(by.get('u4')?.reason).toBe('LOW_RATE');
    // A unit that owes nothing is not "not reporting".
    expect(by.get('u5')?.notReporting).toBe(false);
    expect(rows[0]?.notReporting).toBe(true);
  });
});

describe('the projects that need the head', () => {
  const reporting = new Map<string, ReturnType<typeof unitReportingOf>[number]>();
  it('gives each reason from its own fact and nothing from an unknown fact', () => {
    const signals = attentionSignalsOf(project({ delayDays: 60, stalledDays: 10, eacVnd: '110000000000' }), [line({ planVnd: '1000', disbursedVnd: '100' })], reporting, ASOF, POLICY);
    expect(signals.map((signal) => signal.reason).sort()).toEqual(['DELAYED', 'DISBURSEMENT_FAR_BELOW_PLAN', 'OVER_BUDGET_RISK']);
    expect(signals.find((signal) => signal.reason === 'DELAYED')?.severity).toBe(1);
    expect(signals.find((signal) => signal.reason === 'OVER_BUDGET_RISK')?.value).toBe('10.00');
    expect(attentionSignalsOf(project(), [line({ disbursedVnd: null })], reporting, ASOF, POLICY)).toEqual([]);
    // Exactly at the threshold is half severity.
    expect(attentionSignalsOf(project({ delayDays: 30 }), [line({ disbursedVnd: '1000' })], reporting, ASOF, POLICY)[0]?.severity).toBe(0.5);
  });
  it('ranks by impact: more reasons, more severe and more money first, ties by the money then the code', () => {
    const worse = project({ projectId: '00000000-0000-4000-8000-000000000002', code: 'P-2', delayDays: 120, stalledDays: 100 });
    const mild = project({ projectId: '00000000-0000-4000-8000-000000000003', code: 'P-3', delayDays: 31 });
    const fine = project({ projectId: '00000000-0000-4000-8000-000000000004', code: 'P-4' });
    const lines = [
      line({ projectId: worse.projectId, planVnd: '200000000000', disbursedVnd: '190000000000' }),
      line({ projectId: mild.projectId, planVnd: '1000', disbursedVnd: '900' }),
      line({ projectId: fine.projectId, planVnd: '1000', disbursedVnd: '900' }),
    ];
    const ranked = rankAttention(facts({ projects: [fine, mild, worse], lines }), POLICY);
    expect(ranked.total).toBe(2);
    expect(ranked.items.map((item) => item.code)).toEqual(['P-2', 'P-3']);
    expect(ranked.items.map((item) => item.rank)).toEqual([1, 2]);
    expect(Number(ranked.items[0]?.score)).toBeGreaterThan(Number(ranked.items[1]?.score));
    expect(Number(ranked.items[0]?.score)).toBeLessThanOrEqual(100);
    expect(ranked.items[0]?.signals.map((signal) => signal.reason)).toEqual(['DELAYED', 'STALLED_PROCEDURE']);
  });
  it('makes a project of a unit that does not report a reason of its own, and a unit that never reported is full severity', () => {
    const p = project({ delayDays: null });
    const out = rankAttention(facts({ projects: [p], lines: [line({ disbursedVnd: '900' })], units: [{ unitId: p.investorUnitId, unitName: 'U', expected: 3, received: 0, lastReportedOn: null, }] }), POLICY);
    expect(out.items[0]?.signals[0]).toMatchObject({ reason: 'UNIT_NOT_REPORTING', value: null, severity: 1 });
  });
  it('keeps the list to the policy size unless all are asked for', () => {
    const many = seedProvinceFacts(ASOF, { projects: 80 });
    const some = rankAttention(many, { ...POLICY, attentionTopN: 3 });
    expect(some.items.length).toBe(3);
    expect(some.total).toBeGreaterThan(3);
    expect(rankAttention(many, { ...POLICY, attentionTopN: 3 }, { all: true }).items.length).toBe(some.total);
  });
});

describe('the alerts', () => {
  it('raises the province when it is behind the curve by more than the gap, and says how far', () => {
    const behind = facts({ lines: [line({ planVnd: '1000', disbursedVnd: '300' })] });
    const alerts = evaluateCommitteeAlerts(behind, POLICY, []);
    expect(alerts.map((alert) => alert.alertType)).toContain('COMMITTEE_PROVINCE_BEHIND');
    expect(alerts.find((alert) => alert.alertType === 'COMMITTEE_PROVINCE_BEHIND')?.severity).toBe('URGENT');
    expect(alerts.find((alert) => alert.alertType === 'COMMITTEE_PROVINCE_BEHIND')?.dedupeKey).toBe('COMMITTEE_PROVINCE_BEHIND:PROVINCE:2026');
    const fine = facts({ lines: [line({ planVnd: '1000', disbursedVnd: '790' })] });
    expect(evaluateCommitteeAlerts(fine, POLICY, [])).toEqual([]);
  });
  it('raises a sector far behind the province but not a tiny one', () => {
    const a = project({ projectId: '00000000-0000-4000-8000-0000000000a1', code: 'A', sectorCode: 'S1', sectorName: 'S1' });
    const b = project({ projectId: '00000000-0000-4000-8000-0000000000a2', code: 'B', sectorCode: 'S2', sectorName: 'S2', });
    const tiny = project({ projectId: '00000000-0000-4000-8000-0000000000a3', code: 'C', sectorCode: 'S3', sectorName: 'S3' });
    const lines = [
      line({ projectId: a.projectId, planVnd: '1000000', disbursedVnd: '900000' }),
      line({ projectId: b.projectId, planVnd: '1000000', disbursedVnd: '400000', }),
      line({ projectId: tiny.projectId, planVnd: '10', disbursedVnd: '0' }),
    ];
    const alerts = evaluateCommitteeAlerts(facts({ projects: [a, b, tiny], lines }), POLICY, []).filter((alert) => alert.alertType === 'COMMITTEE_SECTOR_BEHIND');
    expect(alerts.map((alert) => alert.subjectKey)).toEqual(['S2']);
  });
  it('raises a unit that does not report and a unit with overdue directives, urgent when it never reported or a directive was escalated', () => {
    const alerts = evaluateCommitteeAlerts(
      facts({ units: [{ unitId: 'u3', unitName: 'C', expected: 4, received: 0, lastReportedOn: null, }] }),
      POLICY,
      [
        { unitId: 'u7', unitName: 'G', overdue: 2, escalated: 1 },
        { unitId: 'u8', unitName: 'H', overdue: 0, escalated: 0 },
      ],
    );
    expect(alerts.find((alert) => alert.alertType === 'COMMITTEE_UNIT_NOT_REPORTING')?.severity).toBe('URGENT');
    expect(alerts.find((alert) => alert.alertType === 'COMMITTEE_DIRECTIVE_OVERDUE')).toMatchObject({ severity: 'URGENT', subjectKey: 'u7', value: '2' });
    expect(alerts.filter((alert) => alert.alertType === 'COMMITTEE_DIRECTIVE_OVERDUE').length).toBe(1);
  });
});

describe('the workspace', () => {
  it('is built from the facts of the day and of the week before, with the changes of the week and the feed mode', () => {
    const today = seedProvinceFacts(ASOF, { });
    const before = seedProvinceFacts('2026-09-23', { });
    const workspace = buildWorkspace(today, before, POLICY, [{ unitId: SEED_UNIT, unitName: 'X', overdue: 1, escalated: 0 }]);
    expect(workspace.feed).toMatchObject({ basis: 'CORE_LIVE', empty: false });
    expect(feedStatusOf(today).projects).toBe(today.projects.length);
    expect(workspace.bySector.length).toBeGreaterThan(1);
    expect(workspace.attention.length).toBeLessThanOrEqual(POLICY.attentionTopN);
    expect(workspace.attentionTotal).toBeGreaterThan(0);
    expect(workspace.province.attentionProjects).toBe(workspace.attentionTotal);
    expect(workspace.changes.previousAsOf).toBe('2026-09-23');
    expect(workspace.alerts.some((alert) => alert.alertType === 'COMMITTEE_DIRECTIVE_OVERDUE')).toBe(true);
    expect(buildWorkspace(today, null, POLICY).changes.reason).toBe('NO_PREVIOUS_WEEK');
  });
  it('says empty for a province with no records', () => {
    expect(feedStatusOf(facts({ projects: [], lines: [], units: [] })).empty).toBe(true);
    expect(feedStatusOf(facts()).empty).toBe(false);
    const empty = buildWorkspace(facts({ projects: [], lines: [] }), null, POLICY);
    expect(empty.province.ratePct).toBeNull();
    expect(empty.province.rag).toBe('NO_DATA');
    expect(empty.attention).toEqual([]);
  });
  it('refuses a feed that breaks its contract', () => {
    expect(factsDefects(facts({ lines: [line({ projectId: 'nope' })] })).length).toBeGreaterThan(0);
    expect(factsDefects(facts({ lines: [line(), line()] })).length).toBeGreaterThan(0);
    expect(factsDefects(facts({ lines: [line({ planVnd: '1.5' })] })).length).toBeGreaterThan(0);
  });
});

const SEED_UNIT = '00000000-0000-4000-8100-000000000001';

describe('the meeting pack form', () => {
  it('is a valid READY layout whose datasets are the rows of the workspace, with unknown values left null', () => {
    validateLayout(COMMITTEE_PACK_LAYOUT);
    expect(COMMITTEE_PACK_LAYOUT.status).toBe('READY');
    expect(JSON.stringify(COMMITTEE_PACK_LAYOUT).toLowerCase()).not.toMatch(/simulat|mo phong/);
    const workspace = buildWorkspace(seedProvinceFacts(ASOF), null, POLICY, [{ unitId: SEED_UNIT, unitName: 'X', overdue: 1, escalated: 0 }]);
    const datasets = packDatasetsOf(workspace, [{ unitName: 'X', open: 2, overdue: 1, escalated: 0 }], workspace.attention);
    expect(Object.keys(datasets).sort()).toEqual(['attention', 'directives', 'districts', 'funds', 'investors', 'province', 'sectors']);
    expect(datasets.sectors?.length).toBe(workspace.bySector.length);
    expect(datasets.province?.[0]?.plan).toBe(workspace.province.planVnd);
    expect(datasets.directives?.[0]).toMatchObject({ name: 'X', open: 2, overdue: 1 });
    const unknown = packDatasetsOf(buildWorkspace(facts({ lines: [line({ disbursedVnd: null })] }), null, POLICY), [], []);
    expect(unknown.province?.[0]?.disbursed).toBeNull();
    expect(unknown.province?.[0]?.rate).toBeNull();
  });
});
