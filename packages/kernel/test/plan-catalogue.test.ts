import { PLAN_FEATURE_CODES, STANDARD_FEATURES, planDraftIssues } from '../src/index';
import type { PlanDraft, PlanFeatureDraft } from '../src/index';

const feature = (overrides: Partial<PlanFeatureDraft> = {}): PlanFeatureDraft => ({
  featureCode: 'reporting',
  limitKind: 'BOOLEAN',
  graceBehavior: 'ALLOW',
  expiredBehavior: 'READ_ONLY',
  ...overrides,
});

const draft = (overrides: Partial<PlanDraft> = {}): PlanDraft => ({
  planCode: 'standard',
  name: 'sas.plan.standard.name',
  billingCycles: ['ANNUAL'],
  basePriceVnd: '0',
  vatCategory: 'NOT_SUBJECT',
  legalTermsRef: 'TERMS-STANDARD-2',
  features: [feature()],
  ...overrides,
});

const issuesOf = (plan: PlanDraft): string[] => planDraftIssues(plan).map((issue) => `${issue.field}:${issue.reason}`);

describe('planDraftIssues', () => {
  it('accepts a plan with one boolean feature', () => {
    expect(planDraftIssues(draft())).toEqual([]);
  });

  it('accepts the STANDARD defaults of the entitlement rules and the seat quota', () => {
    const features = [
      ...STANDARD_FEATURES.map((entry): PlanFeatureDraft => ({
        featureCode: entry.featureCode,
        limitKind: entry.limitKind,
        ...(entry.limitValue === undefined ? {} : { limitValue: String(entry.limitValue) }),
        graceBehavior: entry.graceBehavior,
        expiredBehavior: entry.expiredBehavior,
      })),
      feature({ featureCode: 'member.seats', limitKind: 'QUOTA', limitValue: '50', graceBehavior: 'READ_ONLY', expiredBehavior: 'DENY' }),
    ];
    expect(planDraftIssues(draft({ features }))).toEqual([]);
  });

  it('knows exactly the features that something enforces', () => {
    expect([...PLAN_FEATURE_CODES].sort()).toEqual(['ai.analysis', 'export', 'member.invite', 'member.seats', 'notification.campaign', 'reporting']);
  });

  it('asks for a name, a billing cycle, terms and a feature', () => {
    expect(issuesOf(draft({ name: '  ', billingCycles: [], legalTermsRef: '', features: [] }))).toEqual([
      'name:REQUIRED',
      'billing_cycles:REQUIRED',
      'legal_terms_ref:REQUIRED',
      'features:REQUIRED',
    ]);
  });

  it('refuses text that is too long, a repeated billing cycle and too many features', () => {
    const many = Array.from({ length: 101 }, () => feature());
    expect(issuesOf(draft({ name: 'x'.repeat(201), legalTermsRef: 'y'.repeat(201), billingCycles: ['ANNUAL', 'ANNUAL'], features: many }))).toEqual(
      expect.arrayContaining(['name:TOO_LONG', 'legal_terms_ref:TOO_LONG', 'billing_cycles:DUPLICATE', 'features:TOO_LONG']),
    );
  });

  it.each(['-1', '1.5', '', 'abc', '1'.repeat(25)])('refuses the price %p', (basePriceVnd) => {
    expect(issuesOf(draft({ basePriceVnd }))).toEqual(['base_price_vnd:PRICE_INVALID']);
  });

  it('accepts a price of 24 digits', () => {
    expect(planDraftIssues(draft({ basePriceVnd: '9'.repeat(24) }))).toEqual([]);
  });

  it('refuses a feature nothing enforces and a feature named twice', () => {
    expect(issuesOf(draft({ features: [feature({ featureCode: 'ai.magic' }), feature(), feature()] }))).toEqual(['features[0].feature_code:FEATURE_UNKNOWN', 'features[2].feature_code:DUPLICATE']);
  });

  it('judges a boolean: its limit is 0 or 1 and it has no meter', () => {
    expect(planDraftIssues(draft({ features: [feature({ limitValue: '0' })] }))).toEqual([]);
    expect(planDraftIssues(draft({ features: [feature({ limitValue: '1' })] }))).toEqual([]);
    expect(issuesOf(draft({ features: [feature({ limitValue: '2' })] }))).toEqual(['features[0].limit_value:LIMIT_INVALID']);
    expect(issuesOf(draft({ features: [feature({ meter: 'seats' })] }))).toEqual(['features[0].meter:METER_NOT_ALLOWED']);
  });

  it('judges a quota: it needs a limit and has no meter', () => {
    const quota = feature({ featureCode: 'member.seats', limitKind: 'QUOTA', graceBehavior: 'READ_ONLY', expiredBehavior: 'DENY' });
    expect(issuesOf(draft({ features: [quota] }))).toEqual(['features[0].limit_value:LIMIT_REQUIRED']);
    expect(planDraftIssues(draft({ features: [{ ...quota, limitValue: '12.5' }] }))).toEqual([]);
    expect(issuesOf(draft({ features: [{ ...quota, limitValue: '5', meter: 'seats' }] }))).toEqual(['features[0].meter:METER_NOT_ALLOWED']);
  });

  it('judges a metered feature: it needs a well formed meter and may have a cap', () => {
    const metered = feature({ featureCode: 'ai.analysis', limitKind: 'METERED', graceBehavior: 'DENY', expiredBehavior: 'DENY' });
    expect(issuesOf(draft({ features: [metered] }))).toEqual(['features[0].meter:METER_REQUIRED']);
    expect(issuesOf(draft({ features: [{ ...metered, meter: '  ' }] }))).toEqual(['features[0].meter:METER_REQUIRED']);
    expect(issuesOf(draft({ features: [{ ...metered, meter: 'AI Tokens' }] }))).toEqual(['features[0].meter:METER_INVALID']);
    expect(planDraftIssues(draft({ features: [{ ...metered, meter: 'ai.tokens' }] }))).toEqual([]);
    expect(planDraftIssues(draft({ features: [{ ...metered, meter: 'ai.tokens', limitValue: '100000' }] }))).toEqual([]);
  });

  it.each(['-1', '1e3', '1.1234567', '', '12a'])('refuses the limit %p', (limitValue) => {
    expect(issuesOf(draft({ features: [feature({ featureCode: 'member.seats', limitKind: 'QUOTA', limitValue, graceBehavior: 'READ_ONLY', expiredBehavior: 'DENY' })] }))).toEqual(['features[0].limit_value:LIMIT_INVALID']);
  });

  it.each([
    ['DENY', 'READ_ONLY'],
    ['DENY', 'EXPORT_ONLY'],
    ['READ_ONLY', 'READ_ONLY'],
  ] as const)('the behaviour after the end (%s in grace) is never wider than in grace: %s', (graceBehavior, expiredBehavior) => {
    const reasons = issuesOf(draft({ features: [feature({ graceBehavior, expiredBehavior })] }));
    expect(reasons).toEqual(graceBehavior === 'READ_ONLY' && expiredBehavior === 'READ_ONLY' ? [] : ['features[0].expired_behavior:EXPIRED_WIDER_THAN_GRACE']);
  });

  it('lets READ_ONLY in grace keep exports after the end, and ALLOW in grace anything', () => {
    expect(planDraftIssues(draft({ features: [feature({ graceBehavior: 'READ_ONLY', expiredBehavior: 'EXPORT_ONLY' })] }))).toEqual([]);
    expect(planDraftIssues(draft({ features: [feature({ graceBehavior: 'ALLOW', expiredBehavior: 'READ_ONLY' })] }))).toEqual([]);
  });

  it('reports every problem of every feature in one pass, in the order of the form', () => {
    const issues = issuesOf(
      draft({
        basePriceVnd: 'x',
        features: [feature({ featureCode: 'nope', limitValue: '7', meter: 'a' }), feature({ featureCode: 'export', limitKind: 'QUOTA', graceBehavior: 'DENY', expiredBehavior: 'EXPORT_ONLY' })],
      }),
    );
    expect(issues).toEqual([
      'base_price_vnd:PRICE_INVALID',
      'features[0].feature_code:FEATURE_UNKNOWN',
      'features[0].limit_value:LIMIT_INVALID',
      'features[0].meter:METER_NOT_ALLOWED',
      'features[1].limit_value:LIMIT_REQUIRED',
      'features[1].expired_behavior:EXPIRED_WIDER_THAN_GRACE',
    ]);
  });
});
