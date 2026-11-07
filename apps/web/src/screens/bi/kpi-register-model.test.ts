import { describe, expect, it } from 'vitest';
import { rawMetric, sum } from './test-support';
import { toMetric } from './bi-model';
import { definitionFromMetric, definitionFromRegister, registerFor, toKpiRegister } from './kpi-register-model';

const rawDefinition = (overrides: Record<string, unknown> = {}) => ({
  code: 'DISBURSEMENT_RATE_PM',
  name: 'Tỷ lệ giải ngân PM',
  formula: 'Đã giải ngân / kế hoạch',
  numerator: 'Giải ngân lũy kế',
  denominator: 'Kế hoạch vốn năm',
  exclusions: ['Vốn chưa phân bổ'],
  unit: 'PERCENT',
  period: 'Lũy kế đến ngày chốt',
  source: 'DIS, số đã chốt',
  owner: 'CAPITAL_PLANNER',
  decimals: 2,
  refresh_hours: 24,
  allowed_lag_days: 2,
  rag_code: 'RATE',
  version: 0,
  origin: 'DEFAULT',
  unverified: true,
  certification: { status: 'CERTIFIED', version: 0, origin: 'PLATFORM', certified_by: null, at: null },
  ...overrides,
});

describe('toKpiRegister', () => {
  it('reads every field of a definition and its certification', () => {
    const register = toKpiRegister({ as_of: '2026-11-08', definitions: [rawDefinition(), rawDefinition({ code: 'OPEN_WARNINGS', numerator: null, denominator: null, exclusions: [], allowed_lag_days: null, certification: null, origin: 'RULE', version: 2, unverified: false })] });
    expect(register?.asOf).toBe('2026-11-08');
    expect(register?.definitions[0]).toMatchObject({ code: 'DISBURSEMENT_RATE_PM', numerator: 'Giải ngân lũy kế', exclusions: ['Vốn chưa phân bổ'], allowedLagDays: 2, version: 0, origin: 'DEFAULT', unverified: true, certification: { status: 'CERTIFIED', origin: 'PLATFORM' } });
    expect(register?.definitions[1]).toMatchObject({ numerator: null, allowedLagDays: null, certification: null, origin: 'RULE', version: 2 });
    expect(register?.skipped).toBe(0);
  });

  it('is not an answer without the list; counts the definitions it cannot read', () => {
    expect(toKpiRegister({ as_of: 'x' })).toBeUndefined();
    expect(toKpiRegister(null)).toBeUndefined();
    const register = toKpiRegister({ definitions: [rawDefinition({ formula: undefined }), rawDefinition()] });
    expect(register?.definitions.length).toBe(1);
    expect(register?.skipped).toBe(1);
  });
});

describe('the definition behind the "i"', () => {
  const register = toKpiRegister({ definitions: [rawDefinition()] });

  it('finds the register entry of a metric code whatever its case', () => {
    expect(registerFor(register, 'disbursement_rate_pm')?.code).toBe('DISBURSEMENT_RATE_PM');
    expect(registerFor(register, 'disbursed')).toBeUndefined();
    expect(registerFor(undefined, 'disbursed')).toBeUndefined();
  });

  it('takes the words of the register, and says the default has no version of its own', () => {
    const definition = definitionFromRegister((register?.definitions ?? [])[0]!);
    expect(definition).toMatchObject({ from: 'REGISTER', name: 'Tỷ lệ giải ngân PM', formula: 'Đã giải ngân / kế hoạch', owner: 'CAPITAL_PLANNER', unverified: true, builtIn: true });
  });

  it('falls back to the metric the screen has: its formula, the ratio parts, its dataset as the source and its revision', () => {
    const metric = toMetric(rawMetric({ revision: 3, numerator_ast: sum('GIAI_NGAN'), denominator_ast: sum('KE_HOACH_TTG') }));
    expect(metric).toBeDefined();
    const definition = definitionFromMetric(metric!, 'Bộ dữ liệu DS-DISB', 'Chưa có');
    expect(definition).toMatchObject({ from: 'METRIC', name: 'disbursement_rate', formula: 'SUM(GIAI_NGAN) / SUM(KE_HOACH_TTG)', numerator: 'SUM(GIAI_NGAN)', denominator: 'SUM(KE_HOACH_TTG)', source: 'Bộ dữ liệu DS-DISB', version: 3, builtIn: false, unverified: false });
    expect(definition.owner).toBe('00000000');
    const additive = toMetric(rawMetric({ aggregation_type: 'additive', numerator_ast: null, denominator_ast: null, expression_ast: sum('GIAI_NGAN'), owner_id: '' }));
    expect(definitionFromMetric(additive!, 's', 'Chưa có')).toMatchObject({ formula: 'SUM(GIAI_NGAN)', numerator: null, denominator: null, owner: 'Chưa có' });
  });
});
