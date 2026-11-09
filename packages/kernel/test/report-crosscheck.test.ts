import { builtInDefault, validateRuleParams } from '../src/governance-rules.ts';
import {
  CROSSCHECK_DEFAULT_CODE,
  CROSSCHECK_RULE_IDS,
  CROSSCHECK_RULE_TYPE,
  SNAPSHOT_ROLE,
  assertExplanationAllowed,
  compareReports,
  crosscheckDefaults,
  crosscheckDefect,
  crosscheckFamily,
  crosscheckPolicyOf,
  figureSetOf,
  gateOf,
  roleOfLayout,
} from '../src/report-crosscheck.ts';
import type { CrosscheckPolicy, CrosscheckReport, CrosscheckRole, FigureSet } from '../src/report-crosscheck.ts';
import type { FormPeriod } from '../src/report-layout.ts';

/**
 * A small world: three projects of two units, three months of a quarter. Every report and the frozen snapshot are filled from the same ledger, the way the enterprise forms are filled from the one reader, so the
 * clean family must give no finding. The metamorphic tests then change ONE thing in the world and require that the comparison notices; a comparison that cannot go red proves nothing.
 */

const POLICY: CrosscheckPolicy = crosscheckPolicyOf(crosscheckDefaults());
const YEAR = 2026;
const month = (index: number): FormPeriod => ({ kind: 'MONTH', year: YEAR, index });
const quarter: FormPeriod = { kind: 'QUARTER', year: YEAR, index: 4 };
const MONTHS = [10, 11, 12];

interface Project {
  code: string;
  unit: string | null;
  tmdt: bigint;
  planYear: bigint;
  /** Executed in each month of the quarter, then the amount since the start of the year before the quarter. */
  executed: [bigint, bigint, bigint];
  disbursed: [bigint, bigint, bigint];
  executedBefore: bigint;
  disbursedBefore: bigint;
  startBefore: bigint;
}

const WORLD: Project[] = [
  { code: 'P1', unit: 'Unit A', tmdt: 9_000_000_000n, planYear: 4_000_000_000n, executed: [300_000_000n, 200_000_000n, 500_000_000n], disbursed: [250_000_000n, 150_000_000n, 450_000_000n], executedBefore: 1_000_000_000n, disbursedBefore: 800_000_000n, startBefore: 2_000_000_000n },
  { code: 'P2', unit: 'Unit A', tmdt: 5_000_000_000n, planYear: 2_000_000_000n, executed: [100_000_000n, 100_000_000n, 100_000_000n], disbursed: [90_000_000n, 90_000_000n, 90_000_000n], executedBefore: 600_000_000n, disbursedBefore: 500_000_000n, startBefore: 900_000_000n },
  { code: 'P3', unit: 'Unit B', tmdt: 3_000_000_000n, planYear: 1_500_000_000n, executed: [50_000_000n, 60_000_000n, 70_000_000n], disbursed: [40_000_000n, 50_000_000n, 60_000_000n], executedBefore: 300_000_000n, disbursedBefore: 250_000_000n, startBefore: 400_000_000n },
];

const sum = (values: bigint[]): bigint => values.reduce((a, b) => a + b, 0n);

/** The fill data of one month (`upto` 0..2 is the month inside the quarter) or of the whole quarter (`upto` 3). */
function fillOf(world: Project[], upto: 1 | 2 | 3, flowMonths: number[]) {
  const rows = world.map((one) => {
    const executedFlow = sum(flowMonths.map((at) => one.executed[at] as bigint));
    const disbursedFlow = sum(flowMonths.map((at) => one.disbursed[at] as bigint));
    const executedToDate = one.executedBefore + sum(one.executed.slice(0, upto));
    const disbursedToDate = one.disbursedBefore + sum(one.disbursed.slice(0, upto));
    return {
      code: one.code,
      owner_unit: one.unit,
      tmdt: one.tmdt.toString(),
      plan_year: one.planYear.toString(),
      plan_force: one.planYear.toString(),
      exec_p: executedFlow.toString(),
      disb_p: disbursedFlow.toString(),
      est_p: executedFlow.toString(),
      exec_ytd: executedToDate.toString(),
      disb_ytd: disbursedToDate.toString(),
      exec_start: (one.startBefore + sum(one.executed.slice(0, upto))).toString(),
      disb_start: (one.startBefore + sum(one.disbursed.slice(0, upto))).toString(),
      outlook: (one.planYear - 100_000_000n).toString(),
      cap_equity: (one.planYear / 2n).toString(),
      cap_debt: (one.planYear / 4n).toString(),
      cap_other: (one.planYear - one.planYear / 2n - one.planYear / 4n).toString(),
    };
  });
  const total = (key: keyof (typeof rows)[number]): string => sum(rows.map((row) => BigInt(row[key] as string))).toString();
  const pct = (top: string, bottom: string): string => {
    const scaled = (BigInt(top) * 100n * 10000n * 2n + BigInt(bottom)) / (2n * BigInt(bottom));
    return `${scaled / 10000n}.${(scaled % 10000n).toString().padStart(4, '0')}`;
  };
  const figure = (code: string, value: string) => ({ code, basis: 'AS_OF_END', value, asOf: '2026-12-31' });
  const planForce = total('plan_force');
  return {
    figures: [
      figure('ENT_TOTAL_INVESTMENT', total('tmdt')),
      figure('ENT_PLAN_YEAR', total('plan_year')),
      figure('ENT_PLAN_IN_FORCE', planForce),
      figure('ENT_EXECUTED_PERIOD', total('exec_p')),
      figure('ENT_DISBURSED_PERIOD', total('disb_p')),
      figure('ENT_ESTIMATE_PERIOD', total('est_p')),
      figure('ENT_EXECUTED_YTD', total('exec_ytd')),
      figure('ENT_DISBURSED_YTD', total('disb_ytd')),
      figure('ENT_EXECUTED_SINCE_START', total('exec_start')),
      figure('ENT_DISBURSED_SINCE_START', total('disb_start')),
      figure('ENT_OUTLOOK_YEAR', total('outlook')),
      figure('ENT_CAPITAL_EQUITY', total('cap_equity')),
      figure('ENT_CAPITAL_DEBT', total('cap_debt')),
      figure('ENT_CAPITAL_OTHER', total('cap_other')),
      figure('ENT_RATE_EXECUTED_YTD', pct(total('exec_ytd'), planForce)),
      figure('ENT_RATE_DISBURSED_YTD', pct(total('disb_ytd'), planForce)),
      figure('ENT_RATE_SINCE_START', pct(total('exec_start'), total('tmdt'))),
      figure('ENT_RATE_OUTLOOK_YEAR', pct(total('outlook'), planForce)),
      figure('ENT_SHARE_EQUITY', pct(total('cap_equity'), planForce)),
      figure('ENT_SHARE_DEBT', pct(total('cap_debt'), planForce)),
      figure('ENT_SHARE_OTHER', pct(total('cap_other'), planForce)),
      figure('ENT_PROJECTS_TOTAL', String(world.length)),
    ],
    datasets: { projects: rows },
  };
}

const setOf = (world: Project[], index: number): FigureSet => figureSetOf(fillOf(world, index === 4 ? 3 : ((index - 9) as 1 | 2 | 3), index === 4 ? [0, 1, 2] : [index - 10]), POLICY);

interface Make {
  world?: Project[];
  revision?: number;
  preparedBy?: string;
  dataSource?: 'LIVE' | 'ILLUSTRATIVE';
  set?: FigureSet | null;
}

const report = (role: CrosscheckRole, index: number, make: Make = {}): CrosscheckReport => {
  const kind = index === 4 && (role === 'PVN_QUARTERLY' || role === 'COMMITTEE');
  const period: FormPeriod = kind ? quarter : month(index);
  const id = `${role}-${kind ? 'Q4' : index}`;
  return {
    ref: { kind: 'DRAFT', id, revision: null },
    role,
    layoutCode: POLICY.layoutOf[role] as string,
    period,
    dataSource: make.dataSource ?? 'LIVE',
    preparedBy: make.preparedBy ?? 'author-1',
    snapshot: { snapshotId: 'snap', revision: make.revision ?? 1, asOf: '2026-12-31' },
    set: make.set === undefined ? setOf(make.world ?? WORLD, kind ? 4 : index) : make.set,
  };
};

const snapshot = (period: FormPeriod, world: Project[] = WORLD): CrosscheckReport => ({
  ref: { kind: 'SNAPSHOT', id: `snapshot-${period.kind}-${period.index}`, revision: 1 },
  role: SNAPSHOT_ROLE,
  layoutCode: 'SNAPSHOT',
  period,
  dataSource: 'LIVE',
  preparedBy: null,
  snapshot: { snapshotId: 'snap', revision: 1, asOf: '2026-12-31' },
  set: setOf(world, period.kind === 'QUARTER' ? 4 : (period.index as number)),
});

/** The whole family, every report filled from the same world. */
function family(overrides: (reports: CrosscheckReport[]) => CrosscheckReport[] = (reports) => reports): CrosscheckReport[] {
  const monthly: CrosscheckReport[] = MONTHS.flatMap((index) => [report('PVN_MONTHLY', index), report('STEERING', index), report('HPM_MONTHLY', index), snapshot(month(index))]);
  return overrides([...monthly, report('PVN_QUARTERLY', 4), report('COMMITTEE', 4), snapshot(quarter)]);
}

const run = (reports: CrosscheckReport[], policy: CrosscheckPolicy = POLICY, period: FormPeriod = quarter) => compareReports(period, reports, policy);
const rulesOf = (result: ReturnType<typeof run>): string[] => [...new Set(result.findings.map((one) => one.ruleId))].sort();
const replace = (reports: CrosscheckReport[], id: string, change: Partial<CrosscheckReport>): CrosscheckReport[] => reports.map((one) => (one.ref.id === id ? { ...one, ...change } : one));
/** A copy of the world with one project changed. */
const tweak = (change: (project: Project) => Project, code = 'P1'): Project[] => WORLD.map((one) => (one.code === code ? change(one) : one));

describe('the rule type', () => {
  it('has a built-in default that is UNVERIFIED and passes its own schema', () => {
    const found = builtInDefault(CROSSCHECK_RULE_TYPE, CROSSCHECK_DEFAULT_CODE);
    expect(found?.unverified).toBe(true);
    expect(found?.formula.length).toBeGreaterThan(8);
    expect(found?.source.length).toBeGreaterThan(3);
    expect(validateRuleParams(CROSSCHECK_RULE_TYPE, crosscheckDefaults())).toBeTruthy();
    expect(CROSSCHECK_RULE_IDS).toHaveLength(6);
  });

  it('refuses what the schema or the cross rules cannot accept', () => {
    const base = crosscheckDefaults();
    const rules = base['rules'] as Array<Record<string, unknown>>;
    expect(() => validateRuleParams(CROSSCHECK_RULE_TYPE, { ...base, surprise: 1 })).toThrow();
    expect(() => validateRuleParams(CROSSCHECK_RULE_TYPE, { ...base, rules: [...rules, rules[0]] })).toThrow();
    const roles = base['roles'] as Array<Record<string, unknown>>;
    expect(() => validateRuleParams(CROSSCHECK_RULE_TYPE, { ...base, roles: [...roles, roles[0]] })).toThrow();
    const sameRole = rules.map((one) => (one['id'] === 'XR-03' ? { ...one, pairs: [{ left: 'HPM_MONTHLY', right: 'HPM_MONTHLY' }] } : one));
    expect(() => validateRuleParams(CROSSCHECK_RULE_TYPE, { ...base, rules: sameRole })).toThrow();
    const crossKind = rules.map((one) => (one['id'] === 'XR-03' ? { ...one, pairs: [{ left: 'HPM_MONTHLY', right: 'PVN_QUARTERLY' }] } : one));
    expect(crosscheckDefect({ ...base, rules: crossKind })).toBe('rules[2].pairs[0]');
    const wrongWay = rules.map((one) => (one['id'] === 'XR-01' ? { ...one, pairs: [{ left: 'PVN_MONTHLY', right: 'PVN_QUARTERLY' }] } : one));
    expect(crosscheckDefect({ ...base, rules: wrongWay })).toBe('rules[0].pairs[0]');
    expect(() => validateRuleParams(CROSSCHECK_RULE_TYPE, { ...base, rules: rules.map((one) => ({ ...one, scale: 'KILO' })) })).toThrow();
    expect(() => validateRuleParams(CROSSCHECK_RULE_TYPE, { ...base, rules: rules.map((one) => ({ ...one, severity: 'FATAL' })) })).toThrow();
  });

  it('maps layout codes to roles and a period to its family', () => {
    expect(roleOfLayout(POLICY, 'HPM-MONTHLY')).toBe('HPM_MONTHLY');
    expect(roleOfLayout(POLICY, 'PLANT-PHU-MY')).toBeUndefined();
    expect(crosscheckFamily(month(11)).map((one) => `${one.kind}${one.index}`)).toEqual(['QUARTER4', 'MONTH10', 'MONTH11', 'MONTH12']);
    expect(crosscheckFamily(quarter)).toHaveLength(4);
    expect(crosscheckFamily({ kind: 'YEAR', year: YEAR })).toEqual([]);
  });
});

describe('figureSetOf', () => {
  it('keeps decimals as text, the unit of a row, a missing figure as null and a key for a row with none', () => {
    const set = figureSetOf(
      {
        figures: [
          { code: 'ENT_PLAN_YEAR', basis: 'FULL_YEAR', value: 12_000, asOf: '2026-12-31' },
          { code: 'ENT_PROJECTS_TOTAL', basis: 'AS_OF_END', value: null },
          { code: 'ENT_RATE_SINCE_START', basis: 'AS_OF_END', value: 'n/a' },
        ],
        datasets: { projects: [{ code: 'A', owner_unit: 'U', tmdt: '5' }, { code: '', owner_unit: '  ', tmdt: null }] },
      },
      POLICY,
    );
    expect(set.figures.map((one) => one.value)).toEqual(['12000', null, null]);
    expect(set.rows[0]).toMatchObject({ key: 'A', unit: 'U', values: { ENT_TOTAL_INVESTMENT: '5' } });
    expect(set.rows[1]).toMatchObject({ key: 'projects#2', unit: null, values: { ENT_TOTAL_INVESTMENT: null } });
  });
});

describe('a clean family', () => {
  it('gives no finding, runs all six rules, and compares many numbers', () => {
    const result = run(family());
    expect(result.findings).toEqual([]);
    expect(result.coverage.rulesRun).toBe(6);
    expect(result.coverage.comparisons).toBeGreaterThan(100);
    expect(result.coverage.reports).toBe(11);
    expect(result.coverage.usable).toBe(11);
  });

  it('is the same result whatever the order of the reports, and from any period of the family', () => {
    const a = run(family());
    const b = run([...family()].reverse(), POLICY, month(11));
    expect(b.findings).toEqual(a.findings);
    expect(b.coverage).toEqual(a.coverage);
  });

  it('ignores reports of another family', () => {
    const other = { ...report('PVN_MONTHLY', 10), ref: { kind: 'DRAFT' as const, id: 'other', revision: null }, period: { kind: 'MONTH' as const, year: YEAR, index: 4 } };
    expect(run([...family(), other]).coverage.reports).toBe(11);
  });
});

describe('metamorphic: one change in the world must be noticed', () => {
  const tamper = (executed: [bigint, bigint, bigint]) => (one: Project): Project => ({ ...one, executed });

  it('a month of PVN that is one dong off breaks the quarter, the snapshot and the sibling reports', () => {
    const wrong = tweak(tamper([300_000_001n, 200_000_000n, 500_000_000n]));
    const result = run(family((reports) => replace(reports, 'PVN_MONTHLY-10', { set: setOf(wrong, 10) })));
    expect(rulesOf(result)).toEqual(expect.arrayContaining(['XR-01', 'XR-02', 'XR-03']));
    const quarterly = result.findings.find((one) => one.ruleId === 'XR-01' && one.code === 'ENT_EXECUTED_PERIOD');
    expect(quarterly?.difference).toBe('-1');
    expect(quarterly?.terms.map((one) => one.role)).toEqual(['PVN_QUARTERLY', 'PVN_MONTHLY', 'PVN_MONTHLY', 'PVN_MONTHLY']);
  });

  it('the HPM report that differs from PVN is caught by the pair rule, and by the snapshot rule', () => {
    const wrong = tweak((one) => ({ ...one, tmdt: one.tmdt + 5n }));
    const result = run(family((reports) => replace(reports, 'HPM_MONTHLY-11', { set: setOf(wrong, 11) })));
    const same = result.findings.filter((one) => one.ruleId === 'XR-03' && one.code === 'ENT_TOTAL_INVESTMENT');
    expect(same).toHaveLength(1);
    expect(same[0]?.terms[0]?.role).toBe('HPM_MONTHLY');
    expect(same[0]?.expected).toBe('17000000000');
    expect(same[0]?.actual).toBe('17000000005');
    expect(rulesOf(result)).toContain('XR-02');
  });

  it('a board report made from a snapshot that was corrected afterwards is stale against the snapshot', () => {
    const corrected = tweak((one) => ({ ...one, executed: [one.executed[0], one.executed[1], one.executed[2] + 1_000_000n] }));
    const reports = family((all) => all.map((one) => (one.role === SNAPSHOT_ROLE && one.period.kind === 'QUARTER' ? { ...one, set: setOf(corrected, 4) } : one)));
    const result = run(reports);
    const stale = result.findings.filter((one) => one.ruleId === 'XR-02' && one.terms[0]?.role === 'COMMITTEE');
    expect(stale.length).toBeGreaterThan(0);
    expect(stale[0]?.path[0]).toEqual({ step: 'REGENERATE_REPORT', layoutCode: 'COMMITTEE-PERIODIC', ref: 'COMMITTEE-Q4' });
    expect(stale[0]?.path[stale[0].path.length - 1]).toEqual({ step: 'EXPLAIN' });
  });

  it('a project row without a unit makes the unit sum fall short of the company figure', () => {
    const withoutUnit = tweak((one) => ({ ...one, unit: null }), 'P3');
    const result = run(family((reports) => replace(reports, 'PVN_QUARTERLY-Q4', { set: setOf(withoutUnit, 4) })));
    const unit = result.findings.filter((one) => one.ruleId === 'XR-05');
    expect(unit.length).toBeGreaterThan(0);
    expect(unit[0]?.units?.map((one) => one.unit)).toEqual(['Unit A']);
    expect(unit[0]?.path[0]).toEqual({ step: 'ASSIGN_UNIT', layoutCode: 'PVN-QUARTERLY-F2', rows: ['P3'] });
  });

  it('a company figure that is not the sum of the rows is caught even when every unit has a name', () => {
    const set = setOf(WORLD, 4);
    const figures = set.figures.map((one) => (one.code === 'ENT_PLAN_YEAR' ? { ...one, value: String(BigInt(one.value as string) + 1n) } : one));
    const result = run(family((reports) => replace(reports, 'COMMITTEE-Q4', { set: { ...set, figures } })));
    expect(result.findings.some((one) => one.ruleId === 'XR-05' && one.code === 'ENT_PLAN_YEAR' && one.difference === '-1')).toBe(true);
  });

  it('cumulative above the total investment is caught in a row and in the strip', () => {
    const over = tweak((one) => ({ ...one, startBefore: one.tmdt }));
    const result = run(family((reports) => replace(reports, 'PVN_QUARTERLY-Q4', { set: setOf(over, 4) })));
    const cumulative = result.findings.filter((one) => one.ruleId === 'XR-04');
    expect(cumulative.some((one) => one.terms[0]?.rowKey === 'P1')).toBe(true);
    expect(cumulative.every((one) => BigInt(one.difference) > 0n)).toBe(true);
  });

  it('a rate that is not numerator over denominator is a WARNING by default', () => {
    const set = setOf(WORLD, 4);
    const figures = set.figures.map((one) => (one.code === 'ENT_RATE_EXECUTED_YTD' ? { ...one, value: '99.0000' } : one));
    const result = run(family((reports) => replace(reports, 'PVN_QUARTERLY-Q4', { set: { ...set, figures } })));
    const rate = result.findings.find((one) => one.ruleId === 'XR-06');
    expect(rate?.severity).toBe('WARNING');
    expect(rate?.unit).toBe('PCT');
    expect(rate?.formula).toContain('ENT_EXECUTED_YTD');
  });

  it('every injected error of the list is found by some rule, and a comparison with every rule off finds none (the check can go red)', () => {
    const injections: Array<[string, (reports: CrosscheckReport[]) => CrosscheckReport[]]> = [
      ['one dong in a month', (reports) => replace(reports, 'PVN_MONTHLY-12', { set: setOf(tweak((one) => ({ ...one, disbursed: [one.disbursed[0], one.disbursed[1], one.disbursed[2] + 1n] })), 12) })],
      ['a different total investment in HPM', (reports) => replace(reports, 'HPM_MONTHLY-10', { set: setOf(tweak((one) => ({ ...one, tmdt: one.tmdt - 1n })), 10) })],
      ['a stale steering month', (reports) => replace(reports, 'STEERING-11', { set: setOf(tweak((one) => ({ ...one, executedBefore: one.executedBefore + 7n })), 11) })],
      ['a row with no unit', (reports) => replace(reports, 'PVN_MONTHLY-10', { set: setOf(tweak((one) => ({ ...one, unit: null }), 'P2'), 10) })],
    ];
    const silent: CrosscheckPolicy = { ...POLICY, rules: POLICY.rules.map((one) => ({ ...one, enabled: false })) };
    for (const [name, inject] of injections) {
      expect([name, run(family(inject)).findings.length > 0]).toEqual([name, true]);
      expect([name, run(family(inject), silent).findings.length]).toEqual([name, 0]);
    }
  });
});

describe('what is not compared is said, never passed', () => {
  it('a missing month skips the quarter rule with the reason and makes no finding', () => {
    const result = run(family((reports) => reports.filter((one) => one.ref.id !== 'PVN_MONTHLY-11')));
    expect(result.findings).toEqual([]);
    expect(result.skipped.some((one) => one.ruleId === 'XR-01' && one.reason === 'MISSING_REPORT' && one.periodCode === '2026-M11')).toBe(true);
  });

  it('a draft with no recorded figures and a report on illustrative data are skipped, not compared', () => {
    const result = run(family((reports) => replace(replace(reports, 'HPM_MONTHLY-10', { set: null }), 'STEERING-10', { dataSource: 'ILLUSTRATIVE' })));
    expect(result.skipped.some((one) => one.reason === 'NO_FIGURES' && one.layoutCode === 'HPM-MONTHLY')).toBe(true);
    expect(result.skipped.some((one) => one.reason === 'ILLUSTRATIVE' && one.layoutCode === 'INVEST-STEERING')).toBe(true);
    expect(result.coverage.usable).toBe(result.coverage.reports - 2);
    expect(result.findings).toEqual([]);
  });

  it('illustrative data is compared when the rule says so', () => {
    const policy: CrosscheckPolicy = { ...POLICY, includeIllustrative: true };
    const result = run(family((reports) => replace(reports, 'STEERING-10', { dataSource: 'ILLUSTRATIVE' })), policy);
    expect(result.skipped.some((one) => one.reason === 'ILLUSTRATIVE')).toBe(false);
  });

  it('no snapshot for the period skips the snapshot rule', () => {
    const result = run(family((reports) => reports.filter((one) => one.role !== SNAPSHOT_ROLE)));
    expect(result.skipped.some((one) => one.ruleId === 'XR-02' && one.reason === 'NO_SNAPSHOT')).toBe(true);
    expect(rulesOf(result)).not.toContain('XR-02');
  });

  it('a figure nobody has is skipped (null is not zero)', () => {
    const set = setOf(WORLD, 4);
    const figures = set.figures.map((one) => (one.code === 'ENT_EXECUTED_PERIOD' ? { ...one, value: null } : one));
    const result = run(family((reports) => replace(reports, 'PVN_QUARTERLY-Q4', { set: { ...set, figures } })));
    expect(result.skipped.some((one) => one.reason === 'NO_VALUE' && one.code === 'ENT_EXECUTED_PERIOD')).toBe(true);
    expect(result.findings.some((one) => one.code === 'ENT_EXECUTED_PERIOD' && one.ruleId === 'XR-01')).toBe(false);
  });

  it('two reports for the same role and period use the first and say so', () => {
    const second = { ...report('HPM_MONTHLY', 10), ref: { kind: 'DRAFT' as const, id: 'HPM-again', revision: null } };
    const result = run([...family(), second]);
    expect(result.skipped.some((one) => one.reason === 'DUPLICATE')).toBe(true);
  });
});

describe('tolerance is the rounding of the money scale, not a guess', () => {
  const quarterOff = (by: bigint) => family((reports) => replace(reports, 'PVN_QUARTERLY-Q4', { set: setOf(tweak((one) => ({ ...one, executed: [one.executed[0] + by, one.executed[1], one.executed[2]] })), 4) }));
  const policyOf = (scale: string, absolute = 0): CrosscheckPolicy => ({ ...POLICY, rules: POLICY.rules.map((one) => ({ ...one, scale: scale as CrosscheckPolicy['rules'][number]['scale'], absoluteVnd: absolute })) });
  const monthsToQuarter = (reports: CrosscheckReport[], policy: CrosscheckPolicy) => run(reports, policy).findings.filter((one) => one.ruleId === 'XR-01' && one.code === 'ENT_EXECUTED_PERIOD');

  it('whole dong allow no difference at all', () => {
    expect(monthsToQuarter(quarterOff(1n), policyOf('VND'))).toHaveLength(1);
    expect(monthsToQuarter(quarterOff(0n), policyOf('VND'))).toHaveLength(0);
  });

  it('a quarter of reports in million dong may differ by half a million for each of its four numbers', () => {
    expect(monthsToQuarter(quarterOff(1_999_999n), policyOf('MILLION_VND'))).toHaveLength(0);
    const edge = monthsToQuarter(quarterOff(2_000_001n), policyOf('MILLION_VND'));
    expect(edge).toHaveLength(1);
    expect(edge[0]?.tolerance).toBe('2000000');
  });

  it('an absolute allowance adds to the rounding', () => {
    expect(monthsToQuarter(quarterOff(10n), policyOf('VND', 10))).toHaveLength(0);
    expect(monthsToQuarter(quarterOff(11n), policyOf('VND', 10))).toHaveLength(1);
  });

  it('rates are compared in points', () => {
    const set = setOf(WORLD, 4);
    const shift = (delta: string) => ({ ...set, figures: set.figures.map((one) => (one.code === 'ENT_RATE_EXECUTED_YTD' ? { ...one, value: delta } : one)) });
    const expected = set.figures.find((one) => one.code === 'ENT_RATE_EXECUTED_YTD')?.value as string;
    const [whole = '0', fraction = '0000'] = expected.split('.');
    const near = `${whole}.${String(Number(fraction) + 100).padStart(4, '0')}`;
    const far = `${whole}.${String(Number(fraction) + 101).padStart(4, '0')}`;
    expect(run(family((reports) => replace(reports, 'COMMITTEE-Q4', { set: shift(near) }))).findings.filter((one) => one.code === 'ENT_RATE_EXECUTED_YTD' && one.ruleId === 'XR-06')).toHaveLength(0);
    expect(run(family((reports) => replace(reports, 'COMMITTEE-Q4', { set: shift(far) }))).findings.filter((one) => one.code === 'ENT_RATE_EXECUTED_YTD' && one.ruleId === 'XR-06')).toHaveLength(1);
  });
});

describe('every number has its formula, source and time', () => {
  const wrong = tweak((one) => ({ ...one, executed: [one.executed[0] + 3n, one.executed[1], one.executed[2]] }));
  const result = run(family((reports) => replace(reports, 'PVN_MONTHLY-10', { set: setOf(wrong, 10) })));

  it('names the rule, the formula and for each term the report, the source and the day', () => {
    const finding = result.findings.find((one) => one.ruleId === 'XR-02' && one.code === 'ENT_EXECUTED_PERIOD');
    expect(finding?.ruleName.length).toBeGreaterThan(3);
    expect(finding?.formula).toContain('ENT_EXECUTED_PERIOD');
    expect(finding?.terms).toHaveLength(2);
    for (const term of finding?.terms ?? []) {
      expect(term.source.length).toBeGreaterThan(5);
      expect(term.asOf).toBe('2026-12-31');
      expect(term.layoutCode.length).toBeGreaterThan(0);
    }
    expect(finding?.terms[1]?.source).toContain('snap');
    expect(finding?.involves).toEqual(['PVN_MONTHLY-10']);
    expect(finding?.authors).toEqual(['author-1']);
  });

  it('has a fingerprint that holds for these values only', () => {
    const again = run(family((reports) => replace(reports, 'PVN_MONTHLY-10', { set: setOf(wrong, 10) })));
    expect(again.findings.map((one) => one.fingerprint)).toEqual(result.findings.map((one) => one.fingerprint));
    expect(again.sha256).toBe(result.sha256);
    const other = tweak((one) => ({ ...one, executed: [one.executed[0] + 4n, one.executed[1], one.executed[2]] }));
    const changed = run(family((reports) => replace(reports, 'PVN_MONTHLY-10', { set: setOf(other, 10) })));
    expect(changed.findings.map((one) => one.fingerprint)).not.toEqual(result.findings.map((one) => one.fingerprint));
    expect(changed.sha256).not.toBe(result.sha256);
  });
});

describe('the gate', () => {
  const wrong = tweak((one) => ({ ...one, executed: [one.executed[0] + 3n, one.executed[1], one.executed[2]] }));
  const result = run(family((reports) => replace(reports, 'PVN_MONTHLY-10', { set: setOf(wrong, 10) })));

  it('blocks the release of a report a blocking finding involves, and only that one', () => {
    expect(gateOf(result, 'PVN_MONTHLY-10', new Set()).passed).toBe(false);
    expect(gateOf(result, 'PVN_MONTHLY-10', new Set()).blocking.length).toBeGreaterThan(0);
    expect(gateOf(result, 'STEERING-12', new Set()).passed).toBe(true);
  });

  it('passes a finding that has an explanation of its fingerprint, and keeps it listed as explained', () => {
    const explained = new Set(result.findings.map((one) => one.fingerprint));
    const gate = gateOf(result, 'PVN_MONTHLY-10', explained);
    expect(gate.passed).toBe(true);
    expect(gate.explained.length).toBeGreaterThan(0);
  });

  it('does not let an explanation of other figures through', () => {
    const gate = gateOf(result, 'PVN_MONTHLY-10', new Set(['0'.repeat(64)]));
    expect(gate.passed).toBe(false);
  });

  it('never blocks on a WARNING, which is only listed', () => {
    const set = setOf(WORLD, 4);
    const figures = set.figures.map((one) => (one.code === 'ENT_RATE_EXECUTED_YTD' ? { ...one, value: '99.0000' } : one));
    const onlyRates: CrosscheckPolicy = { ...POLICY, rules: POLICY.rules.filter((one) => one.id === 'XR-06') };
    const warned = run(family((reports) => replace(reports, 'COMMITTEE-Q4', { set: { ...set, figures } })), onlyRates);
    const gate = gateOf(warned, 'COMMITTEE-Q4', new Set());
    expect(gate.passed).toBe(true);
    expect(gate.warnings.length).toBeGreaterThan(0);
  });

  it('can turn a rule from blocking into a warning in the params', () => {
    const lenient: CrosscheckPolicy = { ...POLICY, rules: POLICY.rules.map((one) => ({ ...one, severity: 'WARNING' as const })) };
    const soft = run(
      family((reports) => replace(reports, 'PVN_MONTHLY-10', { set: setOf(wrong, 10) })),
      lenient,
    );
    expect(soft.findings.length).toBeGreaterThan(0);
    expect(gateOf(soft, 'PVN_MONTHLY-10', new Set()).passed).toBe(true);
  });
});

describe('the explanation', () => {
  const finding = { authors: ['author-1', 'author-2'] };
  const reason = 'The month was corrected by the Treasury after the freeze.';

  it('refuses the preparer of any report the finding is about (maker is not checker)', () => {
    expect(() => assertExplanationAllowed(finding, { explainerId: 'author-2', reason })).toThrow(expect.objectContaining({ code: 'SELF_APPROVAL_DENIED', status: 403 }));
    expect(() => assertExplanationAllowed(finding, { explainerId: 'someone-else', reason })).not.toThrow();
  });

  it('wants a reason of 20 to 2000 characters, written without edge blanks', () => {
    expect(() => assertExplanationAllowed(finding, { explainerId: 'x', reason: 'too short' })).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
    expect(() => assertExplanationAllowed(finding, { explainerId: 'x', reason: ` ${reason}` })).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
    expect(() => assertExplanationAllowed(finding, { explainerId: 'x', reason: 'a'.repeat(2001) })).toThrow();
    expect(() => assertExplanationAllowed(finding, { explainerId: 'x', reason: 'a'.repeat(2000) })).not.toThrow();
  });
});
