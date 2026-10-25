import { ApiError } from '@machvon/api-client';
import { describe, expect, it } from 'vitest';
import { EMPTY_FORM, createBody, describeProblem, formatVnd, isReasonValid, mayChangeNow, toPreview, toTenantSubscription, validateForm } from './model';
import type { SubscriptionForm } from './model';

const valid = (overrides: Partial<SubscriptionForm> = {}): SubscriptionForm => ({ ...EMPTY_FORM, planVersionId: 'plan-1', cycle: 'ANNUAL', billingAnchor: '2026-01-01', ...overrides });

describe('toTenantSubscription', () => {
  const raw = {
    subscription: {
      id: 's1',
      plan_version_id: 'p1',
      cycle: 'ANNUAL',
      billing_anchor: '2026-01-01',
      status: 'Trialing',
      started_at: '2026-01-01T00:00:00Z',
      trial_ends_at: '2026-04-01T00:00:00Z',
      current_period_start: '2026-01-01',
      current_period_end: '2026-12-31',
      cancel_at_period_end: true,
      pending_plan_version_id: 'p2',
      pending_effective_at: '2027-01-01T00:00:00Z',
      procurement_contract_ref: 'HD-1',
      payment_terms: { due_days: 30, method: 'BANK_TRANSFER' },
      version: 3,
    },
    plan: { id: 'p1', plan_code: 'standard', revision: 1, name: 'Standard', base_price_vnd: '365000000' },
    pending_plan: { id: 'p2', plan_code: 'pro', revision: 2, name: 'Pro', base_price_vnd: '730000000' },
    changes: [{ id: 'c1', from_plan_version_id: 'p1', to_plan_version_id: 'p2', effective: 'NEXT_CYCLE', effective_at: '2027-01-01T00:00:00Z', proration_vnd: '0', reason: 'a reason here', requested_at: '2026-02-15T00:00:00Z', superseded_at: '2026-03-01T00:00:00Z' }, { reason: 'no id' }],
  };

  it('reads the subscription, its plans and its changes, and drops a change without an id', () => {
    const view = toTenantSubscription(raw);
    expect(view.subscription).toEqual({
      id: 's1',
      planVersionId: 'p1',
      cycle: 'ANNUAL',
      billingAnchor: '2026-01-01',
      status: 'Trialing',
      trialEndsAt: '2026-04-01T00:00:00Z',
      currentPeriodStart: '2026-01-01',
      currentPeriodEnd: '2026-12-31',
      cancelAtPeriodEnd: true,
      pendingPlanVersionId: 'p2',
      pendingEffectiveAt: '2027-01-01T00:00:00Z',
      procurementContractRef: 'HD-1',
      dueDays: 30,
      method: 'BANK_TRANSFER',
      version: 3,
    });
    expect(view.plan).toEqual({ id: 'p1', planCode: 'standard', revision: 1, name: 'Standard', basePriceVnd: '365000000' });
    expect(view.pendingPlan).toMatchObject({ id: 'p2', basePriceVnd: '730000000' });
    expect(view.changes).toEqual([
      { id: 'c1', fromPlanVersionId: 'p1', toPlanVersionId: 'p2', effective: 'NEXT_CYCLE', effectiveAt: '2027-01-01T00:00:00Z', prorationVnd: '0', reason: 'a reason here', requestedAt: '2026-02-15T00:00:00Z', appliedAt: undefined, supersededAt: '2026-03-01T00:00:00Z' },
    ]);
  });

  it('says there is no subscription when the answer has none, and survives a malformed answer', () => {
    expect(toTenantSubscription({ changes: [] })).toEqual({ subscription: undefined, plan: undefined, pendingPlan: undefined, changes: [] });
    expect(toTenantSubscription(null)).toEqual({ subscription: undefined, plan: undefined, pendingPlan: undefined, changes: [] });
    const odd = toTenantSubscription({ subscription: { id: 's', cycle: 'WEEKLY', status: 'Gone', payment_terms: 'x' }, changes: 'x' });
    expect(odd.subscription).toMatchObject({ cycle: 'ANNUAL', status: 'Active', dueDays: undefined, method: undefined, cancelAtPeriodEnd: false, version: 0 });
    expect(odd.changes).toEqual([]);
  });

  it('reads a change at its own effect, defaulting to the safer one', () => {
    expect(toTenantSubscription({ changes: [{ id: 'c', effective: 'NOW', proration_vnd: '5' }] }).changes[0]).toMatchObject({ effective: 'NOW', prorationVnd: '5' });
    expect(toTenantSubscription({ changes: [{ id: 'c', effective: 'SOON' }] }).changes[0]).toMatchObject({ effective: 'NEXT_CYCLE', prorationVnd: '0' });
  });
});

describe('toPreview', () => {
  it('reads the proration, the token, the day and the violations', () => {
    expect(
      toPreview({ preview_hash: 'h', proration_vnd: '320000000', effective_at: '2026-02-15T00:00:00Z', quota_violations: [{ feature_code: 'member.seats', used: '120', new_limit: '100' }, { used: '1' }] }),
    ).toEqual({ previewHash: 'h', prorationVnd: '320000000', effectiveAt: '2026-02-15T00:00:00Z', violations: [{ featureCode: 'member.seats', used: '120', newLimit: '100' }] });
  });

  it('survives a malformed answer', () => {
    expect(toPreview(null)).toEqual({ previewHash: '', prorationVnd: '0', effectiveAt: '', violations: [] });
    expect(toPreview({ quota_violations: 'x' }).violations).toEqual([]);
  });
});

describe('formatVnd and mayChangeNow', () => {
  it('groups whole VND exactly and shows anything else as it came', () => {
    expect(formatVnd('320000000', 'en')).toBe('320,000,000');
    expect(formatVnd('123456789012345678901234', 'en')).toBe('123,456,789,012,345,678,901,234');
    expect(formatVnd('x', 'en')).toBe('x');
  });

  it('allows a change now only to a plan that costs more', () => {
    expect(mayChangeNow('365000000', '730000000')).toBe(true);
    expect(mayChangeNow('730000000', '365000000')).toBe(false);
    expect(mayChangeNow('100', '100')).toBe(false);
    expect(mayChangeNow('0', '1')).toBe(true);
    expect(mayChangeNow('9'.repeat(24), '9'.repeat(23))).toBe(false);
    expect(mayChangeNow('x', '1')).toBe(false);
    expect(mayChangeNow('1', '')).toBe(false);
  });
});

describe('validateForm', () => {
  it('accepts a plan, a cycle and a start date with the defaults', () => {
    expect(validateForm(valid())).toEqual({});
  });

  it('asks for the plan, the cycle and the start date', () => {
    expect(validateForm(EMPTY_FORM)).toEqual({ planVersionId: 'required', cycle: 'required', billingAnchor: 'required' });
  });

  it.each(['2026-02-30', '2026-13-01', '1/1/2026', 'tomorrow'])('refuses the start date %p', (billingAnchor) => {
    expect(validateForm(valid({ billingAnchor })).billingAnchor).toBe('notDate');
  });

  it.each([
    ['0', undefined],
    ['90', undefined],
    ['91', 'outOfRange'],
    ['-1', 'notWhole'],
    ['1.5', 'notWhole'],
    ['', 'notWhole'],
    ['12345', 'notWhole'],
  ] as const)('judges %p trial days as %s', (trialDays, expected) => {
    expect(validateForm(valid({ trialDays })).trialDays).toBe(expected);
  });

  it.each([
    ['0', undefined],
    ['180', undefined],
    ['181', 'outOfRange'],
    ['abc', 'notWhole'],
  ] as const)('judges %p due days as %s', (dueDays, expected) => {
    expect(validateForm(valid({ dueDays })).dueDays).toBe(expected);
  });

  it('refuses a contract reference that is too long', () => {
    expect(validateForm(valid({ contractRef: 'x'.repeat(201) })).contractRef).toBe('tooLong');
    expect(validateForm(valid({ contractRef: 'x'.repeat(200) })).contractRef).toBeUndefined();
  });
});

describe('createBody', () => {
  it('writes the contract body, with the trial and the contract only when there are some', () => {
    expect(createBody(valid())).toEqual({ plan_version_id: 'plan-1', cycle: 'ANNUAL', billing_anchor: '2026-01-01', payment_terms: { due_days: 30, method: 'BANK_TRANSFER' } });
    expect(createBody(valid({ trialDays: '30', contractRef: ' HD-2026/001 ', dueDays: '15', method: 'TREASURY_TRANSFER' }))).toEqual({
      plan_version_id: 'plan-1',
      cycle: 'ANNUAL',
      billing_anchor: '2026-01-01',
      trial_days: 30,
      procurement_contract_ref: 'HD-2026/001',
      payment_terms: { due_days: 15, method: 'TREASURY_TRANSFER' },
    });
  });
});

describe('isReasonValid', () => {
  it('needs 10 to 2000 characters once trimmed', () => {
    expect(isReasonValid('short')).toBe(false);
    expect(isReasonValid(`  ${'x'.repeat(9)}  `)).toBe(false);
    expect(isReasonValid('x'.repeat(10))).toBe(true);
    expect(isReasonValid('x'.repeat(2000))).toBe(true);
    expect(isReasonValid('x'.repeat(2001))).toBe(false);
  });
});

describe('describeProblem', () => {
  const error = (code: string, detail?: string) => new ApiError({ status: 409, code, correlationId: 'c', ...(detail === undefined ? {} : { detail }), extensions: {} });

  it('maps the codes of the subscription commands to a reason, keeping the field', () => {
    const reasons: Array<[string, string]> = [
      ['SUBSCRIPTION_EXISTS', 'exists'],
      ['PLAN_NOT_PUBLISHED', 'notPublished'],
      ['PREVIEW_STALE', 'stale'],
      ['VERSION_CONFLICT', 'conflict'],
      ['SUBSCRIPTION_STATE_INVALID', 'stateInvalid'],
      ['TENANT_STATE_INVALID', 'tenantState'],
      ['VALIDATION_FAILED', 'invalid'],
      ['INVALID_REQUEST', 'invalid'],
      ['FIELD_NOT_ALLOWED', 'invalid'],
      ['SCOPE_DENIED', 'denied'],
      ['ENTITLEMENT_DENIED', 'denied'],
      ['RESOURCE_NOT_FOUND', 'notFound'],
      ['SESSION_EXPIRED', 'session'],
      ['SOMETHING_ELSE', 'general'],
    ];
    for (const [code, reason] of reasons) expect(describeProblem(error(code)).reason).toBe(reason);
    expect(describeProblem(error('VALIDATION_FAILED', 'cycle'))).toEqual({ reason: 'invalid', field: 'cycle' });
  });

  it('calls an error that is not an API error general', () => {
    expect(describeProblem(new Error('x'))).toEqual({ reason: 'general', field: undefined });
  });
});
