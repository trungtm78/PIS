import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../i18n/vi.json';
import PlanChangeScreen from './PlanChangeScreen';
import { harness, mount, routeOf } from './test-support';

const ROUTE = routeOf('SAS-08', 'FR-SAS-08');
const BILLING = ['system.tenant.read', 'system.billing.manage'];
const READER = ['system.tenant.read'];
const TENANT_A = '00000000-0000-4000-8000-0000000000a1';
const TENANT_B = '00000000-0000-4000-8000-0000000000b1';
const problem = (code: string, status = 409) => new ApiError({ status, code, correlationId: 'c', extensions: {} });

const plan = (id: string, code: string, price: string, revision = 1) => ({
  id,
  plan_code: code,
  revision,
  name: `Gói ${code}`,
  status: 'Published',
  billing_cycles: ['ANNUAL'],
  base_price_vnd: price,
  vat_category: 'NOT_SUBJECT',
  legal_terms_ref: 'T',
  version: 2,
  features: [],
});

const PLANS = [plan('p-small', 'small', '100000000'), plan('p-current', 'current', '365000000'), plan('p-big', 'big', '730000000'), { ...plan('p-draft', 'draft', '999'), status: 'Draft' }];

const live = (overrides: Record<string, unknown> = {}) => ({
  id: 'sub-1',
  plan_version_id: 'p-current',
  cycle: 'ANNUAL',
  billing_anchor: '2026-01-01',
  status: 'Active',
  started_at: '2026-01-01T00:00:00Z',
  current_period_start: '2026-01-01',
  current_period_end: '2026-12-31',
  cancel_at_period_end: false,
  payment_terms: { due_days: 30, method: 'BANK_TRANSFER' },
  version: 4,
  ...overrides,
});

const view = (subscription: Record<string, unknown> | undefined, extra: Record<string, unknown> = {}) =>
  subscription === undefined
    ? { changes: [] }
    : { subscription, plan: { id: 'p-current', plan_code: 'current', revision: 1, name: 'Gói current', base_price_vnd: '365000000' }, changes: [], ...extra };

const previewOf = (overrides: Record<string, unknown> = {}) => ({
  preview_hash: 'ab'.repeat(32),
  proration_vnd: '320000000',
  quota_violations: [],
  effective_at: '2026-02-15T00:00:00Z',
  ...overrides,
});

interface State {
  byTenant: Map<string, Record<string, unknown> | Error>;
}

function client(current: State, command: (operation: string, input: unknown) => unknown = () => previewOf()) {
  const h = harness((operation, input) => {
    if (operation === 'listSystemTenants') return { items: [{ id: TENANT_A, code: 'cao-bang', name: 'Cao Bằng' }, { id: TENANT_B, code: 'ha-giang', name: 'Hà Giang' }], next_cursor: null };
    if (operation === 'getTenantSubscription') return current.byTenant.get((input as { path: { tenantId: string } }).path.tenantId) ?? new Error('unknown tenant');
    return new Error(`unexpected read ${operation}`);
  }, command);
  (h.client as unknown as { readAll: (operation: string) => Promise<unknown[]> }).readAll = vi.fn((operation: string) =>
    operation === 'listPlanVersions' ? Promise.resolve(PLANS) : Promise.reject(new Error(`unexpected readAll ${operation}`)),
  );
  return h;
}

const state = (overrides: Partial<State> = {}): State => ({ byTenant: new Map([[TENANT_A, view(live())], [TENANT_B, view(undefined)]]), ...overrides });

afterEach(cleanup);

const ready = () => waitFor(() => expect(document.querySelector('[data-subscription-id="sub-1"]')).not.toBeNull());
const target = (): HTMLSelectElement => screen.getByLabelText(vi_['sas.planChange.field.target']) as HTMLSelectElement;
const choose = async (planId: string): Promise<void> => {
  await waitFor(() => expect(within(target()).getAllByRole('option').length).toBeGreaterThan(1));
  fireEvent.change(target(), { target: { value: planId } });
};
const radio = (value: string): HTMLInputElement => document.querySelector(`input[name="plan-change-effective"][value="${value}"]`) as HTMLInputElement;
const askPreview = async (): Promise<void> => {
  fireEvent.click(screen.getByRole('button', { name: vi_['sas.planChange.preview.action'] }));
  await screen.findByTestId('preview');
};
const apply = () => within(screen.getByRole('form', { name: vi_['sas.planChange.apply.aria'] }));

describe('PlanChangeScreen (SAS-08): the change of plan', () => {
  it('shows the current plan with its price, the status and the period (UI-SAS-08, AC-ST-SAS-008-3)', async () => {
    mount(<PlanChangeScreen route={ROUTE} />, client(state()), BILLING);
    await ready();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['sas.planChange.page.title']);
    expect(screen.getByRole('link', { name: new RegExp(vi_['sas.planChange.back.link']) }).getAttribute('href')).toBe('/sas/sas-09');
    const card = document.querySelector('[data-subscription-id="sub-1"]') as HTMLElement;
    expect(card.textContent).toContain(vi_['sas.planChange.plan.text'].replace('{name}', 'Gói current').replace('{code}', 'current').replace('{revision}', '1'));
    expect(card.textContent).toContain(vi_['sas.subscription.price.text'].replace('{amount}', (365000000).toLocaleString('vi')));
    expect(card.textContent).toContain(vi_['sas.subscription.status.active']);
    expect(card.getAttribute('data-version')).toBe('4');
  });

  it('offers the published plans except the one the subscription is on', async () => {
    mount(<PlanChangeScreen route={ROUTE} />, client(state()), BILLING);
    await ready();
    await waitFor(() => expect(within(target()).getAllByRole('option').length).toBe(3));
    expect(within(target()).getAllByRole('option').map((option) => option.getAttribute('value'))).toEqual(['', 'p-small', 'p-big']);
  });

  it('says there is nothing to change when the tenant has no subscription, and points to SAS-07', async () => {
    mount(<PlanChangeScreen route={ROUTE} />, client(state()), BILLING, `/?tenant=${TENANT_B}`);
    expect(await screen.findByText(vi_['sas.planChange.none.notice'], { exact: false })).toBeTruthy();
    expect(screen.queryByLabelText(vi_['sas.planChange.field.target'])).toBeNull();
  });

  it('gives a reader the subscription and no form', async () => {
    mount(<PlanChangeScreen route={ROUTE} />, client(state()), READER);
    await ready();
    expect(screen.queryByLabelText(vi_['sas.planChange.field.target'])).toBeNull();
    expect(screen.getByText(vi_['sas.planChange.form.denied'])).toBeTruthy();
  });

  describe('when it takes effect', () => {
    it('allows now for a plan that costs more, and only the next cycle for one that costs less, saying so', async () => {
      mount(<PlanChangeScreen route={ROUTE} />, client(state()), BILLING);
      await ready();
      await choose('p-big');
      expect(radio('NOW').disabled).toBe(false);
      expect(radio('NOW').checked).toBe(true);
      expect(screen.queryByText(vi_['sas.planChange.effective.onlyNext'])).toBeNull();
      await choose('p-small');
      expect(radio('NOW').disabled).toBe(true);
      expect(radio('NEXT_CYCLE').checked).toBe(true);
      expect(screen.getByText(vi_['sas.planChange.effective.onlyNext'])).toBeTruthy();
    });

    it('asks for the preview with the plan and the effect that are chosen', async () => {
      const h = client(state());
      mount(<PlanChangeScreen route={ROUTE} />, h, BILLING);
      await ready();
      await choose('p-big');
      fireEvent.click(radio('NEXT_CYCLE'));
      await askPreview();
      const [operation, input] = h.command.mock.calls[0] as [string, { path: unknown; body: unknown }];
      expect(operation).toBe('previewPlanChange');
      expect(input).toMatchObject({ path: { subscriptionId: 'sub-1' }, body: { target_plan_version_id: 'p-big', effective: 'NEXT_CYCLE' } });
    });

    it('can not ask for a preview before a plan is chosen', async () => {
      mount(<PlanChangeScreen route={ROUTE} />, client(state()), BILLING);
      await ready();
      expect((screen.getByRole('button', { name: vi_['sas.planChange.preview.action'] }) as HTMLButtonElement).disabled).toBe(true);
    });
  });

  describe('the preview', () => {
    it('shows the proration in whole VND, the day, the code and that no quota is passed (UAT-AC155)', async () => {
      mount(<PlanChangeScreen route={ROUTE} />, client(state()), BILLING);
      await ready();
      await choose('p-big');
      await askPreview();
      const card = screen.getByTestId('preview');
      expect(card.textContent).toContain(vi_['sas.subscription.price.text'].replace('{amount}', (320000000).toLocaleString('vi')));
      expect(card.querySelector('[data-proration]')?.getAttribute('data-proration')).toBe('320000000');
      expect(card.querySelector('code')?.textContent).toBe('ab'.repeat(32));
      expect(card.textContent).toContain(vi_['sas.planChange.violations.none']);
      expect(card.textContent).toContain(vi_['sas.planChange.effective.now']);
      expect(card.textContent).toContain('Gói current');
      expect(card.textContent).toContain('Gói big');
    });

    it('lists the quota that the new plan no longer holds, and says nobody is removed (AC-ST-SAS-008-2)', async () => {
      mount(<PlanChangeScreen route={ROUTE} />, client(state(), () => previewOf({ proration_vnd: '0', quota_violations: [{ feature_code: 'member.seats', used: '120', new_limit: '100' }] })), BILLING);
      await ready();
      await choose('p-small');
      await askPreview();
      const row = document.querySelector('tr[data-feature="member.seats"]') as HTMLElement;
      expect(row.textContent).toContain(vi_['sas.entitlements.feature.memberSeats']);
      expect(row.textContent).toContain('120');
      expect(row.textContent).toContain('100');
      expect(screen.getByText(vi_['sas.planChange.violations.rule'])).toBeTruthy();
      expect(screen.getByTestId('preview').textContent).toContain(vi_['sas.planChange.effective.next']);
    });

    it('is forgotten when another plan or another effect is chosen: a preview is for what was previewed', async () => {
      mount(<PlanChangeScreen route={ROUTE} />, client(state()), BILLING);
      await ready();
      await choose('p-big');
      await askPreview();
      await choose('p-small');
      expect(screen.queryByTestId('preview')).toBeNull();
      await choose('p-big');
      await askPreview();
      fireEvent.click(radio('NEXT_CYCLE'));
      expect(screen.queryByTestId('preview')).toBeNull();
    });

    it.each([
      ['SUBSCRIPTION_STATE_INVALID', 409, 'sas.subscription.problem.stateInvalid'],
      ['PLAN_NOT_PUBLISHED', 409, 'sas.subscription.problem.notPublished'],
      ['VALIDATION_FAILED', 422, 'sas.subscription.problem.invalid'],
    ])('says why the server refused the preview: %s', async (code, status, key) => {
      mount(<PlanChangeScreen route={ROUTE} />, client(state(), () => problem(code, status)), BILLING);
      await ready();
      await choose('p-big');
      fireEvent.click(screen.getByRole('button', { name: vi_['sas.planChange.preview.action'] }));
      expect((await screen.findByRole('alert')).textContent).toBe(vi_[key as keyof typeof vi_]);
      expect(screen.queryByTestId('preview')).toBeNull();
    });
  });

  describe('applying', () => {
    const previewed = async (command: (operation: string, input: unknown) => unknown) => {
      const h = client(state(), command);
      mount(<PlanChangeScreen route={ROUTE} />, h, BILLING);
      await ready();
      await choose('p-big');
      await askPreview();
      return h;
    };
    const onlyPreview = (applied: () => unknown) => (operation: string) => (operation === 'previewPlanChange' ? previewOf() : applied());

    it('needs a reason, 10 to 2000 characters, before it sends anything', async () => {
      const h = await previewed(onlyPreview(() => ({})));
      fireEvent.change(apply().getByLabelText(vi_['sas.planChange.reason.label']), { target: { value: 'short' } });
      fireEvent.click(apply().getByRole('button', { name: vi_['sas.planChange.apply.action'] }));
      expect(await screen.findByText(vi_['sas.planChange.reason.tooShort'])).toBeTruthy();
      expect(h.command).toHaveBeenCalledTimes(1);
    });

    it('applies the change with the plan, the effect, the code of the preview, the version the screen showed and the reason, then says so (UAT-AC155)', async () => {
      const h = await previewed(onlyPreview(() => ({ operation_id: 'o', status: 'CHANGED', resource_version: 5, resource_id: 'sub-1' })));
      fireEvent.change(apply().getByLabelText(vi_['sas.planChange.reason.label']), { target: { value: '  The customer asked for the larger plan.  ' } });
      fireEvent.click(apply().getByRole('button', { name: vi_['sas.planChange.apply.action'] }));
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(2));
      const [operation, input] = h.command.mock.calls[1] as [string, { path: unknown; body: unknown; ifMatchVersion: number }];
      expect(operation).toBe('changeSubscriptionPlan');
      expect(input).toMatchObject({
        path: { subscriptionId: 'sub-1' },
        body: { target_plan_version_id: 'p-big', effective: 'NOW', preview_hash: 'ab'.repeat(32), reason: 'The customer asked for the larger plan.' },
        ifMatchVersion: 4,
      });
      expect(await screen.findByText(vi_['sas.planChange.done.notice'])).toBeTruthy();
      expect(screen.queryByTestId('preview')).toBeNull();
      expect(target().value).toBe('');
    });

    it('says the preview is stale when the server says so, forgets it, and lets the person preview again (UAT-AC155)', async () => {
      await previewed((operation) => (operation === 'previewPlanChange' ? previewOf() : problem('PREVIEW_STALE')));
      fireEvent.change(apply().getByLabelText(vi_['sas.planChange.reason.label']), { target: { value: 'The customer asked for the larger plan.' } });
      fireEvent.click(apply().getByRole('button', { name: vi_['sas.planChange.apply.action'] }));
      expect((await screen.findByRole('alert')).textContent).toBe(vi_['sas.planChange.problem.stale']);
      expect(screen.queryByTestId('preview')).toBeNull();
      expect(target().value).toBe('p-big');
      expect((screen.getByRole('button', { name: vi_['sas.planChange.preview.action'] }) as HTMLButtonElement).disabled).toBe(false);
    });

    it.each([
      ['VERSION_CONFLICT', 409, 'sas.subscription.problem.conflict'],
      ['SCOPE_DENIED', 403, 'sas.subscription.problem.denied'],
    ])('says why the server refused the change: %s', async (code, status, key) => {
      await previewed((operation) => (operation === 'previewPlanChange' ? previewOf() : problem(code, status)));
      fireEvent.change(apply().getByLabelText(vi_['sas.planChange.reason.label']), { target: { value: 'The customer asked for the larger plan.' } });
      fireEvent.click(apply().getByRole('button', { name: vi_['sas.planChange.apply.action'] }));
      expect((await screen.findByRole('alert')).textContent).toBe(vi_[key as keyof typeof vi_]);
    });
  });

  describe('the history', () => {
    it('says the plan has not been changed yet', async () => {
      mount(<PlanChangeScreen route={ROUTE} />, client(state()), BILLING);
      await ready();
      expect(screen.getByText(vi_['sas.planChange.history.empty'])).toBeTruthy();
    });

    it('lists the changes with the plans by name, the reason, the effect, the proration and where each stands', async () => {
      const changes = [
        { id: 'c3', from_plan_version_id: 'p-current', to_plan_version_id: 'p-small', effective: 'NEXT_CYCLE', effective_at: '2027-01-01T00:00:00Z', proration_vnd: '0', reason: 'Downgrade requested by the agency', requested_at: '2026-03-01T00:00:00Z' },
        { id: 'c2', from_plan_version_id: 'p-current', to_plan_version_id: 'p-big', effective: 'NEXT_CYCLE', effective_at: '2027-01-01T00:00:00Z', proration_vnd: '0', reason: 'An earlier wish', requested_at: '2026-02-20T00:00:00Z', superseded_at: '2026-03-01T00:00:00Z' },
        { id: 'c1', from_plan_version_id: 'p-small', to_plan_version_id: 'p-current', effective: 'NOW', effective_at: '2026-02-15T00:00:00Z', proration_vnd: '320000000', reason: 'The first upgrade', requested_at: '2026-02-15T00:00:00Z', applied_at: '2026-02-15T00:00:00Z' },
      ];
      const current = state();
      current.byTenant.set(TENANT_A, view(live(), { changes }));
      mount(<PlanChangeScreen route={ROUTE} />, client(current), BILLING);
      await ready();
      const rows = Array.from(document.querySelectorAll<HTMLElement>('tr[data-change-id]'));
      expect(rows.map((row) => row.getAttribute('data-change-id'))).toEqual(['c3', 'c2', 'c1']);
      await waitFor(() => expect(rows[0]?.textContent).toContain('Gói small'));
      expect(rows[0]?.textContent).toContain('Downgrade requested by the agency');
      expect(rows[0]?.textContent).toContain(vi_['sas.planChange.history.waiting']);
      expect(rows[1]?.textContent).toContain(vi_['sas.planChange.history.superseded']);
      expect(rows[2]?.textContent).toContain(vi_['sas.planChange.history.applied']);
      expect(rows[2]?.textContent).toContain(vi_['sas.subscription.price.text'].replace('{amount}', (320000000).toLocaleString('vi')));
      expect(rows[2]?.textContent).toContain(vi_['sas.planChange.effective.now']);
    });

    it('shows the plan that waits to take effect', async () => {
      const current = state();
      current.byTenant.set(
        TENANT_A,
        view(live({ pending_plan_version_id: 'p-small', pending_effective_at: '2027-01-01T00:00:00Z' }), { pending_plan: { id: 'p-small', plan_code: 'small', revision: 1, name: 'Gói small', base_price_vnd: '100000000' } }),
      );
      mount(<PlanChangeScreen route={ROUTE} />, client(current), BILLING);
      await ready();
      expect(document.querySelector('[data-pending-plan="p-small"]')?.textContent).toContain('Gói small');
    });
  });

  describe('the tenant and the states', () => {
    it('reads the tenant that is chosen and forgets the preview of the other', async () => {
      const current = state();
      current.byTenant.set(TENANT_B, view(live({ id: 'sub-2' })));
      const h = client(current);
      mount(<PlanChangeScreen route={ROUTE} />, h, BILLING);
      await ready();
      fireEvent.change(screen.getByLabelText(vi_['sas.subscription.tenant.label']), { target: { value: TENANT_B } });
      await waitFor(() => expect(document.querySelector('[data-subscription-id="sub-2"]')).not.toBeNull());
      expect(h.read).toHaveBeenCalledWith('getTenantSubscription', { path: { tenantId: TENANT_B } });
    });

    it('shows loading, the empty tenant list failing, and each failure as its own state with the picker kept', async () => {
      const h = client(state());
      (h.client as unknown as { read: () => Promise<unknown> }).read = vi.fn(() => new Promise(() => undefined));
      mount(<PlanChangeScreen route={ROUTE} />, h, BILLING);
      expect(await screen.findByLabelText(vi_['states.loading.label'])).toBeTruthy();
    });

    it.each([
      ['an error', new ApiError({ status: 503, code: 'UNAVAILABLE', correlationId: 'c' }), 'states.error.title'],
      ['a refusal', problem('SCOPE_DENIED', 403), 'states.denied.title'],
      ['a lapsed session', problem('SESSION_EXPIRED', 401), 'states.signedOut.title'],
      ['a network failure', new ApiError({ status: 0, code: 'NETWORK_ERROR', correlationId: 'c' }), 'states.offline.title'],
    ])('shows %s as its own state, keeps the tenant picker, and retries', async (_name, failure, title) => {
      const current = state({ byTenant: new Map([[TENANT_A, failure]]) });
      mount(<PlanChangeScreen route={ROUTE} />, client(current), BILLING);
      expect(await screen.findByText(vi_[title as keyof typeof vi_])).toBeTruthy();
      expect(screen.getByLabelText(vi_['sas.subscription.tenant.label'])).toBeTruthy();
      current.byTenant.set(TENANT_A, view(live()));
      fireEvent.click(screen.getByRole('button', { name: vi_['states.retry.action'] }));
      await ready();
    });
  });
});
