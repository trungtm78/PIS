import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../i18n/vi.json';
import SubscriptionScreen from './SubscriptionScreen';
import { harness, mount, routeOf } from './test-support';

const ROUTE = routeOf('SAS-07', 'FR-SAS-07');
const BILLING = ['system.tenant.read', 'system.billing.manage'];
const READER = ['system.tenant.read'];
const TENANT_A = '00000000-0000-4000-8000-0000000000a1';
const TENANT_B = '00000000-0000-4000-8000-0000000000b1';
const problem = (code: string, status = 409, detail?: string) => new ApiError({ status, code, correlationId: 'c', ...(detail === undefined ? {} : { detail }), extensions: {} });

const plan = (id: string, code: string, price: string, cycles: string[] = ['ANNUAL', 'MONTHLY'], name = `Gói ${code}`) => ({
  id,
  plan_code: code,
  revision: 1,
  name,
  status: 'Published',
  billing_cycles: cycles,
  base_price_vnd: price,
  vat_category: 'NOT_SUBJECT',
  legal_terms_ref: 'T',
  version: 2,
  features: [],
});

const PLANS = [plan('p-annual', 'annual-only', '365000000', ['ANNUAL']), plan('p-both', 'both', '100000', ['MONTHLY', 'ANNUAL']), { ...plan('p-draft', 'draft', '5'), status: 'Draft' }];

const live = (overrides: Record<string, unknown> = {}) => ({
  id: 'sub-1',
  plan_version_id: 'p-annual',
  cycle: 'ANNUAL',
  billing_anchor: '2026-01-01',
  status: 'Active',
  started_at: '2026-01-01T00:00:00Z',
  current_period_start: '2026-01-01',
  current_period_end: '2026-12-31',
  cancel_at_period_end: false,
  procurement_contract_ref: 'HD-2026/001',
  payment_terms: { due_days: 30, method: 'BANK_TRANSFER' },
  version: 4,
  ...overrides,
});

const view = (subscription: Record<string, unknown> | undefined, extra: Record<string, unknown> = {}) =>
  subscription === undefined
    ? { changes: [] }
    : { subscription, plan: { id: 'p-annual', plan_code: 'annual-only', revision: 1, name: 'sas.plan.standard.name', base_price_vnd: '365000000' }, changes: [], ...extra };

interface State {
  byTenant: Map<string, Record<string, unknown> | Error>;
  plans: Array<Record<string, unknown>> | Error;
}

const state = (overrides: Partial<State> = {}): State => ({
  byTenant: new Map([
    [TENANT_A, view(live())],
    [TENANT_B, view(undefined)],
  ]),
  plans: PLANS,
  ...overrides,
});

function client(current: State, command: (operation: string, input: unknown) => unknown = () => ({})) {
  const h = harness((operation, input) => {
    if (operation === 'listSystemTenants') return { items: [{ id: TENANT_A, code: 'cao-bang', name: 'Cao Bằng' }, { id: TENANT_B, code: 'ha-giang', name: 'Hà Giang' }], next_cursor: null };
    if (operation === 'getTenantSubscription') return current.byTenant.get((input as { path: { tenantId: string } }).path.tenantId) ?? new Error('unknown tenant');
    return new Error(`unexpected read ${operation}`);
  }, command);
  (h.client as unknown as { readAll: (operation: string) => Promise<unknown[]> }).readAll = vi.fn((operation: string) => {
    if (operation !== 'listPlanVersions') return Promise.reject(new Error(`unexpected readAll ${operation}`));
    return current.plans instanceof Error ? Promise.reject(current.plans) : Promise.resolve(current.plans);
  });
  return h;
}

afterEach(cleanup);

const form = () => within(screen.getByRole('form', { name: vi_['sas.subscription.form.aria'] }));
const set = (label: string, value: string): void => {
  fireEvent.change(form().getByLabelText(label), { target: { value } });
};

describe('SubscriptionScreen (SAS-07): the subscription of a tenant', () => {
  describe('a tenant with a live subscription', () => {
    it('shows its plan, price, status, cycle, period, contract, payment terms and what waits (UI-SAS-07, AC-ST-SAS-008-4)', async () => {
      const current = state();
      current.byTenant.set(
        TENANT_A,
        view(live({ status: 'Trialing', trial_ends_at: '2026-04-01T00:00:00Z', pending_plan_version_id: 'p-both', pending_effective_at: '2027-01-01T00:00:00Z' }), {
          pending_plan: { id: 'p-both', plan_code: 'both', revision: 1, name: 'Gói both', base_price_vnd: '100000' },
        }),
      );
      mount(<SubscriptionScreen route={ROUTE} />, client(current), BILLING);
      await waitFor(() => expect(document.querySelector('[data-subscription-id="sub-1"]')).not.toBeNull());
      expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['sas.subscription.page.title']);
      // It is a detail of the billing screen, and says so with a way back to it.
      expect(screen.getByRole('link', { name: new RegExp(vi_['sas.subscription.back.link']) }).getAttribute('href')).toBe('/sas/sas-09');
      const fields = document.querySelector('[data-subscription-id="sub-1"]') as HTMLElement;
      const text = fields.textContent ?? '';
      expect(text).toContain(vi_['sas.subscription.plan.text'].replace('{name}', vi_['sas.plan.standard.name']).replace('{code}', 'annual-only').replace('{revision}', '1'));
      expect(text).toContain(vi_['sas.subscription.price.text'].replace('{amount}', (365000000).toLocaleString('vi')));
      expect(text).toContain(vi_['sas.subscription.status.trialing']);
      expect(text).toContain(vi_['sas.plan.cycle.annual']);
      expect(text).toContain('HD-2026/001');
      expect(text).toContain(vi_['sas.subscription.terms.text'].replace('{days}', '30').replace('{method}', vi_['sas.subscription.method.bank']));
      expect(text).toContain(new Date('2026-04-01T00:00:00Z').toLocaleDateString('vi', { timeZone: 'UTC' }));
      expect(fields.querySelector('[data-pending-plan="p-both"]')?.textContent).toContain('Gói both');
      expect(fields.getAttribute('data-status')).toBe('Trialing');
      // A subscription that is live has no form to create another.
      expect(screen.queryByRole('form', { name: vi_['sas.subscription.form.aria'] })).toBeNull();
    });

    it('shows the plan by its id when the plan is not known, and a contract that is none', async () => {
      const current = state();
      current.byTenant.set(TENANT_A, { subscription: live({ procurement_contract_ref: undefined, payment_terms: {} }), changes: [] });
      mount(<SubscriptionScreen route={ROUTE} />, client(current), BILLING);
      await waitFor(() => expect(document.querySelector('[data-subscription-id="sub-1"]')).not.toBeNull());
      const text = (document.querySelector('[data-subscription-id="sub-1"]') as HTMLElement).textContent ?? '';
      expect(text).toContain('p-annual');
      expect(text).toContain(vi_['sas.subscription.contract.none']);
    });

    it('says that a subscription set to end ends with its period, and offers no second cancellation', async () => {
      const current = state();
      current.byTenant.set(TENANT_A, view(live({ cancel_at_period_end: true })));
      mount(<SubscriptionScreen route={ROUTE} />, client(current), BILLING);
      await waitFor(() => expect(document.querySelector('[data-subscription-id="sub-1"]')).not.toBeNull());
      expect(screen.getByText(vi_['sas.subscription.cancelAtEnd.text'].replace('{day}', new Date('2026-12-31T00:00:00Z').toLocaleDateString('vi', { timeZone: 'UTC' })), { exact: false })).toBeTruthy();
      expect(screen.queryByRole('button', { name: vi_['sas.subscription.cancel.action'] })).toBeNull();
    });

    it('links to the change of plan of the same tenant', async () => {
      mount(<SubscriptionScreen route={ROUTE} />, client(state()), BILLING);
      await waitFor(() => expect(document.querySelector('[data-subscription-id="sub-1"]')).not.toBeNull());
      const link = screen.getByRole('link', { name: vi_['sas.subscription.change.link'] });
      expect(link.getAttribute('href')).toContain(`tenant=${TENANT_A}`);
    });

    it('gives a reader the subscription and neither the cancel button nor the form', async () => {
      const h = client(state());
      mount(<SubscriptionScreen route={ROUTE} />, h, READER);
      await waitFor(() => expect(document.querySelector('[data-subscription-id="sub-1"]')).not.toBeNull());
      expect(screen.queryByRole('button', { name: vi_['sas.subscription.cancel.action'] })).toBeNull();
      expect((h.client as unknown as { readAll: ReturnType<typeof vi.fn> }).readAll).not.toHaveBeenCalled();
    });
  });

  describe('cancelling', () => {
    const open = async (current = state(), command?: (operation: string, input: unknown) => unknown) => {
      const h = client(current, command);
      mount(<SubscriptionScreen route={ROUTE} />, h, BILLING);
      await waitFor(() => expect(document.querySelector('[data-subscription-id="sub-1"]')).not.toBeNull());
      fireEvent.click(screen.getByRole('button', { name: vi_['sas.subscription.cancel.action'] }));
      return h;
    };
    const confirm = () => within(screen.getByRole('form', { name: vi_['sas.subscription.cancel.aria'] }));

    it('says what cancelling does to a paid subscription and asks for the reason before it sends anything', async () => {
      const h = await open();
      expect(screen.getByText(vi_['sas.subscription.cancel.rule.paid'])).toBeTruthy();
      fireEvent.change(confirm().getByLabelText(vi_['sas.subscription.cancel.reason.label']), { target: { value: 'short' } });
      fireEvent.click(confirm().getByRole('button', { name: vi_['sas.subscription.cancel.confirm.action'] }));
      expect(await screen.findByText(vi_['sas.subscription.cancel.reason.tooShort'])).toBeTruthy();
      expect(h.command).not.toHaveBeenCalled();
    });

    it('says that a trial ends at once', async () => {
      const current = state();
      current.byTenant.set(TENANT_A, view(live({ status: 'Trialing' })));
      await open(current);
      expect(screen.getByText(vi_['sas.subscription.cancel.rule.trial'])).toBeTruthy();
    });

    it('cancels with the version the screen showed and the reason, then says so', async () => {
      const h = await open(state(), () => ({ operation_id: 'o', status: 'CANCEL_AT_PERIOD_END', resource_version: 5, resource_id: 'sub-1' }));
      fireEvent.change(confirm().getByLabelText(vi_['sas.subscription.cancel.reason.label']), { target: { value: '  The agency ended the contract.  ' } });
      fireEvent.click(confirm().getByRole('button', { name: vi_['sas.subscription.cancel.confirm.action'] }));
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
      const [operation, input] = h.command.mock.calls[0] as [string, { path: unknown; body: unknown; ifMatchVersion: number }];
      expect(operation).toBe('cancelSubscription');
      expect(input).toMatchObject({ path: { subscriptionId: 'sub-1' }, body: { reason: 'The agency ended the contract.' }, ifMatchVersion: 4 });
      expect(await screen.findByText(vi_['sas.subscription.done.cancelled'])).toBeTruthy();
      expect(screen.queryByRole('form', { name: vi_['sas.subscription.cancel.aria'] })).toBeNull();
    });

    it('can be given up', async () => {
      const h = await open();
      fireEvent.click(confirm().getByRole('button', { name: vi_['sas.subscription.cancel.abort.action'] }));
      expect(screen.queryByRole('form', { name: vi_['sas.subscription.cancel.aria'] })).toBeNull();
      expect(h.command).not.toHaveBeenCalled();
    });

    it.each([
      ['SUBSCRIPTION_STATE_INVALID', 409, 'sas.subscription.problem.stateInvalid'],
      ['VERSION_CONFLICT', 409, 'sas.subscription.problem.conflict'],
      ['SCOPE_DENIED', 403, 'sas.subscription.problem.denied'],
    ])('says why the server refused the cancellation: %s', async (code, status, key) => {
      await open(state(), () => problem(code, status));
      fireEvent.change(confirm().getByLabelText(vi_['sas.subscription.cancel.reason.label']), { target: { value: 'The agency ended the contract.' } });
      fireEvent.click(confirm().getByRole('button', { name: vi_['sas.subscription.cancel.confirm.action'] }));
      expect((await screen.findByRole('alert')).textContent).toBe(vi_[key as keyof typeof vi_]);
    });
  });

  describe('a tenant with none', () => {
    const open = async (command?: (operation: string, input: unknown) => unknown, permissions: readonly string[] = BILLING) => {
      const h = client(state(), command);
      mount(<SubscriptionScreen route={ROUTE} />, h, permissions, `/?tenant=${TENANT_B}`);
      await waitFor(() => expect(screen.queryByText(vi_['sas.subscription.current.none'])).not.toBeNull());
      return h;
    };

    it('says so and offers the form, with the published plans only', async () => {
      await open();
      expect(screen.getByText(vi_['sas.subscription.current.none'])).toBeTruthy();
      await waitFor(() => expect(form().getAllByRole('option').length).toBeGreaterThan(3));
      const options = within(form().getByLabelText(vi_['sas.subscription.form.plan.label'])).getAllByRole('option').map((option) => option.textContent);
      expect(options).toEqual([
        vi_['sas.subscription.form.choose.option'],
        vi_['sas.subscription.plan.option'].replace('{name}', 'Gói annual-only').replace('{code}', 'annual-only').replace('{revision}', '1').replace('{amount}', (365000000).toLocaleString('vi')),
        vi_['sas.subscription.plan.option'].replace('{name}', 'Gói both').replace('{code}', 'both').replace('{revision}', '1').replace('{amount}', (100000).toLocaleString('vi')),
      ]);
    });

    it('gives a reader no form', async () => {
      await open(undefined, READER);
      expect(screen.queryByRole('form', { name: vi_['sas.subscription.form.aria'] })).toBeNull();
      expect(screen.getByText(vi_['sas.subscription.form.denied'])).toBeTruthy();
    });

    it('shows what is missing and sends nothing while the form is not valid', async () => {
      const h = await open();
      await waitFor(() => expect(form().getByLabelText(vi_['sas.subscription.form.plan.label'])).toBeTruthy());
      fireEvent.click(form().getByRole('button', { name: vi_['sas.subscription.form.submit.action'] }));
      expect(await screen.findAllByText(vi_['sas.subscription.field.required'])).toHaveLength(3);
      expect(h.command).not.toHaveBeenCalled();
      set(vi_['sas.subscription.form.trial.label'].replace('{max}', '90'), '91');
      set(vi_['sas.subscription.form.due.label'].replace('{max}', '180'), 'x');
      expect(screen.getByText(vi_['sas.subscription.field.outOfRange'])).toBeTruthy();
      expect(screen.getByText(vi_['sas.subscription.field.notWhole'])).toBeTruthy();
    });

    it('offers only the cycles of the plan chosen, and keeps a cycle that the plan sells', async () => {
      await open();
      await waitFor(() => expect(within(form().getByLabelText(vi_['sas.subscription.form.plan.label'])).getAllByRole('option').length).toBe(3));
      set(vi_['sas.subscription.form.plan.label'], 'p-annual');
      const cycles = (): string[] => within(form().getByLabelText(vi_['sas.subscription.form.cycle.label'])).getAllByRole('option').map((option) => option.textContent ?? '');
      expect(cycles()).toEqual([vi_['sas.subscription.form.choose.option'], vi_['sas.plan.cycle.annual']]);
      expect((form().getByLabelText(vi_['sas.subscription.form.cycle.label']) as HTMLSelectElement).value).toBe('ANNUAL');
      set(vi_['sas.subscription.form.plan.label'], 'p-both');
      expect(cycles()).toEqual([vi_['sas.subscription.form.choose.option'], vi_['sas.plan.cycle.monthly'], vi_['sas.plan.cycle.annual']]);
      expect((form().getByLabelText(vi_['sas.subscription.form.cycle.label']) as HTMLSelectElement).value).toBe('ANNUAL');
    });

    it('creates the subscription for the tenant of the address with the contract body, and says so', async () => {
      const h = await open(() => ({ operation_id: 'o', status: 'ACTIVE', resource_version: 1, resource_id: 'sub-9' }));
      await waitFor(() => expect(within(form().getByLabelText(vi_['sas.subscription.form.plan.label'])).getAllByRole('option').length).toBe(3));
      set(vi_['sas.subscription.form.plan.label'], 'p-both');
      set(vi_['sas.subscription.form.cycle.label'], 'MONTHLY');
      set(vi_['sas.subscription.form.anchor.label'], '2026-03-01');
      set(vi_['sas.subscription.form.trial.label'].replace('{max}', '90'), '30');
      set(vi_['sas.subscription.form.contract.label'], 'HD-2026/002');
      set(vi_['sas.subscription.form.due.label'].replace('{max}', '180'), '45');
      set(vi_['sas.subscription.form.method.label'], 'TREASURY_TRANSFER');
      fireEvent.click(form().getByRole('button', { name: vi_['sas.subscription.form.submit.action'] }));
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
      const [operation, input] = h.command.mock.calls[0] as [string, { path: unknown; body: unknown }];
      expect(operation).toBe('createSubscription');
      expect(input.path).toEqual({ tenantId: TENANT_B });
      expect(input.body).toEqual({
        plan_version_id: 'p-both',
        cycle: 'MONTHLY',
        billing_anchor: '2026-03-01',
        trial_days: 30,
        procurement_contract_ref: 'HD-2026/002',
        payment_terms: { due_days: 45, method: 'TREASURY_TRANSFER' },
      });
      expect(await screen.findByText(vi_['sas.subscription.done.created'])).toBeTruthy();
      expect((form().getByLabelText(vi_['sas.subscription.form.plan.label']) as HTMLSelectElement).value).toBe('');
    });

    it.each([
      ['SUBSCRIPTION_EXISTS', 409, undefined, 'sas.subscription.problem.exists'],
      ['PLAN_NOT_PUBLISHED', 409, undefined, 'sas.subscription.problem.notPublished'],
      ['TENANT_STATE_INVALID', 409, undefined, 'sas.subscription.problem.tenantState'],
      ['SCOPE_DENIED', 403, undefined, 'sas.subscription.problem.denied'],
      ['RESOURCE_NOT_FOUND', 404, undefined, 'sas.subscription.problem.notFound'],
      ['SESSION_EXPIRED', 401, undefined, 'sas.subscription.problem.session'],
      ['VALIDATION_FAILED', 422, undefined, 'sas.subscription.problem.invalid'],
      ['SOMETHING_ELSE', 500, undefined, 'sas.subscription.problem.general'],
    ])('says why the server refused the creation: %s', async (code, status, detail, key) => {
      await open(() => problem(code, status, detail));
      await waitFor(() => expect(within(form().getByLabelText(vi_['sas.subscription.form.plan.label'])).getAllByRole('option').length).toBe(3));
      set(vi_['sas.subscription.form.plan.label'], 'p-both');
      set(vi_['sas.subscription.form.anchor.label'], '2026-03-01');
      fireEvent.click(form().getByRole('button', { name: vi_['sas.subscription.form.submit.action'] }));
      expect((await screen.findByRole('alert')).textContent).toBe(vi_[key as keyof typeof vi_]);
    });

    it('names the field the server refused', async () => {
      await open(() => problem('VALIDATION_FAILED', 422, 'cycle'));
      await waitFor(() => expect(within(form().getByLabelText(vi_['sas.subscription.form.plan.label'])).getAllByRole('option').length).toBe(3));
      set(vi_['sas.subscription.form.plan.label'], 'p-both');
      set(vi_['sas.subscription.form.anchor.label'], '2026-03-01');
      fireEvent.click(form().getByRole('button', { name: vi_['sas.subscription.form.submit.action'] }));
      expect((await screen.findByRole('alert')).textContent).toBe(vi_['sas.subscription.problem.invalidAt'].replace('{field}', 'cycle'));
    });
  });

  describe('the tenant and the states', () => {
    it('reads the tenant that is chosen', async () => {
      const h = client(state());
      mount(<SubscriptionScreen route={ROUTE} />, h, BILLING);
      await waitFor(() => expect(document.querySelector('[data-subscription-id="sub-1"]')).not.toBeNull());
      fireEvent.change(screen.getByLabelText(vi_['sas.subscription.tenant.label']), { target: { value: TENANT_B } });
      await waitFor(() => expect(h.read).toHaveBeenCalledWith('getTenantSubscription', { path: { tenantId: TENANT_B } }));
      expect(await screen.findByText(vi_['sas.subscription.current.none'])).toBeTruthy();
    });

    it('offers more tenants when there are more', async () => {
      const h = harness((operation, input) => {
        if (operation === 'getTenantSubscription') return view(live());
        if (operation !== 'listSystemTenants') return new Error('unexpected');
        const first = (input as { query: { cursor?: string } }).query.cursor === undefined;
        return first ? { items: [{ id: TENANT_A, code: 'cao-bang', name: 'Cao Bằng' }], next_cursor: 'more' } : { items: [{ id: TENANT_B, code: 'ha-giang', name: 'Hà Giang' }], next_cursor: null };
      });
      (h.client as unknown as { readAll: () => Promise<unknown[]> }).readAll = vi.fn(() => Promise.resolve([]));
      mount(<SubscriptionScreen route={ROUTE} />, h, BILLING);
      await waitFor(() => expect(document.querySelector('[data-subscription-id="sub-1"]')).not.toBeNull());
      fireEvent.click(screen.getByRole('button', { name: vi_['sas.subscription.tenant.more.action'] }));
      await waitFor(() => expect(h.read.mock.calls.filter(([operation]) => operation === 'listSystemTenants')).toHaveLength(2));
    });

    it('shows loading while the subscription is read', async () => {
      const h = client(state());
      (h.client as unknown as { read: () => Promise<unknown> }).read = vi.fn(() => new Promise(() => undefined));
      mount(<SubscriptionScreen route={ROUTE} />, h, BILLING);
      expect(await screen.findByLabelText(vi_['states.loading.label'])).toBeTruthy();
    });

    it.each([
      ['an error', new ApiError({ status: 503, code: 'UNAVAILABLE', correlationId: 'c' }), 'states.error.title'],
      ['a refusal', problem('SCOPE_DENIED', 403), 'states.denied.title'],
      ['a lapsed session', problem('SESSION_EXPIRED', 401), 'states.signedOut.title'],
      ['a network failure', new ApiError({ status: 0, code: 'NETWORK_ERROR', correlationId: 'c' }), 'states.offline.title'],
    ])('shows %s as its own state, keeps the tenant picker, and retries', async (_name, failure, title) => {
      const current = state();
      current.byTenant.set(TENANT_A, failure);
      mount(<SubscriptionScreen route={ROUTE} />, client(current), BILLING);
      expect(await screen.findByText(vi_[title as keyof typeof vi_])).toBeTruthy();
      expect(screen.getByLabelText(vi_['sas.subscription.tenant.label'])).toBeTruthy();
      current.byTenant.set(TENANT_A, view(live()));
      fireEvent.click(screen.getByRole('button', { name: vi_['states.retry.action'] }));
      await waitFor(() => expect(document.querySelector('[data-subscription-id="sub-1"]')).not.toBeNull());
    });

    it('shows the tenant list failing as a state of its own', async () => {
      const h = harness((operation) => (operation === 'listSystemTenants' ? problem('SCOPE_DENIED', 403) : new Error('unexpected')));
      mount(<SubscriptionScreen route={ROUTE} />, h, BILLING);
      expect(await screen.findByText(vi_['states.denied.title'])).toBeTruthy();
    });
  });
});
