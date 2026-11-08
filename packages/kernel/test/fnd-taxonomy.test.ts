import { DomainError } from '../src/errors.ts';
import { defaultGovernanceRule, describeRuleType, isGovernanceRuleType, resolveGovernanceRule } from '../src/governance-rules.ts';
import type { GovernanceRuleVersion } from '../src/governance-rules.ts';
import {
  FUNDING_TAXONOMY_RULE_TYPE,
  assertClassAndTier,
  assertClassCrosswalk,
  assertPackChange,
  builtInPack,
  builtInPackParams,
  fundingPackCodeOfEdition,
  parseFundingPack,
  refineFundingPack,
  splitOfOrigin,
  treasuryCarrier,
} from '../src/fnd-taxonomy.ts';
import { assertPeriodAccepts, assertOrdinal, monthsOf, periodRange, quarterOfMonth, yearMayClose } from '../src/fnd-period.ts';
import { FUNDING_PACK_CODES } from '../src/index.ts';

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const fails = (run: () => unknown, code: string, status: number, detail?: string): void => {
  try {
    run();
  } catch (failure) {
    expect(failure).toBeInstanceOf(DomainError);
    expect(failure).toMatchObject({ code, status, ...(detail === undefined ? {} : { detail }) });
    return;
  }
  throw new Error(`expected ${code}`);
};

describe('the FUNDING_TAXONOMY rule type (4)', () => {
  it('is registered by the domain function with a default for each pack, and the public pack is not marked unverified', () => {
    expect(isGovernanceRuleType(FUNDING_TAXONOMY_RULE_TYPE)).toBe(true);
    const described = describeRuleType(FUNDING_TAXONOMY_RULE_TYPE);
    expect(described.ownerModule).toBe('FND');
    expect(described.codes.map((one) => one.code)).toEqual([...FUNDING_PACK_CODES]);
    expect(described.codes.find((one) => one.code === 'PUBLIC')?.unverified).toBe(false);
    expect(described.codes.find((one) => one.code === 'ENTERPRISE')?.unverified).toBe(true);
    expect(defaultGovernanceRule(FUNDING_TAXONOMY_RULE_TYPE, 'ENTERPRISE')?.unverified).toBe(true);
  });

  it('the default params of a pack pass the closed schema and the cross-field rules, and parse into the shape the engine reads', () => {
    for (const code of FUNDING_PACK_CODES) {
      const pack = parseFundingPack(code, builtInPackParams(code));
      expect(pack.packCode).toBe(code);
      expect(pack.classes.map((one) => one.code)).toContain('OTHER');
    }
  });

  it('PUBLIC keeps the six cells of the paper form, the plan split as planSplitOf does and the Treasury for the year plan', () => {
    const pack = builtInPack('PUBLIC');
    expect(pack.classes.map((one) => one.code)).toEqual(['CURRENT_YEAR', 'CARRYOVER', 'OTHER']);
    expect(pack.tiers.map((one) => one.code)).toEqual(['CENTRAL', 'LOCAL']);
    expect(pack.subsets).toEqual([{ code: 'CTMTQG', label: expect.any(String), ofClasses: ['CURRENT_YEAR', 'CARRYOVER'] }]);
    expect(pack).toMatchObject({ entryMode: 'CUMULATIVE_ENTRY', phasingMustSum: false, actualsPrecedence: 'TREASURY_HEADLINE', varianceTolerance: { pct: 5, absVnd: 0 } });
    expect(treasuryCarrier(pack)).toEqual({ classCode: 'CURRENT_YEAR', tierCode: 'CENTRAL' });
    expect(pack.ratios.map((one) => one.code)).toEqual(['RATE_PM', 'RATE_TOTAL', 'RATE_CARRYOVER']);
    for (const origin of ['PM_ASSIGNED', 'CARRYOVER', null]) expect(splitOfOrigin(pack, origin)).toBe('PRIMARY');
    for (const origin of ['LOCAL_ADDED', 'CENTRAL_SUPPORT', 'REVENUE_INCREASE']) expect(splitOfOrigin(pack, origin)).toBe('ADDED');
  });

  it('ENTERPRISE counts own equity, borrowings and other, in one tier, with the period entry, the sum rule and the reported figure until reconciled', () => {
    const pack = builtInPack('ENTERPRISE');
    expect(pack.classes.map((one) => one.code)).toEqual(['EQUITY', 'LOAN', 'OTHER']);
    expect(pack.tiers.map((one) => one.code)).toEqual(['ALL']);
    expect(pack.tags.map((one) => one.code)).toEqual(['ODA', 'COMMERCIAL_LOAN', 'BOND', 'GROUP_LOAN']);
    expect(pack.measures).toEqual(['EXECUTED', 'DISBURSED']);
    expect(pack).toMatchObject({ entryMode: 'PERIOD_ENTRY', phasingMustSum: true, actualsPrecedence: 'REPORTED_UNTIL_RECONCILED', varianceTolerance: { pct: 1, absVnd: 1_000_000 } });
    expect(pack.originGroups.primary).toEqual(['GROUP_ASSIGNED', 'BOARD_APPROVED', 'CARRYOVER']);
    expect(pack.ratios.map((one) => one.code)).toEqual(['RATE_YEAR_IN_FORCE', 'RATE_YEAR_ORIGINAL', 'RATE_PERIOD', 'RATE_YTD_PHASED', 'RATE_OUTLOOK_YEAR', 'RATE_SINCE_START', 'ESTIMATE_ACCURACY', 'STRUCTURE_SHARE']);
    expect(treasuryCarrier(pack)).toBeUndefined();
  });

  it('refine names the offending field: duplicate class, no OTHER, unknown subset, a bad tier list, origins in both groups, a class with no source of actuals', () => {
    const params = (mutate: (value: Record<string, unknown>) => void): Record<string, unknown> => {
      const copy = clone(builtInPackParams('PUBLIC'));
      mutate(copy);
      return copy;
    };
    const classes = (value: Record<string, unknown>): Array<Record<string, unknown>> => value['classes'] as Array<Record<string, unknown>>;
    expect(refineFundingPack(builtInPackParams('PUBLIC'))).toBeUndefined();
    expect(refineFundingPack(params((value) => (classes(value)[1] = { ...classes(value)[0] })))).toBe('classes');
    expect(refineFundingPack(params((value) => classes(value).pop()))).toBe('classes');
    expect(refineFundingPack(params((value) => (classes(value)[0] = { ...classes(value)[0], takes_subsets: ['NOPE'] })))).toBe('classes');
    expect(refineFundingPack(params((value) => (value['subsets'] = [{ code: 'CTMTQG', label: 'x', of_classes: ['NOPE'] }])))).toBe('subsets');
    expect(refineFundingPack(params((value) => (value['tiers'] = [{ code: 'CENTRAL', label: 'x' }])))).toBe('tiers');
    expect(refineFundingPack(params((value) => (value['tiers'] = [{ code: 'ALL', label: 'x' }, { code: 'LOCAL', label: 'y' }])))).toBe('tiers');
    expect(refineFundingPack(params((value) => (value['origin_groups'] = { PRIMARY: ['PM_ASSIGNED'], ADDED: ['PM_ASSIGNED'] })))).toBe('origin_groups');
    expect(refineFundingPack(params((value) => (value['actuals_source'] = [{ class_codes: ['CURRENT_YEAR'], source: 'TREASURY' }])))).toBe('actuals_source');
    expect(refineFundingPack(params((value) => (value['ratios'] = [{ code: 'X', numerator: 'NOPE', denominator: 'PLAN_IN_FORCE', class_filter: [], basis: 'OFFICIAL' }])))).toBe('ratios');
    expect(refineFundingPack(params((value) => (value['ratios'] = [{ code: 'X', numerator: 'CLASS_SUM', denominator: 'PLAN_IN_FORCE', class_filter: [], basis: 'OFFICIAL' }])))).toBe('ratios');
    expect(refineFundingPack(params((value) => (value['ratios'] = [{ code: 'X', numerator: 'ACTUAL', denominator: 'PLAN_IN_FORCE', class_filter: ['NOPE'], basis: 'OFFICIAL' }])))).toBe('ratios');
  });

  it('parsing a pack that breaks a rule is 422 GOVERNANCE_RULE_PARAMS_INVALID naming the field', () => {
    const broken = clone(builtInPackParams('ENTERPRISE'));
    broken['classes'] = [{ code: 'EQUITY', label: 'x', additive: true, takes_subsets: [] }, { code: 'LOAN', label: 'y', additive: true, takes_subsets: [] }];
    fails(() => parseFundingPack('ENTERPRISE', broken), 'GOVERNANCE_RULE_PARAMS_INVALID', 422, 'classes');
    fails(() => parseFundingPack('ENTERPRISE', 'nope'), 'GOVERNANCE_RULE_PARAMS_INVALID', 422, 'params');
  });

  it('an approved rule of the tenant replaces the default and carries its version', () => {
    const changed = clone(builtInPackParams('ENTERPRISE'));
    changed['phasing_must_sum'] = false;
    const version: GovernanceRuleVersion = { id: 'r1', type: FUNDING_TAXONOMY_RULE_TYPE, code: 'ENTERPRISE', version: 3, status: 'APPROVED', params: changed, effectiveFrom: '2026-01-01', effectiveTo: null, unitId: null };
    const resolved = resolveGovernanceRule([version], FUNDING_TAXONOMY_RULE_TYPE, 'ENTERPRISE', '2026-06-01');
    expect(resolved).toMatchObject({ source: 'RULE', version: 3, ruleId: 'r1' });
    expect(parseFundingPack('ENTERPRISE', resolved?.params).phasingMustSum).toBe(false);
  });

  it('the edition names the pack; a class or a tier outside the pack is 422 FUNDING_CLASS_UNKNOWN', () => {
    expect(fundingPackCodeOfEdition('public')).toBe('PUBLIC');
    expect(fundingPackCodeOfEdition('enterprise')).toBe('ENTERPRISE');
    const pack = builtInPack('ENTERPRISE');
    assertClassAndTier(pack, 'EQUITY', 'ALL');
    fails(() => assertClassAndTier(pack, 'CURRENT_YEAR', 'ALL'), 'FUNDING_CLASS_UNKNOWN', 422, 'class_code');
    fails(() => assertClassAndTier(pack, 'EQUITY', 'CENTRAL'), 'FUNDING_CLASS_UNKNOWN', 422, 'tier_code');
  });

  it('a pack that already has a frozen snapshot cannot change (409 TAXONOMY_PACK_LOCKED); a new version of the same pack can; a removed class needs its crosswalk', () => {
    assertPackChange(null, 'ENTERPRISE', true);
    assertPackChange('PUBLIC', 'PUBLIC', true);
    assertPackChange('PUBLIC', 'ENTERPRISE', false);
    fails(() => assertPackChange('PUBLIC', 'ENTERPRISE', true), 'TAXONOMY_PACK_LOCKED', 409);
    const before = builtInPack('ENTERPRISE');
    const next = clone(builtInPackParams('ENTERPRISE'));
    next['classes'] = [{ code: 'OWN', label: 'x', additive: true, takes_subsets: [] }, { code: 'OTHER', label: 'y', additive: true, takes_subsets: [] }];
    next['actuals_source'] = [{ class_codes: ['OWN', 'OTHER'], source: 'ERP' }];
    const after = parseFundingPack('ENTERPRISE', next);
    fails(() => assertClassCrosswalk(before, after, {}), 'FUNDING_CLASS_UNKNOWN', 422, 'class_crosswalk');
    fails(() => assertClassCrosswalk(before, after, { EQUITY: 'OWN', LOAN: 'NOPE' }), 'FUNDING_CLASS_UNKNOWN', 422);
    assertClassCrosswalk(before, after, { EQUITY: 'OWN', LOAN: 'OTHER' });
  });
});

describe('the periods of the figures (5.1)', () => {
  it('a month is in the quarter ceil(m / 3), a quarter in its year, by dates', () => {
    expect([1, 3, 4, 6, 7, 9, 10, 12].map(quarterOfMonth)).toEqual([1, 1, 2, 2, 3, 3, 4, 4]);
    expect(periodRange({ grain: 'MONTH', planYear: 2026, ordinal: 2 })).toEqual({ start: '2026-02-01', end: '2026-02-28' });
    expect(periodRange({ grain: 'MONTH', planYear: 2028, ordinal: 2 })).toEqual({ start: '2028-02-01', end: '2028-02-29' });
    expect(periodRange({ grain: 'QUARTER', planYear: 2026, ordinal: 4 })).toEqual({ start: '2026-10-01', end: '2026-12-31' });
    expect(periodRange({ grain: 'YEAR', planYear: 2026, ordinal: 0 })).toEqual({ start: '2026-01-01', end: '2026-12-31' });
    expect(monthsOf({ grain: 'QUARTER', planYear: 2026, ordinal: 3 }).map((one) => one.ordinal)).toEqual([7, 8, 9]);
  });

  it('refuses an ordinal outside the grain and a year that is not a plan year', () => {
    fails(() => assertOrdinal('MONTH', 13), 'VALIDATION_FAILED', 422, 'period_ordinal');
    fails(() => assertOrdinal('QUARTER', 0), 'VALIDATION_FAILED', 422);
    fails(() => assertOrdinal('YEAR', 1), 'VALIDATION_FAILED', 422);
    fails(() => periodRange({ grain: 'MONTH', planYear: 1800, ordinal: 1 }), 'VALIDATION_FAILED', 422, 'plan_year');
  });

  it('a locked period accepts nothing (409 FIGURE_PERIOD_LOCKED); a soft-closed one takes no new estimate; a year closes only when month 12 and quarter 4 are locked', () => {
    assertPeriodAccepts('OPEN', 'ESTIMATE');
    assertPeriodAccepts('SOFT_CLOSED', 'ACTUAL');
    fails(() => assertPeriodAccepts('SOFT_CLOSED', 'ESTIMATE'), 'ESTIMATE_AFTER_ACTUAL', 422);
    fails(() => assertPeriodAccepts('LOCKED', 'ACTUAL'), 'FIGURE_PERIOD_LOCKED', 409);
    expect(yearMayClose({ month12: 'LOCKED', quarter4: 'LOCKED' })).toBe(true);
    expect(yearMayClose({ month12: 'LOCKED', quarter4: 'SOFT_CLOSED' })).toBe(false);
    expect(yearMayClose({ month12: undefined, quarter4: 'LOCKED' })).toBe(false);
  });
});
