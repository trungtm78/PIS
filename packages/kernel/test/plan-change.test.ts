import { planChangeHash, quotaViolations } from '../src/index';
import type { FeatureEntry, PlanChangeFacts } from '../src/index';

const quota = (featureCode: string, limitValue: number | undefined): FeatureEntry => ({
  featureCode,
  limitKind: 'QUOTA',
  ...(limitValue === undefined ? {} : { limitValue }),
  graceBehavior: 'READ_ONLY',
  expiredBehavior: 'DENY',
});

describe('quotaViolations', () => {
  it('lists the seats a tenant of 120 has over a plan of 100 (AC-ST-SAS-008-2)', () => {
    expect(quotaViolations([quota('member.seats', 100)], new Map([['member.seats', 120]]))).toEqual([{ featureCode: 'member.seats', used: '120', newLimit: '100' }]);
  });

  it('lists nothing at the limit or under it', () => {
    expect(quotaViolations([quota('member.seats', 100)], new Map([['member.seats', 100]]))).toEqual([]);
    expect(quotaViolations([quota('member.seats', 100)], new Map([['member.seats', 3]]))).toEqual([]);
  });

  it('judges a quota only when it has a limit and something counts it, and never a switch or a meter', () => {
    const features: FeatureEntry[] = [
      quota('member.seats', undefined),
      quota('unmeasured', 1),
      { featureCode: 'reporting', limitKind: 'BOOLEAN', limitValue: 0, graceBehavior: 'ALLOW', expiredBehavior: 'READ_ONLY' },
      { featureCode: 'ai.analysis', limitKind: 'METERED', limitValue: 5, graceBehavior: 'DENY', expiredBehavior: 'DENY' },
    ];
    expect(quotaViolations(features, new Map([['member.seats', 999], ['reporting', 999], ['ai.analysis', 999]]))).toEqual([]);
  });

  it('lists several in the order of their codes, whatever the order of the plan', () => {
    const features = [quota('zeta', 1), quota('alpha', 1)];
    expect(quotaViolations(features, new Map([['zeta', 2], ['alpha', 3]])).map((entry) => entry.featureCode)).toEqual(['alpha', 'zeta']);
  });
});

describe('planChangeHash', () => {
  const facts: PlanChangeFacts = {
    subscriptionId: 'sub-1',
    subscriptionVersion: 3,
    fromPlanVersionId: 'plan-a',
    targetPlanVersionId: 'plan-b',
    effective: 'NOW',
    today: '2026-02-15',
    periodStart: '2026-01-01',
    periodEnd: '2026-12-31',
    prorationVnd: '320000000',
    effectiveAt: '2026-02-15T00:00:00.000Z',
    violations: [],
    entitlementsHash: 'a'.repeat(64),
  };

  it('is the same for the same facts, whatever the order the members were written in, and a sha-256', () => {
    const shuffled = Object.fromEntries(Object.entries(facts).reverse()) as unknown as PlanChangeFacts;
    expect(planChangeHash(shuffled)).toBe(planChangeHash(facts));
    expect(planChangeHash(facts)).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each([
    ['the subscription changed', { subscriptionVersion: 4 }],
    ['the target plan is another', { targetPlanVersionId: 'plan-c' }],
    ['the day is another (the proration is another)', { today: '2026-02-16' }],
    ['the proration is another', { prorationVnd: '319000000' }],
    ['the effect is another', { effective: 'NEXT_CYCLE' as const }],
    ['the entitlements of the tenant changed (an override)', { entitlementsHash: 'b'.repeat(64) }],
    ['a quota violation appeared', { violations: [{ featureCode: 'member.seats', used: '120', newLimit: '100' }] }],
  ])('differs when %s', (_name, change) => {
    expect(planChangeHash({ ...facts, ...change })).not.toBe(planChangeHash(facts));
  });
});
