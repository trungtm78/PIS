import { INDICATOR_SEEDS, dictionaryFindings, filterDictionary, indicatorOf, isEnterable, mandatoryFieldsOf, normalizeLabel, resolveGovernanceRule, ruleTypeOf, validateRuleParams } from '../src/index';
import type { GovernanceRuleVersion, IndicatorEntry } from '../src/index';

const entry = (code: string, today = '2026-11-08'): IndicatorEntry => {
  const resolved = resolveGovernanceRule([], 'KPI_DEFINITION', code, today);
  if (resolved === undefined) throw new Error(`no default for ${code}`);
  return indicatorOf(resolved);
};

describe('the indicator dictionary', () => {
  it('has a starting indicator for every seed, readable as a KPI definition with the dictionary members', () => {
    const codes = ruleTypeOf('KPI_DEFINITION').defaults;
    for (const seed of INDICATOR_SEEDS) expect(codes[seed.code]).toBeDefined();
    const total = entry('TOTAL_INVESTMENT');
    expect(total).toMatchObject({ code: 'TOTAL_INVESTMENT', unit: 'VND', category: 'FUNDING', valueKind: 'ENTERED', entryField: 'TOTAL_INVESTMENT', origin: 'DEFAULT', unverified: true, version: 0 });
    expect(total.name).toBe('Tổng mức đầu tư');
    expect(total.aliases).toContain('TMĐT');
    expect(isEnterable(total)).toBe(true);
  });

  it('reads the derived figures of the funding model as not enterable, with numerator and denominator', () => {
    const rate = entry('RATE_YEAR_IN_FORCE');
    expect(rate).toMatchObject({ valueKind: 'DERIVED', entryField: null, unit: 'PERCENT', category: 'RATE' });
    expect(rate.numerator).not.toBeNull();
    expect(rate.denominator).not.toBeNull();
    expect(isEnterable(rate)).toBe(false);
  });

  it('reads a KPI of the command centre that has no dictionary members as a derived figure', () => {
    const kpi = entry('DISBURSEMENT_RATE');
    expect(kpi).toMatchObject({ valueKind: 'DERIVED', category: null, entryField: null, aliases: [], requiredOn: [] });
    expect(isEnterable(kpi)).toBe(false);
  });

  it('accepts the dictionary members in a version a tenant approves and refuses a wrong one', () => {
    const valid = { name: 'Total investment', formula: 'Approved total investment, in dong', source: 'Customer dictionary', unit: 'VND', owner: 'PROJECT_OWNER', decimals: 0, refresh_hours: 24, category: 'FUNDING', value_kind: 'ENTERED', entry_field: 'TOTAL_INVESTMENT', vat_basis: 'EXCLUDING_VAT', aliases: ['TMDT'], required_on: ['DIS_REPORT'] };
    expect(validateRuleParams('KPI_DEFINITION', valid)).toMatchObject({ vat_basis: 'EXCLUDING_VAT', required_on: ['DIS_REPORT'] });
    expect(() => validateRuleParams('KPI_DEFINITION', { ...valid, category: 'NOPE' })).toThrow();
    expect(() => validateRuleParams('KPI_DEFINITION', { ...valid, required_on: ['ELSEWHERE'] })).toThrow();
    expect(() => validateRuleParams('KPI_DEFINITION', { ...valid, aliases: Array.from({ length: 11 }, (_, index) => `a${index}`) })).toThrow();
  });

  it('puts the version, the approval days and the rule of a tenant ahead of the default', () => {
    const version: GovernanceRuleVersion = {
      id: 'rule-1',
      type: 'KPI_DEFINITION',
      code: 'TOTAL_INVESTMENT',
      version: 3,
      status: 'APPROVED',
      params: { name: 'Total investment', formula: 'Approved total investment, in dong', source: 'Customer dictionary', unit: 'VND', owner: 'PROJECT_OWNER', decimals: 0, refresh_hours: 24, value_kind: 'ENTERED', entry_field: 'TOTAL_INVESTMENT' },
      effectiveFrom: '2026-12-01',
      effectiveTo: null,
      unitId: null,
    };
    const resolved = resolveGovernanceRule([version], 'KPI_DEFINITION', 'TOTAL_INVESTMENT', '2026-12-02');
    const indicator = indicatorOf(resolved as NonNullable<typeof resolved>, [version]);
    expect(indicator).toMatchObject({ version: 3, origin: 'RULE', effectiveFrom: '2026-12-01', ruleId: 'rule-1', unverified: false });
    expect(entry('TOTAL_INVESTMENT').version).toBe(0);
  });

  it('filters by category, kind, entry and words of the code, name or alias', () => {
    const all = INDICATOR_SEEDS.map((seed) => entry(seed.code));
    expect(filterDictionary(all, { enterable: true }).every(isEnterable)).toBe(true);
    expect(filterDictionary(all, { category: 'RATE' }).map((one) => one.code)).toEqual(['RATE_SINCE_START', 'RATE_YEAR_IN_FORCE', 'STRUCTURE_SHARE']);
    expect(filterDictionary(all, { valueKind: 'DERIVED' }).length).toBe(INDICATOR_SEEDS.filter((seed) => seed.valueKind === 'DERIVED').length);
    expect(filterDictionary(all, { text: ' tmđt ' }).map((one) => one.code)).toEqual(['TOTAL_INVESTMENT']);
    expect(filterDictionary(all, { text: 'vốn vay' }).map((one) => one.code)).toContain('LOAN_CAPITAL');
    expect(filterDictionary(all, { text: 'no such thing' })).toEqual([]);
  });

  it('finds what a reader must settle before mapping a form: shared names and entry flaws', () => {
    expect(dictionaryFindings(INDICATOR_SEEDS.map((seed) => entry(seed.code)))).toEqual([]);
    const a = entry('EQUITY_CAPITAL');
    const b = { ...entry('LOAN_CAPITAL'), entryField: 'EQUITY', aliases: ['  VỐN   CHỦ SỞ HỮU '] };
    const bad = { ...entry('PLAN_YEAR'), entryField: null };
    const derived = { ...entry('REMAINING_YEAR'), entryField: 'LEFT' };
    const found = dictionaryFindings([a, b, bad, derived]);
    expect(found.map((one) => one.code).sort()).toEqual(['ALIAS_SHARED', 'DERIVED_WITH_FIELD', 'ENTERED_WITHOUT_FIELD', 'ENTRY_FIELD_SHARED']);
    expect(found.find((one) => one.code === 'ALIAS_SHARED')?.indicators).toEqual(['EQUITY_CAPITAL', 'LOAN_CAPITAL']);
  });

  it('lists the mandatory fields of a surface from the entered indicators that require them', () => {
    const all = INDICATOR_SEEDS.map((seed) => entry(seed.code));
    expect(mandatoryFieldsOf(all, 'INDICATOR_ENTRY')).toEqual(['CUMULATIVE']);
    expect(mandatoryFieldsOf(all, 'DIS_REPORT')).toEqual([]);
  });

  it('compares labels without case and extra spaces but keeps the accents of the words', () => {
    expect(normalizeLabel('  Vốn   Vay ')).toBe('vốn vay');
    expect(normalizeLabel('Vốn vay')).not.toBe(normalizeLabel('Von vay'));
    expect(normalizeLabel('Vốn vay'.normalize('NFD'))).toBe(normalizeLabel('Vốn vay'));
  });
});
