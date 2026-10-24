import { ApiError } from '@machvon/api-client';
import { describe, expect, it } from 'vitest';
import { EMPTY_FORM, createBody, describeProblem, emptyFeature, formOfRevision, formatPrice, hasProblems, isReasonValid, toPlan, validateForm } from './model';
import type { FeatureForm, PlanForm } from './model';

const valid = (overrides: Partial<PlanForm> = {}): PlanForm => ({ ...EMPTY_FORM, planCode: 'pro-2027', name: 'Pro', legalTermsRef: 'TERMS-1', ...overrides });
const feature = (overrides: Partial<FeatureForm> = {}): FeatureForm => ({ ...emptyFeature(0), ...overrides });

describe('toPlan', () => {
  const raw = {
    id: 'a',
    plan_code: 'standard',
    revision: 3,
    name: 'Standard',
    status: 'Published',
    billing_cycles: ['ANNUAL', 'WEEKLY'],
    base_price_vnd: '100',
    vat_category: 'VAT_8',
    legal_terms_ref: 'T',
    published_at: '2026-01-01T00:00:00Z',
    version: 2,
    features: [{ feature_code: 'member.seats', limit_kind: 'QUOTA', limit_value: '50', grace_behavior: 'READ_ONLY', expired_behavior: 'DENY' }],
  };

  it('reads a plan version and drops what it does not know', () => {
    expect(toPlan(raw)).toEqual({
      id: 'a',
      planCode: 'standard',
      revision: 3,
      name: 'Standard',
      status: 'Published',
      billingCycles: ['ANNUAL'],
      basePriceVnd: '100',
      vatCategory: 'VAT_8',
      legalTermsRef: 'T',
      publishedAt: '2026-01-01T00:00:00Z',
      version: 2,
      features: [{ featureCode: 'member.seats', limitKind: 'QUOTA', limitValue: '50', meter: null, graceBehavior: 'READ_ONLY', expiredBehavior: 'DENY' }],
    });
  });

  it('falls back to the safest values for a malformed row and refuses a row without an id', () => {
    expect(toPlan({ id: 'b', status: 'x', vat_category: 'y', features: [{ limit_kind: 'z', grace_behavior: 'q', expired_behavior: 'r' }] })).toMatchObject({
      status: 'Draft',
      vatCategory: 'NOT_SUBJECT',
      billingCycles: [],
      version: 0,
      publishedAt: null,
      features: [{ limitKind: 'BOOLEAN', graceBehavior: 'DENY', expiredBehavior: 'DENY' }],
    });
    expect(toPlan({ plan_code: 'x' })).toBeUndefined();
    expect(toPlan(null)).toBeUndefined();
    expect(toPlan({ id: 'c', features: 'no', billing_cycles: 'no' })).toMatchObject({ features: [], billingCycles: [] });
  });
});

describe('formatPrice', () => {
  it('groups whole VND exactly, whatever the size', () => {
    expect(formatPrice('1500000', 'en')).toBe('1,500,000');
    expect(formatPrice('123456789012345678901234', 'en')).toBe('123,456,789,012,345,678,901,234');
    expect(formatPrice('0', 'en')).toBe('0');
  });

  it('shows what is not an amount as it came', () => {
    expect(formatPrice('abc', 'en')).toBe('abc');
    expect(formatPrice('', 'en')).toBe('');
  });
});

describe('validateForm', () => {
  it('accepts the starting form once it has a code, a name and terms', () => {
    expect(hasProblems(validateForm(valid()))).toBe(false);
  });

  it('asks for the code, the name and the terms', () => {
    expect(validateForm(EMPTY_FORM).fields).toEqual({ planCode: 'required', name: 'required', legalTermsRef: 'required' });
  });

  it.each(['ab', 'Upper', 'under_score', 'x'.repeat(41), 'has space'])('refuses the plan code %p', (planCode) => {
    expect(validateForm(valid({ planCode })).fields.planCode).toBe('format');
  });

  it('accepts a code of 3 to 40 lower-case letters, digits and hyphens', () => {
    for (const planCode of ['abc', 'a-1', 'x'.repeat(40)]) expect(validateForm(valid({ planCode })).fields.planCode).toBeUndefined();
  });

  it('refuses a name or terms that are too long', () => {
    const fields = validateForm(valid({ name: 'n'.repeat(201), legalTermsRef: 't'.repeat(201) })).fields;
    expect([fields.name, fields.legalTermsRef]).toEqual(['tooLong', 'tooLong']);
  });

  it.each([['', 'required'], ['  ', 'required'], ['-1', 'notAmount'], ['1.5', 'notAmount'], ['1e3', 'notAmount'], ['1'.repeat(25), 'notAmount']])('judges the price %p as %s', (basePriceVnd, expected) => {
    expect(validateForm(valid({ basePriceVnd })).fields.basePriceVnd).toBe(expected);
  });

  it('needs a billing cycle and a feature', () => {
    expect(validateForm(valid({ billingCycles: [], features: [] })).fields).toEqual({ billingCycles: 'required', features: 'required' });
  });

  it('judges a boolean: 0 or 1 or nothing, and no meter', () => {
    expect(validateForm(valid({ features: [feature({ limitValue: '0' })] })).features.size).toBe(0);
    expect(validateForm(valid({ features: [feature({ limitValue: '1' })] })).features.size).toBe(0);
    expect(validateForm(valid({ features: [feature({ limitValue: '2' })] })).features.get(0)).toEqual({ limitValue: 'limitInvalid' });
    expect(validateForm(valid({ features: [feature({ meter: 'x' })] })).features.get(0)).toEqual({ meter: 'meterNotAllowed' });
  });

  it('judges a quota: a limit of at most six decimals', () => {
    const quota = (limitValue: string): FeatureForm => feature({ featureCode: 'member.seats', limitKind: 'QUOTA', limitValue, graceBehavior: 'READ_ONLY', expiredBehavior: 'DENY' });
    expect(validateForm(valid({ features: [quota('')] })).features.get(0)).toEqual({ limitValue: 'limitRequired' });
    for (const bad of ['-1', '1.1234567', 'abc', '1e3']) expect(validateForm(valid({ features: [quota(bad)] })).features.get(0)).toEqual({ limitValue: 'limitInvalid' });
    expect(validateForm(valid({ features: [quota('12.5')] })).features.size).toBe(0);
  });

  it('judges a metered feature: a meter of lower-case letters, digits, dots and underscores, and an optional cap', () => {
    const metered = (meter: string, limitValue = ''): FeatureForm => feature({ featureCode: 'ai.analysis', limitKind: 'METERED', meter, limitValue, graceBehavior: 'DENY', expiredBehavior: 'DENY' });
    expect(validateForm(valid({ features: [metered('')] })).features.get(0)).toEqual({ meter: 'meterRequired' });
    expect(validateForm(valid({ features: [metered('AI Tokens')] })).features.get(0)).toEqual({ meter: 'meterInvalid' });
    expect(validateForm(valid({ features: [metered('ai.tokens', '1000')] })).features.size).toBe(0);
  });

  it('names a feature that appears twice on the second row, and the end that gives more than the grace', () => {
    const problems = validateForm(valid({ features: [feature({ key: 0 }), feature({ key: 1, graceBehavior: 'DENY', expiredBehavior: 'READ_ONLY' })] }));
    expect(problems.features.get(1)).toEqual({ featureCode: 'duplicate', expiredBehavior: 'expiredWider' });
    expect(problems.features.get(0)).toBeUndefined();
  });

  it.each([
    ['ALLOW', 'READ_ONLY', false],
    ['ALLOW', 'EXPORT_ONLY', false],
    ['READ_ONLY', 'READ_ONLY', false],
    ['READ_ONLY', 'EXPORT_ONLY', false],
    ['READ_ONLY', 'DENY', false],
    ['DENY', 'DENY', false],
    ['DENY', 'EXPORT_ONLY', true],
    ['DENY', 'READ_ONLY', true],
  ] as const)('grace %s then %s after the end is wider than the grace: %s', (graceBehavior, expiredBehavior, wider) => {
    expect(validateForm(valid({ features: [feature({ graceBehavior, expiredBehavior })] })).features.has(0)).toBe(wider);
  });
});

describe('createBody', () => {
  it('writes the contract body with the cycles in the order of the contract and without empty members', () => {
    const body = createBody(
      valid({
        planCode: ' pro-2027 ',
        name: ' Pro ',
        billingCycles: ['ANNUAL', 'MONTHLY'],
        basePriceVnd: ' 100 ',
        vatCategory: 'VAT_5',
        features: [
          feature({ key: 0, featureCode: 'member.seats', limitKind: 'QUOTA', limitValue: ' 25 ', graceBehavior: 'READ_ONLY', expiredBehavior: 'DENY' }),
          feature({ key: 1, featureCode: 'ai.analysis', limitKind: 'METERED', meter: ' ai.tokens ', graceBehavior: 'DENY', expiredBehavior: 'DENY' }),
          feature({ key: 2, featureCode: 'export', meter: 'ignored' }),
        ],
      }),
    );
    expect(body).toEqual({
      plan_code: 'pro-2027',
      name: 'Pro',
      billing_cycles: ['MONTHLY', 'ANNUAL'],
      base_price_vnd: '100',
      vat_category: 'VAT_5',
      legal_terms_ref: 'TERMS-1',
      features: [
        { feature_code: 'member.seats', limit_kind: 'QUOTA', limit_value: '25', grace_behavior: 'READ_ONLY', expired_behavior: 'DENY' },
        { feature_code: 'ai.analysis', limit_kind: 'METERED', meter: 'ai.tokens', grace_behavior: 'DENY', expired_behavior: 'DENY' },
        { feature_code: 'export', limit_kind: 'BOOLEAN', grace_behavior: 'ALLOW', expired_behavior: 'READ_ONLY' },
      ],
    });
  });
});

describe('formOfRevision', () => {
  it('copies a plan into a form for its next revision', () => {
    const plan = toPlan({
      id: 'a',
      plan_code: 'standard',
      revision: 2,
      name: 'Standard',
      status: 'Published',
      billing_cycles: ['MONTHLY'],
      base_price_vnd: '10',
      vat_category: 'VAT_10',
      legal_terms_ref: 'T',
      version: 2,
      features: [
        { feature_code: 'member.seats', limit_kind: 'QUOTA', limit_value: '50', grace_behavior: 'READ_ONLY', expired_behavior: 'DENY' },
        { feature_code: 'ai.analysis', limit_kind: 'METERED', meter: 'ai.tokens', grace_behavior: 'DENY', expired_behavior: 'DENY' },
      ],
    });
    if (plan === undefined) throw new Error('plan');
    const form = formOfRevision(plan);
    expect(form).toMatchObject({ planCode: 'standard', name: 'Standard', billingCycles: ['MONTHLY'], basePriceVnd: '10', vatCategory: 'VAT_10', legalTermsRef: 'T' });
    expect(form.features.map((entry) => [entry.key, entry.featureCode, entry.limitValue, entry.meter])).toEqual([
      [0, 'member.seats', '50', ''],
      [1, 'ai.analysis', '', 'ai.tokens'],
    ]);
    expect(hasProblems(validateForm(form))).toBe(false);
  });
});

describe('isReasonValid', () => {
  it('needs 10 to 2000 characters once trimmed', () => {
    expect(isReasonValid('short')).toBe(false);
    expect(isReasonValid(`   ${'x'.repeat(9)}   `)).toBe(false);
    expect(isReasonValid('x'.repeat(10))).toBe(true);
    expect(isReasonValid('x'.repeat(2000))).toBe(true);
    expect(isReasonValid('x'.repeat(2001))).toBe(false);
  });
});

describe('describeProblem', () => {
  const error = (code: string, detail?: string, extensions: Record<string, unknown> = {}) => new ApiError({ status: 422, code, correlationId: 'c', ...(detail === undefined ? {} : { detail }), extensions });

  it('maps the codes of the plan commands to a reason, keeping the field and the reason the server named', () => {
    expect(describeProblem(error('PLAN_INVALID', 'features[1].meter', { reason: 'METER_REQUIRED' }))).toEqual({ reason: 'planInvalid', field: 'features[1].meter', serverReason: 'METER_REQUIRED' });
    expect(describeProblem(error('PLAN_VERSION_IMMUTABLE')).reason).toBe('immutable');
    expect(describeProblem(error('VERSION_CONFLICT')).reason).toBe('conflict');
    for (const code of ['VALIDATION_FAILED', 'INVALID_REQUEST', 'FIELD_NOT_ALLOWED']) expect(describeProblem(error(code)).reason).toBe('invalid');
    for (const code of ['SCOPE_DENIED', 'ENTITLEMENT_DENIED']) expect(describeProblem(error(code)).reason).toBe('denied');
    expect(describeProblem(error('RESOURCE_NOT_FOUND')).reason).toBe('notFound');
    expect(describeProblem(error('SESSION_EXPIRED')).reason).toBe('session');
  });

  it('calls anything else general, also an error that is not an API error', () => {
    expect(describeProblem(error('SOMETHING')).reason).toBe('general');
    expect(describeProblem(new Error('x'))).toEqual({ reason: 'general', field: undefined, serverReason: undefined });
    expect(describeProblem(error('PLAN_INVALID', undefined, { reason: 7 })).serverReason).toBeUndefined();
  });
});
