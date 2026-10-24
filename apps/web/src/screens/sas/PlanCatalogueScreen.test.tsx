import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../i18n/vi.json';
import PlanCatalogueScreen from './PlanCatalogueScreen';
import { harness, mount, routeOf } from './test-support';

const ROUTE = routeOf('SAS-06', 'FR-SAS-06');
const BILLING = ['system.billing.manage', 'system.tenant.read'];
const OPERATOR = ['system.tenant.read'];
const problem = (code: string, status = 422, detail?: string, extensions: Record<string, unknown> = {}) =>
  new ApiError({ status, code, correlationId: 'c', ...(detail === undefined ? {} : { detail }), extensions });

const standard = {
  id: '00000000-0000-4000-9000-000000000001',
  plan_code: 'STANDARD',
  revision: 1,
  name: 'sas.plan.standard.name',
  status: 'Published',
  billing_cycles: ['ANNUAL'],
  base_price_vnd: '0',
  vat_category: 'NOT_SUBJECT',
  legal_terms_ref: 'TERMS-STANDARD-1',
  published_at: '2026-01-01T00:00:00Z',
  version: 2,
  features: [
    { feature_code: 'reporting', limit_kind: 'BOOLEAN', grace_behavior: 'ALLOW', expired_behavior: 'READ_ONLY' },
    { feature_code: 'ai.analysis', limit_kind: 'BOOLEAN', limit_value: '0', grace_behavior: 'DENY', expired_behavior: 'DENY' },
    { feature_code: 'member.seats', limit_kind: 'QUOTA', limit_value: '50', grace_behavior: 'READ_ONLY', expired_behavior: 'DENY' },
  ],
};

const draft = {
  id: '00000000-0000-4000-9000-000000000002',
  plan_code: 'STANDARD',
  revision: 2,
  name: 'Gói tiêu chuẩn 2027',
  status: 'Draft',
  billing_cycles: ['MONTHLY', 'ANNUAL'],
  base_price_vnd: '1500000',
  vat_category: 'VAT_10',
  legal_terms_ref: 'TERMS-STANDARD-2',
  version: 1,
  features: [
    { feature_code: 'ai.analysis', limit_kind: 'METERED', meter: 'ai.tokens', limit_value: '100000', grace_behavior: 'DENY', expired_behavior: 'DENY' },
    { feature_code: 'export', limit_kind: 'BOOLEAN', grace_behavior: 'ALLOW', expired_behavior: 'EXPORT_ONLY' },
  ],
};

interface State {
  plans: Array<Record<string, unknown>>;
  failure?: Error;
}

function client(current: State, command: (operation: string, input: unknown) => unknown = () => ({})) {
  const h = harness(() => new Error('unexpected read'), command);
  (h.client as unknown as { readAll: (operation: string) => Promise<unknown[]> }).readAll = vi.fn((operation: string) => {
    if (operation !== 'listPlanVersions') return Promise.reject(new Error(`unexpected readAll ${operation}`));
    return current.failure === undefined ? Promise.resolve(current.plans) : Promise.reject(current.failure);
  });
  return h;
}

afterEach(cleanup);

const rows = (): HTMLElement[] => Array.from(document.querySelectorAll<HTMLElement>('tr[data-plan-id]'));
const ready = () => waitFor(() => expect(rows().length).toBeGreaterThan(0));
const form = () => within(screen.getByRole('form', { name: vi_['sas.plan.form.aria'] }));
const set = (label: string, value: string): void => {
  fireEvent.change(form().getByLabelText(label), { target: { value } });
};
const cellText = (row: HTMLElement | undefined, index: number): string => row?.querySelectorAll('td')[index]?.textContent ?? '';
const matrixRows = (): HTMLElement[] => Array.from(screen.getByTestId('matrix').querySelectorAll<HTMLElement>('tr[data-feature]'));
const aria = (key: string, row: number): string => vi_[key as keyof typeof vi_].replace('{row}', String(row));
const fillValid = (): void => {
  set(vi_['sas.plan.form.code.label'], 'pro-2027');
  set(vi_['sas.plan.form.name.label'], 'Gói chuyên nghiệp');
  set(vi_['sas.plan.form.price.label'], '2500000');
  set(vi_['sas.plan.form.terms.label'], 'TERMS-PRO-1');
};

describe('PlanCatalogueScreen (SAS-06): the plan catalogue', () => {
  it('lists the versions with price, cycles, VAT and state, and draws the feature matrix of the first (UI-SAS-06, AC-ST-SAS-007-2)', async () => {
    mount(<PlanCatalogueScreen route={ROUTE} />, client({ plans: [draft, standard] }), BILLING);
    await ready();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['sas.plan.page.title']);
    const [second, first] = rows();
    expect(cellText(second, 0)).toBe(`Gói tiêu chuẩn 2027${vi_['sas.plan.row.code'].replace('{code}', 'STANDARD').replace('{revision}', '2')}`);
    expect(cellText(second, 1)).toBe(vi_['sas.plan.row.price'].replace('{amount}', (1500000).toLocaleString('vi')));
    expect(cellText(second, 2)).toBe(`${vi_['sas.plan.cycle.monthly']}, ${vi_['sas.plan.cycle.annual']}`);
    expect(cellText(second, 3)).toBe(vi_['sas.plan.vat.ten']);
    expect(cellText(second, 4)).toBe(vi_['sas.plan.status.draft']);
    // The seeded plan carries a label key as its name.
    expect(cellText(first, 0)).toContain(vi_['sas.plan.standard.name']);
    expect(cellText(first, 1)).toBe(vi_['sas.plan.row.price'].replace('{amount}', '0'));
    expect(cellText(first, 3)).toBe(vi_['sas.plan.vat.notSubject']);
    expect(cellText(first, 4)).toBe(vi_['sas.plan.status.published']);
    // The matrix of the newest version: the kind of limit, the limit and what the feature does in grace and after the end.
    const [ai, exported] = matrixRows();
    expect(cellText(ai, 1)).toBe(vi_['sas.plan.kind.metered']);
    expect(cellText(ai, 2)).toBe(vi_['sas.plan.limit.meteredCap'].replace('{meter}', 'ai.tokens').replace('{cap}', '100000'));
    expect(cellText(ai, 3)).toBe(vi_['sas.plan.grace.deny']);
    expect(cellText(ai, 4)).toBe(vi_['sas.plan.expired.deny']);
    expect(cellText(exported, 1)).toBe(vi_['sas.plan.kind.boolean']);
    expect(cellText(exported, 2)).toBe(vi_['sas.plan.limit.on']);
    expect(cellText(exported, 3)).toBe(vi_['sas.plan.grace.allow']);
    expect(cellText(exported, 4)).toBe(vi_['sas.plan.expired.exportOnly']);
  });

  it('shows the matrix of the version chosen, with the quota, the switch that is off and the seat label', async () => {
    mount(<PlanCatalogueScreen route={ROUTE} />, client({ plans: [draft, standard] }), BILLING);
    await ready();
    fireEvent.click(within(rows()[1] as HTMLElement).getByRole('button', { name: vi_['sas.plan.row.features.action'] }));
    await waitFor(() => expect(screen.getByTestId('matrix').getAttribute('data-plan-id')).toBe(standard.id));
    const [reporting, ai, seats] = matrixRows();
    expect(cellText(reporting, 2)).toBe(vi_['sas.plan.limit.on']);
    expect(cellText(reporting, 4)).toBe(vi_['sas.plan.expired.readOnly']);
    expect(cellText(ai, 2)).toBe(vi_['sas.plan.limit.off']);
    expect(cellText(seats, 0)).toContain(vi_['sas.entitlements.feature.memberSeats']);
    expect(cellText(seats, 1)).toBe(vi_['sas.plan.kind.quota']);
    expect(cellText(seats, 2)).toBe('50');
    expect(cellText(seats, 3)).toBe(vi_['sas.plan.grace.readOnly']);
    expect(cellText(seats, 4)).toBe(vi_['sas.plan.expired.deny']);
  });

  it('gives a reader the catalogue and no form, no revision and no publication', async () => {
    mount(<PlanCatalogueScreen route={ROUTE} />, client({ plans: [draft, standard] }), OPERATOR);
    await ready();
    expect(screen.queryByRole('form', { name: vi_['sas.plan.form.aria'] })).toBeNull();
    expect(screen.getByText(vi_['sas.plan.form.denied'])).toBeTruthy();
    expect(screen.queryByRole('button', { name: vi_['sas.plan.row.publish.action'] })).toBeNull();
    expect(screen.queryByRole('button', { name: vi_['sas.plan.row.revise.action'] })).toBeNull();
    expect(screen.getAllByRole('button', { name: vi_['sas.plan.row.features.action'] })).toHaveLength(2);
  });

  it('offers publication only for a draft', async () => {
    mount(<PlanCatalogueScreen route={ROUTE} />, client({ plans: [draft, standard] }), BILLING);
    await ready();
    expect(within(rows()[0] as HTMLElement).getByRole('button', { name: vi_['sas.plan.row.publish.action'] })).toBeTruthy();
    expect(within(rows()[1] as HTMLElement).queryByRole('button', { name: vi_['sas.plan.row.publish.action'] })).toBeNull();
    expect(within(rows()[1] as HTMLElement).getByRole('button', { name: vi_['sas.plan.row.revise.action'] })).toBeTruthy();
  });

  describe('the seven states', () => {
    it('shows the empty state and still lets the author write the first plan', async () => {
      mount(<PlanCatalogueScreen route={ROUTE} />, client({ plans: [] }), BILLING);
      expect(await screen.findByText(vi_['states.empty.title'])).toBeTruthy();
      expect(screen.getByText(vi_['sas.plan.matrix.none'])).toBeTruthy();
      expect(screen.getByRole('form', { name: vi_['sas.plan.form.aria'] })).toBeTruthy();
    });

    it('shows loading while the catalogue is read', async () => {
      const h = client({ plans: [] });
      (h.client as unknown as { readAll: () => Promise<unknown[]> }).readAll = vi.fn(() => new Promise<unknown[]>(() => undefined));
      mount(<PlanCatalogueScreen route={ROUTE} />, h, BILLING);
      expect(await screen.findByLabelText(vi_['states.loading.label'])).toBeTruthy();
    });

    it.each([
      ['an error', new ApiError({ status: 503, code: 'UNAVAILABLE', correlationId: 'c' }), 'states.error.title'],
      ['a refusal', problem('SCOPE_DENIED', 403), 'states.denied.title'],
      ['a lapsed session', problem('SESSION_EXPIRED', 401), 'states.signedOut.title'],
      ['a network failure', new ApiError({ status: 0, code: 'NETWORK_ERROR', correlationId: 'c' }), 'states.offline.title'],
    ])('shows %s as its own state, and retries', async (_name, failure, title) => {
      const current: State = { plans: [standard], failure };
      const h = client(current);
      mount(<PlanCatalogueScreen route={ROUTE} />, h, BILLING);
      expect(await screen.findByText(vi_[title as keyof typeof vi_])).toBeTruthy();
      current.failure = undefined;
      fireEvent.click(screen.getByRole('button', { name: vi_['states.retry.action'] }));
      await ready();
    });
  });

  describe('writing a plan version', () => {
    it('shows what is missing and sends nothing while the form is not valid', async () => {
      const h = client({ plans: [standard] });
      mount(<PlanCatalogueScreen route={ROUTE} />, h, BILLING);
      await ready();
      fireEvent.click(form().getByRole('button', { name: vi_['sas.plan.form.submit.action'] }));
      expect(await screen.findAllByText(vi_['sas.plan.field.required'])).toHaveLength(3);
      expect(h.command).not.toHaveBeenCalled();
      set(vi_['sas.plan.form.code.label'], 'Pro_2027');
      set(vi_['sas.plan.form.price.label'], '12,5');
      expect(screen.getByText(vi_['sas.plan.field.format'])).toBeTruthy();
      expect(screen.getByText(vi_['sas.plan.field.notAmount'])).toBeTruthy();
    });

    it('asks for at least one billing cycle and one feature', async () => {
      const h = client({ plans: [standard] });
      mount(<PlanCatalogueScreen route={ROUTE} />, h, BILLING);
      await ready();
      fillValid();
      fireEvent.click(form().getByLabelText(vi_['sas.plan.cycle.annual']));
      fireEvent.click(form().getByRole('button', { name: aria('sas.plan.edit.remove.action', 1) }));
      fireEvent.click(form().getByRole('button', { name: vi_['sas.plan.form.submit.action'] }));
      expect(await screen.findAllByText(vi_['sas.plan.field.required'])).toHaveLength(2);
      expect(h.command).not.toHaveBeenCalled();
    });

    it('sends the draft with its cycles, price, VAT and features, and says it was written', async () => {
      const h = client({ plans: [standard] }, () => ({ operation_id: 'o', status: 'DRAFT', resource_version: 1, resource_id: draft.id }));
      mount(<PlanCatalogueScreen route={ROUTE} />, h, BILLING);
      await ready();
      fillValid();
      fireEvent.click(form().getByLabelText(vi_['sas.plan.cycle.monthly']));
      set(vi_['sas.plan.form.vat.label'], 'VAT_8');
      fireEvent.change(form().getByLabelText(aria('sas.plan.edit.code.aria', 1)), { target: { value: 'member.seats' } });
      fireEvent.change(form().getByLabelText(aria('sas.plan.edit.kind.aria', 1)), { target: { value: 'QUOTA' } });
      fireEvent.change(form().getByLabelText(aria('sas.plan.edit.limit.aria', 1)), { target: { value: '25' } });
      fireEvent.change(form().getByLabelText(aria('sas.plan.edit.grace.aria', 1)), { target: { value: 'READ_ONLY' } });
      fireEvent.change(form().getByLabelText(aria('sas.plan.edit.expired.aria', 1)), { target: { value: 'DENY' } });
      fireEvent.click(form().getByRole('button', { name: vi_['sas.plan.edit.add.action'] }));
      fireEvent.change(form().getByLabelText(aria('sas.plan.edit.code.aria', 2)), { target: { value: 'ai.analysis' } });
      fireEvent.change(form().getByLabelText(aria('sas.plan.edit.kind.aria', 2)), { target: { value: 'METERED' } });
      fireEvent.change(form().getByLabelText(aria('sas.plan.edit.meter.aria', 2)), { target: { value: 'ai.tokens' } });
      fireEvent.change(form().getByLabelText(aria('sas.plan.edit.grace.aria', 2)), { target: { value: 'DENY' } });
      fireEvent.change(form().getByLabelText(aria('sas.plan.edit.expired.aria', 2)), { target: { value: 'DENY' } });
      fireEvent.click(form().getByRole('button', { name: vi_['sas.plan.form.submit.action'] }));
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
      const [operation, input] = h.command.mock.calls[0] as [string, { body: unknown }];
      expect(operation).toBe('createPlanVersion');
      expect(input.body).toEqual({
        plan_code: 'pro-2027',
        name: 'Gói chuyên nghiệp',
        billing_cycles: ['MONTHLY', 'ANNUAL'],
        base_price_vnd: '2500000',
        vat_category: 'VAT_8',
        legal_terms_ref: 'TERMS-PRO-1',
        features: [
          { feature_code: 'member.seats', limit_kind: 'QUOTA', limit_value: '25', grace_behavior: 'READ_ONLY', expired_behavior: 'DENY' },
          { feature_code: 'ai.analysis', limit_kind: 'METERED', meter: 'ai.tokens', grace_behavior: 'DENY', expired_behavior: 'DENY' },
        ],
      });
      expect(await screen.findByText(vi_['sas.plan.done.created'].replace('{code}', 'pro-2027'))).toBeTruthy();
      // The form starts over for the next plan.
      expect((form().getByLabelText(vi_['sas.plan.form.code.label']) as HTMLInputElement).value).toBe('');
    });

    it('judges each feature row: a quota needs a limit, a meter only belongs to a metered feature, a feature appears once, the end is never wider than grace', async () => {
      const h = client({ plans: [standard] });
      mount(<PlanCatalogueScreen route={ROUTE} />, h, BILLING);
      await ready();
      fillValid();
      fireEvent.change(form().getByLabelText(aria('sas.plan.edit.kind.aria', 1)), { target: { value: 'QUOTA' } });
      fireEvent.change(form().getByLabelText(aria('sas.plan.edit.grace.aria', 1)), { target: { value: 'DENY' } });
      fireEvent.click(form().getByRole('button', { name: vi_['sas.plan.edit.add.action'] }));
      fireEvent.click(form().getByRole('button', { name: vi_['sas.plan.form.submit.action'] }));
      expect(await screen.findByText(vi_['sas.plan.feature.limitRequired'])).toBeTruthy();
      expect(screen.getByText(vi_['sas.plan.feature.expiredWider'])).toBeTruthy();
      expect(screen.getByText(vi_['sas.plan.feature.duplicate'])).toBeTruthy();
      expect((form().getByLabelText(aria('sas.plan.edit.meter.aria', 1)) as HTMLInputElement).disabled).toBe(true);
      fireEvent.change(form().getByLabelText(aria('sas.plan.edit.kind.aria', 2)), { target: { value: 'METERED' } });
      expect((form().getByLabelText(aria('sas.plan.edit.meter.aria', 2)) as HTMLInputElement).disabled).toBe(false);
      expect(screen.getByText(vi_['sas.plan.feature.meterRequired'])).toBeTruthy();
      fireEvent.change(form().getByLabelText(aria('sas.plan.edit.meter.aria', 2)), { target: { value: 'AI Tokens' } });
      expect(screen.getByText(vi_['sas.plan.feature.meterInvalid'])).toBeTruthy();
      fireEvent.change(form().getByLabelText(aria('sas.plan.edit.limit.aria', 1)), { target: { value: '-3' } });
      expect(screen.getByText(vi_['sas.plan.feature.limitInvalid'])).toBeTruthy();
      expect(h.command).not.toHaveBeenCalled();
    });

    it('does not accept a meter on a feature that is not metered', async () => {
      mount(<PlanCatalogueScreen route={ROUTE} />, client({ plans: [standard] }), BILLING);
      await ready();
      fillValid();
      fireEvent.change(form().getByLabelText(aria('sas.plan.edit.kind.aria', 1)), { target: { value: 'METERED' } });
      fireEvent.change(form().getByLabelText(aria('sas.plan.edit.meter.aria', 1)), { target: { value: 'ai.tokens' } });
      fireEvent.change(form().getByLabelText(aria('sas.plan.edit.kind.aria', 1)), { target: { value: 'BOOLEAN' } });
      fireEvent.click(form().getByRole('button', { name: vi_['sas.plan.form.submit.action'] }));
      expect(await screen.findByText(vi_['sas.plan.feature.meterNotAllowed'])).toBeTruthy();
    });

    it('starts the next revision of a plan from its version: same code, price, terms and features, ready to change', async () => {
      mount(<PlanCatalogueScreen route={ROUTE} />, client({ plans: [draft, standard] }), BILLING);
      await ready();
      fireEvent.click(within(rows()[0] as HTMLElement).getByRole('button', { name: vi_['sas.plan.row.revise.action'] }));
      expect((form().getByLabelText(vi_['sas.plan.form.code.label']) as HTMLInputElement).value).toBe('STANDARD');
      expect((form().getByLabelText(vi_['sas.plan.form.price.label']) as HTMLInputElement).value).toBe('1500000');
      expect((form().getByLabelText(vi_['sas.plan.form.terms.label']) as HTMLInputElement).value).toBe('TERMS-STANDARD-2');
      expect((form().getByLabelText(vi_['sas.plan.cycle.monthly']) as HTMLInputElement).checked).toBe(true);
      expect((form().getByLabelText(aria('sas.plan.edit.meter.aria', 1)) as HTMLInputElement).value).toBe('ai.tokens');
      expect((form().getByLabelText(aria('sas.plan.edit.limit.aria', 1)) as HTMLInputElement).value).toBe('100000');
      expect(form().getByLabelText(aria('sas.plan.edit.code.aria', 2))).toBeTruthy();
    });

    it.each([
      ['PLAN_INVALID', 422, 'features[0].meter', { reason: 'METER_REQUIRED' }, (text: string) => text.includes('METER_REQUIRED') && text.includes('1')],
      ['PLAN_INVALID', 422, undefined, {}, (text: string) => text === vi_['sas.plan.problem.planInvalid']],
      ['VALIDATION_FAILED', 422, 'plan_code', {}, (text: string) => text === vi_['sas.plan.problem.invalid']],
      ['SCOPE_DENIED', 403, undefined, {}, (text: string) => text === vi_['sas.plan.problem.denied']],
      ['SESSION_EXPIRED', 401, undefined, {}, (text: string) => text === vi_['sas.plan.problem.session']],
      ['SOMETHING_ELSE', 500, undefined, {}, (text: string) => text === vi_['sas.plan.problem.general']],
    ])('says why the server refused the draft: %s %s', async (code, status, detail, extensions, expected) => {
      mount(<PlanCatalogueScreen route={ROUTE} />, client({ plans: [standard] }, () => problem(code, status, detail, extensions)), BILLING);
      await ready();
      fillValid();
      fireEvent.click(form().getByRole('button', { name: vi_['sas.plan.form.submit.action'] }));
      const alert = await screen.findByRole('alert');
      expect(expected(alert.textContent ?? '')).toBe(true);
    });
  });

  describe('publishing a draft', () => {
    const open = async (command?: (operation: string, input: unknown) => unknown) => {
      const h = client({ plans: [draft, standard] }, command);
      mount(<PlanCatalogueScreen route={ROUTE} />, h, BILLING);
      await ready();
      fireEvent.click(within(rows()[0] as HTMLElement).getByRole('button', { name: vi_['sas.plan.row.publish.action'] }));
      return h;
    };
    const confirm = () => within(screen.getByRole('form', { name: vi_['sas.plan.publish.aria'] }));

    it('says that a published version never changes and asks for the reason before it sends anything', async () => {
      const h = await open();
      expect(screen.getByText(vi_['sas.plan.publish.rule'])).toBeTruthy();
      expect(screen.getByRole('heading', { name: vi_['sas.plan.publish.title'].replace('{code}', 'STANDARD').replace('{revision}', '2') })).toBeTruthy();
      fireEvent.change(confirm().getByLabelText(vi_['sas.plan.publish.reason.label']), { target: { value: 'short' } });
      fireEvent.click(confirm().getByRole('button', { name: vi_['sas.plan.publish.confirm.action'] }));
      expect(await screen.findByText(vi_['sas.plan.publish.reason.tooShort'])).toBeTruthy();
      expect(h.command).not.toHaveBeenCalled();
    });

    it('publishes with the version the screen showed and the reason, then says so', async () => {
      const h = await open(() => ({ operation_id: 'o', status: 'PUBLISHED', resource_version: 2, resource_id: draft.id }));
      fireEvent.change(confirm().getByLabelText(vi_['sas.plan.publish.reason.label']), { target: { value: '  The price list was approved.  ' } });
      fireEvent.click(confirm().getByRole('button', { name: vi_['sas.plan.publish.confirm.action'] }));
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
      const [operation, input] = h.command.mock.calls[0] as [string, { path: unknown; body: unknown; ifMatchVersion: number }];
      expect(operation).toBe('publishPlanVersion');
      expect(input.path).toEqual({ planVersionId: draft.id });
      expect(input.body).toEqual({ reason: 'The price list was approved.' });
      expect(input.ifMatchVersion).toBe(1);
      expect(await screen.findByText(vi_['sas.plan.done.published'].replace('{code}', 'STANDARD').replace('{revision}', '2'))).toBeTruthy();
      expect(screen.queryByRole('form', { name: vi_['sas.plan.publish.aria'] })).toBeNull();
    });

    it('can be cancelled', async () => {
      const h = await open();
      fireEvent.click(confirm().getByRole('button', { name: vi_['sas.plan.publish.cancel.action'] }));
      expect(screen.queryByRole('form', { name: vi_['sas.plan.publish.aria'] })).toBeNull();
      expect(h.command).not.toHaveBeenCalled();
    });

    it.each([
      ['PLAN_VERSION_IMMUTABLE', 409, 'sas.plan.problem.immutable'],
      ['VERSION_CONFLICT', 409, 'sas.plan.problem.conflict'],
      ['RESOURCE_NOT_FOUND', 404, 'sas.plan.problem.notFound'],
    ])('says why the server refused the publication: %s', async (code, status, key) => {
      await open(() => problem(code, status));
      fireEvent.change(confirm().getByLabelText(vi_['sas.plan.publish.reason.label']), { target: { value: 'The price list was approved.' } });
      fireEvent.click(confirm().getByRole('button', { name: vi_['sas.plan.publish.confirm.action'] }));
      const alert = await screen.findByRole('alert');
      expect(alert.textContent).toBe(vi_[key as keyof typeof vi_]);
    });
  });
});
