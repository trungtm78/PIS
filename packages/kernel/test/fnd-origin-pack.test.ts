import { DomainError } from '../src/errors.ts';
import { assertAppropriationForPack, budgetLevelsOfPack, builtInPack, builtInPackParams, originsOfPack, parseFundingPack, refineFundingPack } from '../src/fnd-taxonomy.ts';
import { registerAllGovernanceRules, validateRuleParams } from '../src/governance-rules.ts';

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const fails = (run: () => unknown, field: string): void => {
  try {
    run();
  } catch (failure) {
    expect(failure).toBeInstanceOf(DomainError);
    expect(failure).toMatchObject({ code: 'VALIDATION_FAILED', status: 422, detail: field });
    return;
  }
  throw new Error(`expected a refusal naming ${field}`);
};

describe('the origin, the level and the decision of an appropriation by pack (ENT-3e, CN.01)', () => {
  const enterprise = builtInPack('ENTERPRISE');
  const publicPack = builtInPack('PUBLIC');

  it('lists the origins and the levels of each pack', () => {
    expect(originsOfPack(enterprise)).toEqual(['GROUP_ASSIGNED', 'BOARD_APPROVED', 'CARRYOVER']);
    expect(budgetLevelsOfPack(enterprise)).toEqual(['ALL']);
    expect(originsOfPack(publicPack)).toEqual(['PM_ASSIGNED', 'CARRYOVER', 'LOCAL_ADDED', 'CENTRAL_SUPPORT', 'REVENUE_INCREASE']);
    expect(budgetLevelsOfPack(publicPack)).toEqual(['CENTRAL', 'LOCAL']);
  });

  it('the public pack binds no kind of decision to an origin, so its appropriations carry none', () => {
    expect(publicPack.originDecisions.size).toBe(0);
    for (const origin of originsOfPack(publicPack)) {
      assertAppropriationForPack(publicPack, { origin, budgetLevel: 'CENTRAL', decisionKind: null });
      assertAppropriationForPack(publicPack, { origin, budgetLevel: 'LOCAL', decisionKind: undefined });
      fails(() => assertAppropriationForPack(publicPack, { origin, budgetLevel: 'LOCAL', decisionKind: 'GROUP_RESOLUTION' }), 'decision_kind');
    }
  });

  it('the enterprise pack splits the resolution of the group from the decision of the company', () => {
    assertAppropriationForPack(enterprise, { origin: 'GROUP_ASSIGNED', budgetLevel: 'ALL', decisionKind: 'GROUP_RESOLUTION' });
    assertAppropriationForPack(enterprise, { origin: 'GROUP_ASSIGNED', budgetLevel: 'ALL', decisionKind: 'GROUP_DECISION' });
    assertAppropriationForPack(enterprise, { origin: 'BOARD_APPROVED', budgetLevel: 'ALL', decisionKind: 'COMPANY_DECISION' });
    assertAppropriationForPack(enterprise, { origin: 'BOARD_APPROVED', budgetLevel: 'ALL', decisionKind: 'COMPANY_RESOLUTION' });
    assertAppropriationForPack(enterprise, { origin: 'CARRYOVER', budgetLevel: 'ALL', decisionKind: 'COMPANY_DECISION' });
    fails(() => assertAppropriationForPack(enterprise, { origin: 'GROUP_ASSIGNED', budgetLevel: 'ALL', decisionKind: 'COMPANY_DECISION' }), 'decision_kind');
    fails(() => assertAppropriationForPack(enterprise, { origin: 'BOARD_APPROVED', budgetLevel: 'ALL', decisionKind: 'GROUP_RESOLUTION' }), 'decision_kind');
    fails(() => assertAppropriationForPack(enterprise, { origin: 'BOARD_APPROVED', budgetLevel: 'ALL', decisionKind: null }), 'decision_kind');
  });

  it('refuses an origin or a level that the pack does not list, in both directions', () => {
    fails(() => assertAppropriationForPack(enterprise, { origin: 'PM_ASSIGNED', budgetLevel: 'ALL', decisionKind: 'GROUP_RESOLUTION' }), 'origin');
    fails(() => assertAppropriationForPack(enterprise, { origin: 'GROUP_ASSIGNED', budgetLevel: 'CENTRAL', decisionKind: 'GROUP_RESOLUTION' }), 'budget_level');
    fails(() => assertAppropriationForPack(publicPack, { origin: 'GROUP_ASSIGNED', budgetLevel: 'CENTRAL', decisionKind: null }), 'origin');
    fails(() => assertAppropriationForPack(publicPack, { origin: 'PM_ASSIGNED', budgetLevel: 'ALL', decisionKind: null }), 'budget_level');
  });

  it('the cross-field rule keeps the bindings honest: a binding names an origin of the pack once, with kinds that are not repeated', () => {
    const base = builtInPackParams('ENTERPRISE');
    expect(refineFundingPack(base)).toBeUndefined();
    const stray = clone(base);
    (stray.origin_decisions as Array<Record<string, unknown>>).push({ origin: 'PM_ASSIGNED', kinds: ['GROUP_DECISION'] });
    expect(refineFundingPack(stray)).toBe('origin_decisions');
    const twice = clone(base);
    (twice.origin_decisions as Array<Record<string, unknown>>).push({ origin: 'GROUP_ASSIGNED', kinds: ['GROUP_DECISION'] });
    expect(refineFundingPack(twice)).toBe('origin_decisions');
    const repeated = clone(base);
    (repeated.origin_decisions as Array<Record<string, unknown>>)[0] = { origin: 'GROUP_ASSIGNED', kinds: ['GROUP_DECISION', 'GROUP_DECISION'] };
    expect(refineFundingPack(repeated)).toBe('origin_decisions');
    expect(() => parseFundingPack('ENTERPRISE', stray)).toThrow(DomainError);
  });

  it('the field is optional in the closed schema: a stored pack from before this field still passes', () => {
    registerAllGovernanceRules();
    const old = clone(builtInPackParams('ENTERPRISE'));
    delete old.origin_decisions;
    expect(() => validateRuleParams('FUNDING_TAXONOMY', old)).not.toThrow();
    expect(parseFundingPack('ENTERPRISE', old).originDecisions.size).toBe(0);
    expect(() => validateRuleParams('FUNDING_TAXONOMY', builtInPackParams('PUBLIC'))).not.toThrow();
  });
});
