import { DomainError } from '../src/errors';
import { assertEntryAllowed, builtInDefault, defaultGovernanceRule, entryRefusal, entryRuleOf, evaluateEntryRules, validateRuleParams, verdictTrail } from '../src/index';
import type { EntryFacts, EntryRule } from '../src/index';

const base = { check: 'CUMULATIVE_NOT_ABOVE_TOTAL', severity: 'BLOCK', fields: ['CUMULATIVE'], total_field: 'TOTAL_INVESTMENT', message: 'cumulative above total' };

const rule = (code: string, overrides: Record<string, unknown> = {}, version = 1): EntryRule => {
  const params = validateRuleParams('DATA_ENTRY_RULE', { ...base, ...overrides });
  return entryRuleOf({ type: 'DATA_ENTRY_RULE', code, version, ruleId: `id-${code}`, params });
};

const facts = (values: EntryFacts['values'], more: Partial<EntryFacts> = {}): EntryFacts => ({ surface: 'DIS_REPORT', values, ...more });

describe('data entry rules', () => {
  it('blocks a cumulative above the total investment and lets one at or below it through', () => {
    const rules = [rule('CUMULATIVE_NOT_ABOVE_TOTAL')];
    const over = evaluateEntryRules(rules, facts({ CUMULATIVE: '1000000001', TOTAL_INVESTMENT: '1000000000' }));
    expect(over.blocking).toHaveLength(1);
    expect(over.blocking[0]).toMatchObject({ ruleCode: 'CUMULATIVE_NOT_ABOVE_TOTAL', ruleVersion: 1, fields: ['CUMULATIVE', 'TOTAL_INVESTMENT'] });
    expect(evaluateEntryRules(rules, facts({ CUMULATIVE: '1000000000', TOTAL_INVESTMENT: '1000000000' })).violations).toEqual([]);
    expect(evaluateEntryRules(rules, facts({ CUMULATIVE: '999.5', TOTAL_INVESTMENT: '1000' })).violations).toEqual([]);
  });

  it('gives a cumulative the tolerance of the rule and skips the check when a fact is missing', () => {
    const tolerant = [rule('CUMULATIVE_NOT_ABOVE_TOTAL', { tolerance: 10 })];
    expect(evaluateEntryRules(tolerant, facts({ CUMULATIVE: '1010', TOTAL_INVESTMENT: '1000' })).violations).toEqual([]);
    expect(evaluateEntryRules(tolerant, facts({ CUMULATIVE: '1011', TOTAL_INVESTMENT: '1000' })).violations).toHaveLength(1);
    const skipped = evaluateEntryRules(tolerant, facts({ CUMULATIVE: '5' }));
    expect(skipped.skipped).toEqual([{ ruleCode: 'CUMULATIVE_NOT_ABOVE_TOTAL', reason: 'FACT_MISSING' }]);
    expect(skipped.evaluated).toEqual([]);
  });

  it('holds equity plus loan to the total, exactly or within the tolerance', () => {
    const exact = [rule('EQUITY_PLUS_DEBT', { check: 'PARTS_EQUAL_TOTAL', fields: ['EQUITY', 'DEBT'], total_field: 'TOTAL', tolerance: 0 })];
    expect(evaluateEntryRules(exact, facts({ EQUITY: '400', DEBT: '600', TOTAL: '1000' })).violations).toEqual([]);
    const off = evaluateEntryRules(exact, facts({ EQUITY: '400', DEBT: '599.5', TOTAL: '1000' }));
    expect(off.blocking[0]?.detail).toBe('PARTS_DIFFER sum=999.5 TOTAL=1000 gap=-0.5');
    const loose = [rule('EQUITY_PLUS_DEBT', { check: 'PARTS_EQUAL_TOTAL', fields: ['EQUITY', 'DEBT'], total_field: 'TOTAL', tolerance: 1 })];
    expect(evaluateEntryRules(loose, facts({ EQUITY: '400', DEBT: '599.5', TOTAL: '1000' })).violations).toEqual([]);
    // a part that is not there is for the rule "required", not for this one
    expect(evaluateEntryRules(exact, facts({ EQUITY: '400', TOTAL: '1000' })).skipped).toHaveLength(1);
  });

  it('refuses an entry for a period in a closed state, LOCKED unless the rule names others', () => {
    const locked = [rule('CLOSED_PERIOD_LOCKED', { check: 'PERIOD_LOCKED_AFTER_CLOSE', fields: ['REPORTING_PERIOD'], total_field: undefined })];
    expect(evaluateEntryRules(locked, facts({}, { periodStatus: 'LOCKED' })).blocking).toHaveLength(1);
    expect(evaluateEntryRules(locked, facts({}, { periodStatus: 'SOFT_CLOSED' })).violations).toEqual([]);
    expect(evaluateEntryRules(locked, facts({}, { periodStatus: 'OPEN' })).violations).toEqual([]);
    expect(evaluateEntryRules(locked, facts({})).skipped).toHaveLength(1);
    const soft = [rule('SOFT', { check: 'PERIOD_LOCKED_AFTER_CLOSE', fields: ['REPORTING_PERIOD'], total_field: undefined, closed_states: ['SOFT_CLOSED', 'LOCKED'] })];
    expect(evaluateEntryRules(soft, facts({}, { periodStatus: 'SOFT_CLOSED' })).blocking).toHaveLength(1);
  });

  it('requires fields, expanding the mandatory fields of the dictionary', () => {
    const required = [rule('MANDATORY_FIELDS', { check: 'FIELD_REQUIRED', fields: ['MANDATORY_FIELDS'], total_field: undefined })];
    const missing = evaluateEntryRules(required, facts({ CUMULATIVE: '  ', PLAN_YEAR: '10' }, { mandatory: ['CUMULATIVE', 'PLAN_YEAR', 'EXECUTED'] }));
    expect(missing.blocking[0]?.fields).toEqual(['CUMULATIVE', 'EXECUTED']);
    expect(evaluateEntryRules(required, facts({ CUMULATIVE: '1', PLAN_YEAR: '10', EXECUTED: '0' }, { mandatory: ['CUMULATIVE', 'PLAN_YEAR', 'EXECUTED'] })).violations).toEqual([]);
    expect(evaluateEntryRules(required, facts({})).violations).toEqual([]);
    const named = [rule('NAMED', { check: 'FIELD_REQUIRED', fields: ['CUMULATIVE'], total_field: undefined })];
    expect(evaluateEntryRules(named, facts({ CUMULATIVE: null })).blocking).toHaveLength(1);
  });

  it('checks the plausible range of a value with decimals exact, and a word that is not a number is out of range', () => {
    const range = [rule('PROGRESS', { check: 'VALUE_IN_RANGE', severity: 'WARN', fields: ['PHYSICAL_PROGRESS'], total_field: undefined, min: '0', max: '100' })];
    expect(evaluateEntryRules(range, facts({ PHYSICAL_PROGRESS: '100' })).violations).toEqual([]);
    expect(evaluateEntryRules(range, facts({ PHYSICAL_PROGRESS: '0' })).violations).toEqual([]);
    const high = evaluateEntryRules(range, facts({ PHYSICAL_PROGRESS: '100.000001' }));
    expect(high.blocking).toEqual([]);
    expect(high.warnings).toHaveLength(1);
    expect(evaluateEntryRules(range, facts({ PHYSICAL_PROGRESS: '-0.1' })).warnings).toHaveLength(1);
    expect(evaluateEntryRules(range, facts({ PHYSICAL_PROGRESS: 'abc' })).warnings).toHaveLength(1);
    expect(evaluateEntryRules(range, facts({})).skipped).toHaveLength(1);
    const lower = [rule('POSITIVE', { check: 'VALUE_IN_RANGE', fields: ['A'], total_field: undefined, min: '1' })];
    expect(evaluateEntryRules(lower, facts({ A: '0.99' })).blocking).toHaveLength(1);
  });

  it('applies a rule only on the surfaces it names', () => {
    const only = [rule('ONLY_IMPORT', { surfaces: ['INDICATOR_IMPORT'] })];
    const verdict = evaluateEntryRules(only, facts({ CUMULATIVE: '2', TOTAL_INVESTMENT: '1' }));
    expect(verdict.violations).toEqual([]);
    expect(verdict.skipped).toEqual([{ ruleCode: 'ONLY_IMPORT', reason: 'OTHER_SURFACE' }]);
    expect(evaluateEntryRules(only, { surface: 'INDICATOR_IMPORT', values: { CUMULATIVE: '2', TOTAL_INVESTMENT: '1' } }).blocking).toHaveLength(1);
  });

  it('judges in the order of the rule codes and the same facts give the same verdict', () => {
    const rules = [rule('B_RULE', { severity: 'WARN' }), rule('A_RULE')];
    const entry = facts({ CUMULATIVE: '5', TOTAL_INVESTMENT: '1' });
    const first = evaluateEntryRules(rules, entry);
    expect(first.violations.map((one) => one.ruleCode)).toEqual(['A_RULE', 'B_RULE']);
    expect(evaluateEntryRules([...rules].reverse(), entry)).toEqual(first);
    expect(first.blocking).toHaveLength(1);
    expect(first.warnings).toHaveLength(1);
  });

  it('turns the blocking violations into one 422 error that lists them, and lets warnings pass', () => {
    const verdict = evaluateEntryRules([rule('A_RULE'), rule('W_RULE', { severity: 'WARN' })], facts({ CUMULATIVE: '5', TOTAL_INVESTMENT: '1' }));
    const refusal = entryRefusal(verdict);
    expect(refusal).toBeInstanceOf(DomainError);
    expect(refusal).toMatchObject({ code: 'IND_ENTRY_RULE_VIOLATED', status: 422, detail: 'A_RULE' });
    expect((refusal?.extensions?.['violations'] as unknown[]).length).toBe(1);
    expect(() => assertEntryAllowed(verdict)).toThrow(DomainError);
    expect(() => assertEntryAllowed(evaluateEntryRules([rule('W_RULE', { severity: 'WARN' })], facts({ CUMULATIVE: '5', TOTAL_INVESTMENT: '1' })))).not.toThrow();
    const trail = verdictTrail(verdict);
    expect(JSON.stringify(trail)).not.toContain('cumulative above total');
    expect(trail['evaluated']).toEqual(['A_RULE', 'W_RULE']);
  });

  it('does not take a rule of another type or with params it cannot read', () => {
    expect(() => entryRuleOf({ type: 'KPI_DEFINITION', code: 'X', version: 1, ruleId: null, params: {} })).toThrow(DomainError);
    expect(() => entryRuleOf({ type: 'DATA_ENTRY_RULE', code: 'X', version: 1, ruleId: null, params: { check: 'NOPE', severity: 'BLOCK', fields: [] } })).toThrow(DomainError);
  });

  it('refuses params the registry cannot accept: each check says what it needs', () => {
    const refused = (overrides: Record<string, unknown>): string | undefined => {
      try {
        validateRuleParams('DATA_ENTRY_RULE', { ...base, ...overrides });
        return undefined;
      } catch (error) {
        return error instanceof DomainError ? error.detail : 'other';
      }
    };
    expect(refused({ total_field: 'CUMULATIVE' })).toBe('total_field');
    expect(refused({ fields: ['A', 'B'] })).toBe('fields');
    expect(refused({ check: 'PARTS_EQUAL_TOTAL', fields: ['A'], total_field: 'T' })).toBe('fields');
    expect(refused({ check: 'PARTS_EQUAL_TOTAL', fields: ['A', 'T'], total_field: 'T' })).toBe('total_field');
    expect(refused({ check: 'VALUE_IN_RANGE', total_field: undefined })).toBe('min');
    expect(refused({ check: 'VALUE_IN_RANGE', total_field: undefined, min: '5', max: '1' })).toBe('max');
    expect(refused({ check: 'VALUE_IN_RANGE', total_field: undefined, min: '1.5.5' })).toBe('min');
    expect(refused({ closed_states: ['LOCKED'] })).toBe('closed_states');
    expect(refused({ surfaces: [] })).toBe('surfaces');
    expect(refused({ surfaces: ['NOWHERE'] })).toBe('surfaces[0]');
    expect(refused({})).toBeUndefined();
  });

  it('keeps the starting rules as templates: every default reads as a rule and none is a rule in force', () => {
    for (const code of ['CUMULATIVE_NOT_ABOVE_TOTAL', 'EQUITY_PLUS_DEBT_EQUALS_TOTAL', 'CLOSED_PERIOD_LOCKED', 'MANDATORY_FIELDS', 'PROGRESS_PERCENT_IN_RANGE', 'CUMULATIVE_NOT_NEGATIVE']) {
      const resolved = defaultGovernanceRule('DATA_ENTRY_RULE', code);
      expect(resolved).toBeDefined();
      expect(resolved?.source).toBe('DEFAULT');
      expect(builtInDefault('DATA_ENTRY_RULE', code)?.unverified).toBe(true);
      expect(entryRuleOf(resolved as NonNullable<typeof resolved>).code).toBe(code);
    }
  });
});
