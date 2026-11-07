import { describe, expect, it } from 'vitest';
import { billionsOf, bottlenecksOf, clockText, coverageOf, dayText, hasCurve, heroOf, percentOf, toCashFlow, topRanked } from './overview-model';
import { toCommandCenter } from './model';
import { toRankings, toWarning } from './warning-model';

const S = '00000000-0000-4000-8000-0000000000f2';

describe('billionsOf', () => {
  it('reads whole dong as billions with two decimals, rounded half up, and says nothing for a missing amount', () => {
    expect(billionsOf('214710000000')).toBe('214,71');
    expect(billionsOf('1250000000000')).toBe('1.250,00');
    expect(billionsOf('0')).toBe('0,00');
    expect(billionsOf('5000000')).toBe('0,01');
    expect(billionsOf('4999999')).toBe('0,00');
    expect(billionsOf('-214710000000')).toBe('-214,71');
    expect(billionsOf(null)).toBeNull();
    expect(billionsOf('12.5')).toBeNull();
    expect(billionsOf('214710000000', 'en')).toBe('214.71');
  });

  it('keeps the exactness of an amount beyond what a float holds', () => {
    expect(billionsOf('9007199254740993000')).toBe('9.007.199.254,74');
  });
});

describe('percentOf', () => {
  it('writes a percent with two decimals, and nothing for no figure', () => {
    expect(percentOf('60.0000')).toBe('60,00');
    expect(percentOf('17.1768')).toBe('17,18');
    expect(percentOf(null)).toBeNull();
    expect(percentOf('x')).toBeNull();
  });
});

const tile = (code: string, overrides: Record<string, unknown> = {}) => ({ metric_code: code, value: '10.0000', numerator: null, denominator: null, null_reason: null, unit: 'PERCENT', formula: 'f', definition_status: 'SIGNED', context_token: 't', ...overrides });
const center = (tiles: unknown[]) => {
  const read = toCommandCenter({ snapshot_id: S, as_of_date: '2026-09-30', freshness: 'FRESH', definition_status: 'SIGNED', scope: { unit_id: null, projects: 3, scope_hash: 'h' }, tiles });
  if (read === undefined) throw new Error('fixture');
  return read;
};

describe('heroOf', () => {
  it('tells an amount of 0 from an amount that is missing, and clamps the ring', () => {
    expect(heroOf(center([tile('DISBURSED_TREASURY', { unit: 'VND', value: '0' })]))).toEqual({ disbursedVnd: '0', disbursedMissing: false, ringPercent: null });
    expect(heroOf(center([tile('DISBURSED_TREASURY', { unit: 'VND', value: null, null_reason: 'NO_DATA' })])).disbursedMissing).toBe(true);
    expect(heroOf(center([])).disbursedMissing).toBe(true);
    expect(heroOf(center([tile('DISBURSEMENT_RATE_PM', { value: '140.0000' })])).ringPercent).toBe(100);
    expect(heroOf(center([tile('DISBURSEMENT_RATE_PM', { value: null })])).ringPercent).toBeNull();
  });
});

const warning = (id: string, rule: string, project: string | null, plan: string | null, paid: string | null, severity = 'WARNING') =>
  toWarning({
    id,
    rule: { code: rule, name: `Rule ${rule}` },
    severity,
    status: 'OPEN',
    snapshot_id: S,
    project: project === null ? null : { id: project, code: project, name: `Project ${project}` },
    evidence: plan === null ? null : { snapshot_id: S, as_of_date: '2026-09-30', cells: [{ bucket: 'Y', plan_pm_assigned_vnd: plan, plan_local_added_vnd: '0', disbursed_treasury_vnd: paid }] },
  });
const warnings = (...entries: Array<ReturnType<typeof warning>>) => entries.flatMap((entry) => (entry === undefined ? [] : [entry]));

describe('bottlenecksOf', () => {
  it('groups by the rule, counts distinct projects, sums the plan not yet disbursed and orders by it', () => {
    const rows = bottlenecksOf(warnings(warning('1', 'A', 'p1', '100', '40'), warning('2', 'A', 'p1', '100', '10'), warning('3', 'A', 'p2', '50', '50'), warning('4', 'B', 'p3', '1000', '0', 'CRITICAL')));
    expect(rows.map((row) => row.ruleCode)).toEqual(['B', 'A']);
    expect(rows[1]).toMatchObject({ count: 3, projects: 2, impactVnd: '90', worst: 'WARNING' });
    expect(rows[0]).toMatchObject({ count: 1, projects: 1, impactVnd: '1000', worst: 'CRITICAL', sample: ['Project p3'] });
  });

  it('puts a cause with no figure of impact after the ones that have one, and never gives it an impact of 0', () => {
    const rows = bottlenecksOf(warnings(warning('1', 'A', 'p1', null, null), warning('2', 'A', 'p2', null, null), warning('3', 'B', 'p3', '10', '9')));
    expect(rows.map((row) => row.ruleCode)).toEqual(['B', 'A']);
    expect(rows[1]?.impactVnd).toBeNull();
    expect(rows[1]).toMatchObject({ count: 2, projects: 2 });
  });

  it('does not count a Treasury with no figure as a payment of 0, and never reads a negative gap', () => {
    const rows = bottlenecksOf(warnings(warning('1', 'A', 'p1', '100', null), warning('2', 'B', 'p2', '100', '150')));
    expect(rows.find((row) => row.ruleCode === 'A')?.impactVnd).toBeNull();
    expect(rows.find((row) => row.ruleCode === 'B')?.impactVnd).toBe('0');
  });

  it('is empty for no warning', () => {
    expect(bottlenecksOf([])).toEqual([]);
  });
});

describe('toCashFlow', () => {
  it('reads the curve by month in billions and leaves a month with no figure with no point', () => {
    const flow = toCashFlow({ plan_year: 2026, cutoff_month: 9, curve: [{ month: 10, actual_cumulative_vnd: null, forecast_cumulative_vnd: '300000000000' }, { month: 9, actual_cumulative_vnd: '214710000000', forecast_cumulative_vnd: '214710000000' }, { month: 20, actual_cumulative_vnd: '1', forecast_cumulative_vnd: '1' }, { month: 'x' }] });
    expect(flow).toEqual({ planYear: 2026, cutoffMonth: 9, points: [{ month: 9, actualBillions: 214.71, forecastBillions: 214.71 }, { month: 10, actualBillions: null, forecastBillions: 300 }] });
    expect(flow !== undefined && hasCurve(flow)).toBe(true);
  });

  it('is undefined when the answer has no curve, and has nothing to draw when no month has a figure', () => {
    expect(toCashFlow({})).toBeUndefined();
    expect(toCashFlow(null)).toBeUndefined();
    const flow = toCashFlow({ curve: [{ month: 1, actual_cumulative_vnd: null, forecast_cumulative_vnd: null }] });
    expect(flow !== undefined && hasCurve(flow)).toBe(false);
  });
});

describe('topRanked', () => {
  const unit = (id: string, rank: number) => ({ rank, unit: { id, code: id, name: id }, plan_vnd: '1', disbursed_vnd: '1', rate_pct: '1', excluded_reason: null });
  const table = (denominator: string, ids: string[]) => ({ comparison_group: 'G', denominator_kind: denominator, ranked: ids.map((id, index) => unit(id, index + 1)), excluded: [] });
  const rankings = (tables: unknown[]) => {
    const read = toRankings({ snapshot_id: S, as_of_date: '2026-09-30', tables });
    if (read === undefined) throw new Error('fixture');
    return read;
  };

  it('takes the first rows of the table over the plan the Prime Minister gave and never mixes the other denominator in', () => {
    const top = topRanked(rankings([table('TOTAL_INCL_LOCAL', ['x']), table('PM_ASSIGNED', ['a', 'b', 'c'])]), 2);
    expect(top?.rows.map((row) => row.unitId)).toEqual(['a', 'b']);
    expect(top?.total).toBe(3);
  });

  it('is undefined when nothing is ranked', () => {
    expect(topRanked(rankings([]), 5)).toBeUndefined();
    expect(topRanked(rankings([table('PM_ASSIGNED', [])]), 5)).toBeUndefined();
  });
});

describe('the words of a day and of a coverage', () => {
  it('writes a day as day/month/year and keeps what is not a day as it came', () => {
    expect(dayText('2026-09-30')).toBe('30/09/2026');
    expect(dayText('soon')).toBe('soon');
    expect(clockText(0)).toBe('');
    expect(clockText(Date.parse('2026-11-07T00:05:00Z'))).toBe('07:05');
  });

  it('counts the projects that have a figure, and gives no percent for a scope with no project', () => {
    expect(coverageOf(10, 2)).toEqual({ sent: 8, total: 10, percent: 80 });
    expect(coverageOf(0, 0)).toEqual({ sent: 0, total: 0, percent: null });
    expect(coverageOf(3, 9)).toEqual({ sent: 0, total: 3, percent: 0 });
  });
});
