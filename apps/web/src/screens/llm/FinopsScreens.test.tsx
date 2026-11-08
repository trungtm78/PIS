import { ApiError, NETWORK_ERROR_CODE } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../i18n/vi.json';
import { harness, mount, routeOf } from '../mne/test-support';
import BudgetsScreen from './BudgetsScreen';
import PricesScreen from './PricesScreen';
import UsageScreen from './UsageScreen';
import { EMPTY_BUDGET, EMPTY_PRICE, groupDigits, budgetBody, describeLlmProblem, priceBody, toBudget, toPrice, toReservation, toSpend, usedPercent, validateBudget, validatePrice } from './llm-model';

const BUDGETS = routeOf('LLM-07', 'FR-LLM-07');
const PRICES = routeOf('LLM-08', 'FR-LLM-08');
const USAGE = routeOf('LLM-09', 'FR-LLM-09');
const FINOPS = ['llm.finops', 'budget_reservation.read'];
const failure = (status: number, code: string, detail?: string) => new ApiError({ status, code, correlationId: 'c', detail, extensions: {} });
const fill = (text: string, values: Record<string, string | number>): string => Object.entries(values).reduce((out, [key, value]) => out.replace(`{${key}}`, String(value)), text);

const B1 = '00000000-0000-4000-8000-0000000000b1';
const B2 = '00000000-0000-4000-8000-0000000000b2';
const UNIT = '00000000-0000-4000-8000-0000000000c1';
const MODEL = '00000000-0000-4000-8000-0000000000d1';
const counter = (overrides: Record<string, unknown> = {}) => ({ id: 'k1', period_start: '2026-10-01', limit_vnd: '1000000', settled_vnd: '480000', reserved_open_vnd: '100000', available_vnd: '420000', request_count: 7, exception_count: 0, blocked: false, ...overrides });
const rawBudget = (overrides: Record<string, unknown> = {}) => ({
  id: B1,
  scope_kind: 'TENANT',
  scope_ref_id: null,
  period: 'MONTH',
  limit_vnd: '1000000',
  soft_threshold_pct: 80,
  hard_stop: true,
  max_requests_per_day: null,
  max_concurrent: null,
  effective_from: '2026-01-01',
  status: 'ACTIVE',
  created_by: B1,
  created_at: '2026-10-01T00:00:00.000Z',
  version: 1,
  counter: counter(),
  ...overrides,
});
const rawPrice = (overrides: Record<string, unknown> = {}) => ({
  id: '00000000-0000-4000-8000-0000000000e1',
  provider: 'ProviderCo',
  model_id: 'llm-small',
  model_ref_id: MODEL,
  currency: 'USD',
  effective_from: '2026-01-01T00:00:00.000Z',
  effective_until: null,
  input_per_million: '2.00000000',
  cached_per_million: '0.50000000',
  output_per_million: '8.00000000',
  cached_semantics: 'INCLUDED_IN_INPUT',
  reasoning_in_output: true,
  fx_rate_to_vnd: '25400.00000000',
  fx_source: 'Vietcombank',
  source_url: 'https://provider.example/pricing',
  verified: false,
  verified_by: null,
  ...overrides,
});
const rawModel = () => ({ id: MODEL, provider_id: B1, model_id: 'llm-small', model_version: '1', capabilities: {}, context_window: 8000, max_output: 1000, max_classification: 'INTERNAL', status: 'APPROVED', created_by: B1, created_at: '2026-10-01T00:00:00.000Z', version: 1 });
const rawReservation = (overrides: Record<string, unknown> = {}) => ({
  id: '00000000-0000-4000-8000-0000000000f1',
  request_id: '11111111-0000-4000-8000-000000000001',
  scope: [{ kind: 'TENANT', ref: null }],
  reserved_amount: '100000',
  currency: 'VND',
  status: 'PENDING_RECONCILE',
  expires_at: '2026-10-28T01:00:00.000Z',
  settled_amount: null,
  released_amount: null,
  settled_at: null,
  reconcile_note: 'TIMEOUT_NO_USAGE',
  created_at: '2026-10-28T00:00:00.000Z',
  version: 2,
  ...overrides,
});
const rawSpend = (overrides: Record<string, unknown> = {}) => ({
  budget: rawBudget(),
  as_of_day: '2026-10-28',
  current: { attempts: 1, input_total: '120000', cached_input: '100000', noncached_input: '20000', output_total: '10000', cost_vnd: '4318', pending_reconcile: 1 },
  periods: [counter()],
  ...overrides,
});

interface World {
  budgets: unknown[] | Error;
  prices: unknown[] | Error;
  models: unknown[] | Error;
  reservations: unknown[] | Error;
  spend: unknown | Error;
}
const normal = (): World => ({ budgets: [rawBudget(), rawBudget({ id: B2, scope_kind: 'UNIT', scope_ref_id: UNIT, limit_vnd: '600000', hard_stop: false, max_requests_per_day: 200, max_concurrent: 4, counter: null })], prices: [rawPrice()], models: [rawModel()], reservations: [rawReservation()], spend: rawSpend() });

function client(world: World, command: (operation: string, input: unknown) => unknown = () => ({}), pages?: (query: { status?: string; cursor?: string; limit?: number }) => unknown) {
  const h = harness((operation, input) => {
    if (operation === 'getAiSpendSummary') return world.spend;
    if (operation === 'get_resources_budget_reservation') {
      const query = (input as { query?: { status?: string; cursor?: string; limit?: number } }).query ?? {};
      if (pages !== undefined) return pages(query);
      if (world.reservations instanceof Error) return world.reservations;
      const rows = (world.reservations as Array<{ status: string }>).filter((row) => query.status === undefined || row.status === query.status);
      return { items: rows, next_cursor: null };
    }
    return new Error(`unexpected read ${operation}`);
  }, command);
  const readAll = vi.fn((operation: string) => {
    const result =
      operation === 'listAiBudgets' ? world.budgets : operation === 'listAiPricingVersions' ? world.prices : operation === 'listAiModels' ? world.models : new Error(`unexpected readAll ${operation}`);
    return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
  });
  (h.client as unknown as { readAll: typeof readAll }).readAll = readAll;
  return Object.assign(h, { readAll });
}

afterEach(cleanup);

describe('the pure rules of the finance screens (ST-LLM-003)', () => {
  it('reads a budget with its counter, a price, a reservation and a spend as the screens need them', () => {
    const budget = toBudget(rawBudget());
    expect(budget).toMatchObject({ scope: 'TENANT', limit: '1000000', hardStop: true, counter: { settled: '480000', held: '100000', available: '420000', requests: 7, blocked: false } });
    expect(toBudget(rawBudget({ counter: null }))?.counter).toBeNull();
    expect(toBudget(rawBudget({ scope_kind: 'TEAM' }))).toBeUndefined();
    expect(toPrice(rawPrice())).toMatchObject({ modelId: 'llm-small', cachedSemantics: 'INCLUDED_IN_INPUT', verified: false, effectiveUntil: null });
    expect(toPrice(rawPrice({ input_per_million: 'x' }))).toBeUndefined();
    expect(toReservation(rawReservation())).toMatchObject({ status: 'PENDING_RECONCILE', amount: '100000', note: 'TIMEOUT_NO_USAGE' });
    expect(toReservation(rawReservation({ status: 'GONE' }))).toBeUndefined();
    expect(toSpend(rawSpend())).toMatchObject({ attempts: 1, cachedInput: '100000', noncachedInput: '20000', costVnd: '4318', pendingReconcile: 1 });
    expect(toSpend({ budget: null })).toBeUndefined();
  });

  it('groups the digits of an amount without passing through a floating point number, so that 24 digits stay 24', () => {
    expect(groupDigits('9007199254740993')).toBe('9,007,199,254,740,993');
    expect(groupDigits('999999999999999999999999.00000000')).toBe('999,999,999,999,999,999,999,999');
    expect(groupDigits('0')).toBe('0');
    expect(groupDigits('-1500')).toBe('-1,500');
    expect(groupDigits('n/a')).toBe('n/a');
  });

  it('shows the share of the limit that is settled or held, and none for a budget that was not used', () => {
    expect(usedPercent(toBudget(rawBudget())?.counter ?? null, '1000000')).toBe(58);
    expect(usedPercent(null, '1000000')).toBe(0);
    expect(usedPercent(toBudget(rawBudget())?.counter ?? null, '0')).toBe(0);
  });

  it('checks a budget before it is sent: a reference for every scope but the tenant, a whole amount, a percentage, quotas and a date; and builds its body', () => {
    const ok = { ...EMPTY_BUDGET, limit: '1000000', effectiveFrom: '2026-10-01' };
    expect(validateBudget(ok)).toEqual({});
    expect(validateBudget({ ...ok, scope: 'UNIT' })).toEqual({ scopeRefId: 'required' });
    expect(validateBudget({ ...ok, scope: 'UNIT', scopeRefId: 'x' })).toEqual({ scopeRefId: 'invalidReference' });
    expect(validateBudget({ ...ok, limit: '' })).toEqual({ limit: 'required' });
    expect(validateBudget({ ...ok, limit: '-5' })).toEqual({ limit: 'invalidAmount' });
    expect(validateBudget({ ...ok, softThresholdPct: '0' })).toEqual({ softThresholdPct: 'invalidPercent' });
    expect(validateBudget({ ...ok, maxConcurrent: '0', maxRequestsPerDay: 'x' })).toEqual({ maxConcurrent: 'invalidNumber', maxRequestsPerDay: 'invalidNumber' });
    expect(validateBudget({ ...ok, maxConcurrent: '2147483648' })).toEqual({ maxConcurrent: 'invalidNumber' });
    expect(validateBudget({ ...ok, maxConcurrent: '2147483647' })).toEqual({});
    expect(validateBudget({ ...ok, effectiveFrom: '' })).toEqual({ effectiveFrom: 'invalidDate' });
    expect(budgetBody(ok)).toEqual({ scope_kind: 'TENANT', period: 'MONTH', limit_vnd: '1000000', soft_threshold_pct: 80, hard_stop: true, effective_from: '2026-10-01' });
    expect(budgetBody({ ...ok, scope: 'UNIT', scopeRefId: UNIT.toUpperCase(), hardStop: false, maxConcurrent: '4' })).toMatchObject({ scope_ref_id: UNIT, hard_stop: false, max_concurrent: 4 });
  });

  it('AC-ST-LLM-003-3: UAT-AC461 checks a price before it is sent: its source, a currency, rates and an exchange rate; and builds its body with the day in Viet Nam', () => {
    const ok = { ...EMPTY_PRICE, modelRefId: MODEL, provider: 'ProviderCo', inputPerMillion: '2.00', cachedPerMillion: '0.50', outputPerMillion: '8.00', effectiveFrom: '2026-10-01', sourceUrl: 'https://provider.example/pricing', fxRateToVnd: '25400', fxSource: 'Vietcombank' };
    expect(validatePrice(ok)).toEqual({});
    expect(validatePrice({ ...ok, sourceUrl: 'pricing page' })).toEqual({ sourceUrl: 'invalidSource' });
    expect(validatePrice({ ...ok, currency: 'usd' })).toEqual({ currency: 'invalidCurrency' });
    expect(validatePrice({ ...ok, inputPerMillion: '-1', outputPerMillion: '1.123456789' })).toEqual({ inputPerMillion: 'invalidRate', outputPerMillion: 'invalidRate' });
    expect(validatePrice({ ...ok, fxRateToVnd: '0' })).toEqual({ fxRateToVnd: 'invalidFx' });
    expect(validatePrice({ ...ok, modelRefId: '', provider: '' })).toEqual({ modelRefId: 'required', provider: 'required' });
    expect(priceBody(ok, 'llm-small')).toMatchObject({ model_id: 'llm-small', model_ref_id: MODEL, effective_from: '2026-09-30T17:00:00.000Z', cached_semantics: 'INCLUDED_IN_INPUT', reasoning_in_output: true, fx_rate_to_vnd: '25400' });
  });

  it('puts the refusals of the finance commands in words', () => {
    expect(describeLlmProblem(failure(409, 'BUDGET_SCOPE_DUPLICATE')).reason).toBe('budgetDuplicate');
    expect(describeLlmProblem(failure(422, 'CHILD_EXCEEDS_PARENT')).reason).toBe('childExceeds');
    expect(describeLlmProblem(failure(409, 'PRICING_RANGE_OVERLAP')).reason).toBe('priceOverlap');
    expect(describeLlmProblem(failure(422, 'SOURCE_URL_REQUIRED')).reason).toBe('sourceRequired');
    expect(describeLlmProblem(failure(409, 'RESERVATION_NOT_ACTIVE')).reason).toBe('reservationState');
  });
});

describe('LLM-07 budgets and quotas (ST-LLM-003, LLM F3)', () => {
  it('AC-ST-LLM-003-1: UAT-AC18 shows for each budget its limit, what is settled, what is held and what is left, the quota, and what happens at the limit', async () => {
    mount(<BudgetsScreen route={BUDGETS} />, client(normal()), { permissions: FINOPS });
    const table = await screen.findByTestId('budget-table');
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows.length).toBe(2);
    expect(rows[0]?.textContent).toContain('1,000,000');
    expect(rows[0]?.textContent).toContain('480,000');
    expect(rows[0]?.textContent).toContain('100,000');
    expect(within(rows[0] as HTMLElement).getByTestId('budget-available').textContent).toContain('420,000');
    expect(within(rows[0] as HTMLElement).getByTestId('budget-available').textContent).toContain(fill(vi_['llm.budgets.used'], { percent: 58 }));
    expect(rows[0]?.textContent).toContain(vi_['llm.budgets.hardStop']);
    expect(rows[0]?.textContent).toContain(fill(vi_['llm.budgets.soft'], { percent: 80 }));
    // The unit budget has not been used this period, does not stop, and has quotas.
    expect(rows[1]?.textContent).toContain(vi_['llm.budgets.notUsed']);
    expect(rows[1]?.textContent).toContain(vi_['llm.budgets.needsApproval']);
    expect(rows[1]?.textContent).toContain(fill(vi_['llm.budgets.perDay'], { count: 200 }));
    expect(rows[1]?.textContent).toContain(fill(vi_['llm.budgets.concurrent'], { count: 4 }));
    expect(within(rows[1] as HTMLElement).getByRole('link', { name: vi_['llm.budgets.usage'] }).getAttribute('href')).toBe(`/llm/llm-09?budget=${B2}`);
  });

  it('says that a scope is blocked after an actual cost went over its hold', async () => {
    const world = { ...normal(), budgets: [rawBudget({ counter: counter({ blocked: true, exception_count: 1 }) })] };
    mount(<BudgetsScreen route={BUDGETS} />, client(world), { permissions: FINOPS });
    expect((await screen.findByTestId('budget-blocked')).textContent).toContain(vi_['llm.budgets.blocked']);
    expect(screen.getByTestId('budget-table').querySelector('tr[data-blocked="true"]')).not.toBeNull();
  });

  it('begins its forms on the day in Viet Nam, also in the first seven hours of it when UTC is still yesterday', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-27T18:00:00.000Z'));
    try {
      mount(<BudgetsScreen route={BUDGETS} />, client(normal()), { permissions: FINOPS });
      const form = await screen.findByRole('form', { name: vi_['llm.budgets.form.title'] });
      expect((within(form).getByLabelText(vi_['llm.budgets.form.from']) as HTMLInputElement).value).toBe('2026-10-28');
      cleanup();
      mount(<PricesScreen route={PRICES} />, client(normal()), { permissions: FINOPS });
      const prices = await screen.findByRole('form', { name: vi_['llm.prices.form.title'] });
      expect((within(prices).getByLabelText(vi_['llm.prices.form.from']) as HTMLInputElement).value).toBe('2026-10-28');
    } finally {
      vi.useRealTimers();
    }
  });

  it('checks the form before sending, and creates a budget for a unit that does not stop', async () => {
    const user = userEvent.setup();
    const h = client(normal(), () => ({ status: 'ACTIVE' }));
    mount(<BudgetsScreen route={BUDGETS} />, h, { permissions: FINOPS });
    const form = await screen.findByRole('form', { name: vi_['llm.budgets.form.title'] });
    await user.selectOptions(within(form).getByLabelText(vi_['llm.budgets.form.scope']), 'UNIT');
    await user.type(within(form).getByLabelText(vi_['llm.budgets.form.limit']), '500000');
    await user.click(within(form).getByRole('button', { name: vi_['llm.budgets.form.submit'] }));
    expect(await within(form).findByText(vi_['llm.problem.required'])).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
    await user.type(within(form).getByLabelText(vi_['llm.budgets.form.ref']), UNIT);
    await user.click(within(form).getByLabelText(vi_['llm.budgets.form.hardStop']));
    fireEvent.change(within(form).getByLabelText(vi_['llm.budgets.form.from']), { target: { value: '2026-11-01' } });
    await user.click(within(form).getByRole('button', { name: vi_['llm.budgets.form.submit'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(h.command.mock.calls[0]).toMatchObject(['createAiBudget', { body: { scope_kind: 'UNIT', scope_ref_id: UNIT, period: 'MONTH', limit_vnd: '500000', soft_threshold_pct: 80, hard_stop: false, effective_from: '2026-11-01' } }]);
    expect(await screen.findByTestId('budget-saved')).toBeTruthy();
  });

  it.each([
    ['BUDGET_SCOPE_DUPLICATE', 409, 'llm.reason.budgetDuplicate'],
    ['CHILD_EXCEEDS_PARENT', 422, 'llm.reason.childExceeds'],
  ] as const)('puts the refusal %s in words', async (code, status, key) => {
    const user = userEvent.setup();
    mount(<BudgetsScreen route={BUDGETS} />, client(normal(), () => failure(status, code)), { permissions: FINOPS });
    const form = await screen.findByRole('form', { name: vi_['llm.budgets.form.title'] });
    await user.type(within(form).getByLabelText(vi_['llm.budgets.form.limit']), '500000');
    await user.click(within(form).getByRole('button', { name: vi_['llm.budgets.form.submit'] }));
    expect((await screen.findByTestId('budget-refused')).textContent).toBe(vi_[key]);
  });

  it('offers no form to who cannot manage the money', async () => {
    mount(<BudgetsScreen route={BUDGETS} />, client(normal()), { permissions: ['budget_reservation.read'] });
    await screen.findByTestId('budget-table');
    expect(screen.queryByRole('form', { name: vi_['llm.budgets.form.title'] })).toBeNull();
  });

  describe('the standard states', () => {
    it.each([
      ['denied', { ...normal(), budgets: failure(403, 'SCOPE_DENIED') }, vi_['states.denied.title']],
      ['offline', { ...normal(), budgets: new ApiError({ status: 0, code: NETWORK_ERROR_CODE, correlationId: 'c' }) }, vi_['states.offline.title']],
      ['error', { ...normal(), budgets: failure(500, 'INTERNAL_ERROR') }, vi_['states.error.title']],
      ['signed out', { ...normal(), budgets: failure(401, 'SESSION_EXPIRED') }, vi_['states.signedOut.title']],
    ] as Array<[string, World, string]>)('UI-LLM-07 shows the %s state', async (_name, world, text) => {
      mount(<BudgetsScreen route={BUDGETS} />, client(world), { permissions: FINOPS });
      expect((await screen.findAllByText(text)).length).toBeGreaterThan(0);
    });

    it('UI-LLM-07 says that there is no budget, and still offers to create the first', async () => {
      mount(<BudgetsScreen route={BUDGETS} />, client({ ...normal(), budgets: [] }), { permissions: FINOPS });
      expect((await screen.findByTestId('budgets-none')).textContent).toBe(vi_['llm.budgets.none']);
      expect(screen.getByRole('form', { name: vi_['llm.budgets.form.title'] })).toBeTruthy();
    });

    it('UI-LLM-07 shows the loading state first and names the page', () => {
      const h = harness(() => new Error('unexpected'));
      (h.client as unknown as { readAll: unknown }).readAll = vi.fn(() => new Promise(() => undefined));
      mount(<BudgetsScreen route={BUDGETS} />, h, { permissions: FINOPS });
      expect(screen.getByRole('status', { name: vi_['states.loading.label'] })).toBeTruthy();
      expect(screen.getByRole('region', { name: vi_['llm.budgets.page.title'] })).toBeTruthy();
    });
  });
});

describe('LLM-08 prices and exchange rates (ST-LLM-003, LLM BR-LLM-13)', () => {
  it('AC-ST-LLM-003-3: UAT-AC461 lists the price versions with the rates, the cached semantics, the rate to dong, the period, the source, and says that a price nobody verified is not verified', async () => {
    const world = { ...normal(), prices: [rawPrice({ effective_from: '2026-07-01T00:00:00.000Z', input_per_million: '3.00000000' }), rawPrice({ id: '00000000-0000-4000-8000-0000000000e2', effective_until: '2026-07-01T00:00:00.000Z', verified: true, cached_semantics: 'SEPARATE' })] };
    mount(<PricesScreen route={PRICES} />, client(world), { permissions: FINOPS });
    const table = await screen.findByTestId('price-table');
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows[0]?.textContent).toContain('3.00000000 USD');
    expect(rows[0]?.textContent).toContain(vi_['llm.cached.included']);
    expect(rows[0]?.textContent).toContain('25400.00000000');
    expect(rows[0]?.textContent).toContain(`2026-07-01 → ${vi_['llm.prices.open']}`);
    expect(within(rows[0] as HTMLElement).getByTestId('price-state').textContent).toBe(vi_['llm.prices.inForce']);
    expect(within(rows[0] as HTMLElement).getByTestId('price-verified').getAttribute('data-verified')).toBe('false');
    expect(within(rows[0] as HTMLElement).getByRole('link', { name: 'https://provider.example/pricing' }).getAttribute('rel')).toContain('noopener');
    expect(rows[1]?.textContent).toContain(vi_['llm.cached.separate']);
    expect(rows[1]?.textContent).toContain('2026-01-01 → 2026-07-01');
    expect(within(rows[1] as HTMLElement).getByTestId('price-state').textContent).toBe(vi_['llm.prices.ended']);
    expect(within(rows[1] as HTMLElement).getByTestId('price-verified').getAttribute('data-verified')).toBe('true');
    expect(screen.getByTestId('prices-note').textContent).toBe(vi_['llm.prices.note']);
  });

  it('tells the version charged now from one that waits for its day and one that has ended, by both ends of its period', async () => {
    const world = {
      ...normal(),
      prices: [
        rawPrice({ id: '00000000-0000-4000-8000-0000000000e3', effective_from: '2999-01-01T00:00:00.000Z', input_per_million: '9.00000000' }),
        rawPrice({ id: '00000000-0000-4000-8000-0000000000e4', effective_from: '2026-01-01T00:00:00.000Z', effective_until: '2999-01-01T00:00:00.000Z' }),
        rawPrice({ id: '00000000-0000-4000-8000-0000000000e5', effective_from: '2025-01-01T00:00:00.000Z', effective_until: '2026-01-01T00:00:00.000Z' }),
      ],
    };
    mount(<PricesScreen route={PRICES} />, client(world), { permissions: FINOPS });
    const rows = within(await screen.findByTestId('price-table')).getAllByRole('row').slice(1);
    expect(rows.map((row) => row.getAttribute('data-state'))).toEqual(['scheduled', 'inForce', 'ended']);
    expect(within(rows[0] as HTMLElement).getByTestId('price-state').textContent).toBe(vi_['llm.prices.scheduled']);
    // The one with an end in the future is the one charged now, and the one that has not begun is not.
    expect(within(rows[1] as HTMLElement).getByTestId('price-state').textContent).toBe(vi_['llm.prices.inForce']);
    expect(rows[1]?.textContent).toContain('2026-01-01 → 2999-01-01');
  });

  it('shows the days of a price in Viet Nam time: a version made for the 28th at midnight there is the 28th', async () => {
    const world = { ...normal(), prices: [rawPrice({ effective_from: '2026-10-27T17:00:00.000Z' }), rawPrice({ id: '00000000-0000-4000-8000-0000000000e2', effective_from: '2026-01-01T00:00:00.000Z', effective_until: '2026-10-27T17:00:00.000Z' })] };
    mount(<PricesScreen route={PRICES} />, client(world), { permissions: FINOPS });
    const rows = within(await screen.findByTestId('price-table')).getAllByRole('row').slice(1);
    expect(rows[0]?.textContent).toContain('2026-10-28 →');
    expect(rows[1]?.textContent).toContain('2026-01-01 → 2026-10-28');
  });

  it('AC-ST-LLM-003-3: UAT-AC461 checks the source of a price before it is sent, and registers a version for the model chosen', async () => {
    const user = userEvent.setup();
    const h = client(normal(), () => ({ status: 'IN_FORCE' }));
    mount(<PricesScreen route={PRICES} />, h, { permissions: FINOPS });
    const form = await screen.findByRole('form', { name: vi_['llm.prices.form.title'] });
    await user.type(within(form).getByLabelText(vi_['llm.prices.form.provider']), 'ProviderCo');
    await user.type(within(form).getByLabelText(vi_['llm.prices.form.input']), '2.00');
    await user.type(within(form).getByLabelText(vi_['llm.prices.form.cached']), '0.50');
    await user.type(within(form).getByLabelText(vi_['llm.prices.form.output']), '8.00');
    await user.type(within(form).getByLabelText(vi_['llm.prices.form.fx']), '25400');
    await user.type(within(form).getByLabelText(vi_['llm.prices.form.fxSource']), 'Vietcombank');
    fireEvent.change(within(form).getByLabelText(vi_['llm.prices.form.from']), { target: { value: '2026-11-01' } });
    await user.click(within(form).getByRole('button', { name: vi_['llm.prices.form.submit'] }));
    expect(await within(form).findByText(vi_['llm.problem.invalidSource'])).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
    await user.type(within(form).getByLabelText(vi_['llm.prices.form.source']), 'https://provider.example/pricing');
    await user.selectOptions(within(form).getByLabelText(vi_['llm.prices.form.semantics']), 'SEPARATE');
    await user.click(within(form).getByRole('button', { name: vi_['llm.prices.form.submit'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(h.command.mock.calls[0]).toMatchObject([
      'registerPricingVersion',
      { body: { provider: 'ProviderCo', model_id: 'llm-small', model_ref_id: MODEL, currency: 'USD', input_per_million: '2.00', cached_per_million: '0.50', output_per_million: '8.00', cached_semantics: 'SEPARATE', fx_rate_to_vnd: '25400', source_url: 'https://provider.example/pricing' } },
    ]);
    expect(await screen.findByTestId('price-saved')).toBeTruthy();
  });

  it.each([
    ['PRICING_RANGE_OVERLAP', 409, 'llm.reason.priceOverlap'],
    ['SOURCE_URL_REQUIRED', 422, 'llm.reason.sourceRequired'],
  ] as const)('puts the refusal %s in words', async (code, status, key) => {
    const user = userEvent.setup();
    mount(<PricesScreen route={PRICES} />, client(normal(), () => failure(status, code)), { permissions: FINOPS });
    const form = await screen.findByRole('form', { name: vi_['llm.prices.form.title'] });
    await user.type(within(form).getByLabelText(vi_['llm.prices.form.provider']), 'ProviderCo');
    await user.type(within(form).getByLabelText(vi_['llm.prices.form.input']), '2');
    await user.type(within(form).getByLabelText(vi_['llm.prices.form.cached']), '1');
    await user.type(within(form).getByLabelText(vi_['llm.prices.form.output']), '4');
    await user.type(within(form).getByLabelText(vi_['llm.prices.form.fx']), '25000');
    await user.type(within(form).getByLabelText(vi_['llm.prices.form.fxSource']), 'Vietcombank');
    await user.type(within(form).getByLabelText(vi_['llm.prices.form.source']), 'https://provider.example/pricing');
    await user.click(within(form).getByRole('button', { name: vi_['llm.prices.form.submit'] }));
    expect((await screen.findByTestId('price-refused')).textContent).toBe(vi_[key]);
  });

  it('says that the right to read the models is missing when the catalogue is refused, and keeps the form from sending', async () => {
    mount(<PricesScreen route={PRICES} />, client({ ...normal(), models: failure(403, 'SCOPE_DENIED') }), { permissions: FINOPS });
    const form = await screen.findByRole('form', { name: vi_['llm.prices.form.title'] });
    expect(within(form).getByTestId('price-models-failed').textContent).toBe(vi_['llm.prices.form.modelsDenied']);
    expect((within(form).getByRole('button', { name: vi_['llm.prices.form.submit'] }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('says that the model catalogue could not be loaded and keeps the form from sending', async () => {
    mount(<PricesScreen route={PRICES} />, client({ ...normal(), models: failure(500, 'INTERNAL_ERROR') }), { permissions: FINOPS });
    const form = await screen.findByRole('form', { name: vi_['llm.prices.form.title'] });
    expect(within(form).getByTestId('price-models-failed').textContent).toBe(vi_['llm.prices.form.modelsFailed']);
    expect((within(form).getByRole('button', { name: vi_['llm.prices.form.submit'] }) as HTMLButtonElement).disabled).toBe(true);
  });

  describe('the standard states', () => {
    it.each([
      ['denied', { ...normal(), prices: failure(403, 'SCOPE_DENIED') }, vi_['states.denied.title']],
      ['offline', { ...normal(), prices: new ApiError({ status: 0, code: NETWORK_ERROR_CODE, correlationId: 'c' }) }, vi_['states.offline.title']],
      ['error', { ...normal(), prices: failure(500, 'INTERNAL_ERROR') }, vi_['states.error.title']],
      ['signed out', { ...normal(), prices: failure(401, 'SESSION_EXPIRED') }, vi_['states.signedOut.title']],
    ] as Array<[string, World, string]>)('UI-LLM-08 shows the %s state', async (_name, world, text) => {
      mount(<PricesScreen route={PRICES} />, client(world), { permissions: FINOPS });
      expect((await screen.findAllByText(text)).length).toBeGreaterThan(0);
    });

    it('UI-LLM-08 says that there is no price version, and still offers to register the first', async () => {
      mount(<PricesScreen route={PRICES} />, client({ ...normal(), prices: [] }), { permissions: FINOPS });
      expect((await screen.findByTestId('prices-none')).textContent).toBe(vi_['llm.prices.none']);
      expect(screen.getByRole('form', { name: vi_['llm.prices.form.title'] })).toBeTruthy();
    });

    it('UI-LLM-08 shows the loading state first and names the page', () => {
      const h = harness(() => new Error('unexpected'));
      (h.client as unknown as { readAll: unknown }).readAll = vi.fn(() => new Promise(() => undefined));
      mount(<PricesScreen route={PRICES} />, h, { permissions: FINOPS });
      expect(screen.getByRole('status', { name: vi_['states.loading.label'] })).toBeTruthy();
      expect(screen.getByRole('region', { name: vi_['llm.prices.page.title'] })).toBeTruthy();
    });
  });
});

describe('LLM-09 usage and reconciliation (ST-LLM-003, LLM F3, BR-LLM-06)', () => {
  it('AC-ST-LLM-003-1: UAT-AC461 shows the period of a budget, the tokens with the cached and the uncached input apart, the cost, and the reservations that wait for the reconciliation', async () => {
    mount(<UsageScreen route={USAGE} />, client(normal()), { permissions: FINOPS });
    const counterBox = await screen.findByTestId('usage-counter');
    expect(counterBox.textContent).toContain('1,000,000');
    expect(counterBox.textContent).toContain('480,000');
    expect(counterBox.textContent).toContain('420,000');
    expect(counterBox.textContent).toContain(fill(vi_['llm.usage.percent'], { percent: 58 }));
    const tokens = screen.getByTestId('usage-tokens');
    expect(within(tokens).getAllByRole('row')[1]?.textContent).toBe('1' + '120,000' + '100,000' + '20,000' + '10,000' + '4,318');
    expect(screen.getByTestId('usage-pending').textContent).toBe(fill(vi_['llm.usage.pending'], { count: 1 }));
    const reservations = screen.getByTestId('waiting-table');
    const row = within(reservations).getAllByRole('row')[1] as HTMLElement;
    expect(row.getAttribute('data-status')).toBe('PENDING_RECONCILE');
    expect(row.textContent).toContain(vi_['llm.reservation.pending']);
    expect(row.textContent).toContain('TIMEOUT_NO_USAGE');
    expect(row.textContent).toContain('100,000');
  });

  it('reads the spend of the budget chosen in the address, and again of another when it is changed', async () => {
    const user = userEvent.setup();
    const h = client(normal());
    mount(<UsageScreen route={USAGE} />, h, { permissions: FINOPS }, `/llm/llm-09?budget=${B2}`);
    await screen.findByTestId('usage-counter');
    await waitFor(() => expect(h.read.mock.calls.filter((call) => call[0] === 'getAiSpendSummary').map((call) => (call[1] as { path: { id: string } }).path.id)).toContain(B2));
    await user.selectOptions(screen.getByLabelText(vi_['llm.usage.budget']), B1);
    await waitFor(() => expect(h.read.mock.calls.filter((call) => call[0] === 'getAiSpendSummary').map((call) => (call[1] as { path: { id: string } }).path.id)).toContain(B1));
  });

  it('shows the limit and the use as a strip of seven KPI tiles under a card that names the unit, and the scope and the period in the context bar', async () => {
    mount(<UsageScreen route={USAGE} />, client(normal()), { permissions: FINOPS });
    const counterBox = await screen.findByTestId('usage-counter');
    const strip = within(counterBox).getByRole('group', { name: 'Hạn mức và mức đã dùng của ngân sách' });
    expect(within(strip).getAllByRole('article')).toHaveLength(7);
    expect(within(counterBox).getByText('ĐVT: Đồng')).toBeTruthy();
    const bar = screen.getByRole('group', { name: vi_['ui.contextBar.label'] });
    expect(within(bar).getByText('Phạm vi ngân sách')).toBeTruthy();
    expect(within(bar).getByText('Chu kỳ')).toBeTruthy();
  });

  it('offers the reconciliation of a budget only the reservations that are held against it, and starts over when another budget is chosen', async () => {
    const first = '00000000-0000-4000-8000-0000000000f1';
    const second = '00000000-0000-4000-8000-0000000000f2';
    const world = { ...normal(), reservations: [rawReservation({ id: first, budget_ids: [B1] }), rawReservation({ id: second, budget_ids: [B2] })] };
    mount(<UsageScreen route={USAGE} />, client(world), { permissions: FINOPS }, `/llm/llm-09?budget=${B1}`);
    await screen.findByTestId('reconcile-form');
    expect(screen.queryByTestId(`reserve-${first}`)).not.toBeNull();
    expect(screen.queryByTestId(`reserve-${second}`)).toBeNull();
    cleanup();
    mount(<UsageScreen route={USAGE} />, client(world), { permissions: FINOPS }, `/llm/llm-09?budget=${B2}`);
    await screen.findByTestId('reconcile-form');
    expect(screen.queryByTestId(`reserve-${first}`)).toBeNull();
    expect(screen.queryByTestId(`reserve-${second}`)).not.toBeNull();
    expect(toReservation(rawReservation({ budget_ids: [B1, B2] }))?.budgetIds).toEqual([B1, B2]);
    expect(toReservation(rawReservation())?.budgetIds).toEqual([]);
  });

  it('does not show a pending notice when nothing waits, and says that nothing is held when there is no reservation', async () => {
    const world = { ...normal(), reservations: [], spend: rawSpend({ current: { attempts: 0, input_total: '0', cached_input: '0', noncached_input: '0', output_total: '0', cost_vnd: '0', pending_reconcile: 0 } }) };
    mount(<UsageScreen route={USAGE} />, client(world), { permissions: FINOPS });
    await screen.findByTestId('usage-counter');
    expect(screen.queryByTestId('usage-pending')).toBeNull();
    expect(screen.getByTestId('reservations-none').textContent).toBe(vi_['llm.usage.reservations.none']);
    expect(screen.getByTestId('waiting-none').textContent).toBe(vi_['llm.usage.reservations.waitingNone']);
  });

  it('reads the reservations a page at a time, asks for the next page only when the person does, and keeps those that wait apart', async () => {
    const user = userEvent.setup();
    const calls: Array<{ status?: string; cursor?: string; limit?: number }> = [];
    const h = client(
      normal(),
      () => ({}),
      (query) => {
        calls.push(query);
        if (query.status === 'PENDING_RECONCILE') return { items: [rawReservation()], next_cursor: null };
        if (query.cursor === undefined) return { items: [rawReservation({ id: '00000000-0000-4000-8000-0000000000a1', status: 'SETTLED', settled_amount: '90000', released_amount: '10000', reconcile_note: null })], next_cursor: 'page-2' };
        return { items: [rawReservation({ id: '00000000-0000-4000-8000-0000000000a2', status: 'RELEASED', reconcile_note: 'cancelled' })], next_cursor: null };
      },
    );
    mount(<UsageScreen route={USAGE} />, h, { permissions: FINOPS });
    const recent = await screen.findByTestId('reservation-table');
    expect(within(recent).getAllByRole('row').length).toBe(2);
    expect(calls.every((query) => query.limit === 50)).toBe(true);
    expect(calls.filter((query) => query.cursor !== undefined).length).toBe(0);
    await user.click(screen.getByRole('button', { name: vi_['llm.usage.reservations.more'] }));
    await waitFor(() => expect(within(screen.getByTestId('reservation-table')).getAllByRole('row').length).toBe(3));
    expect(calls.find((query) => query.cursor !== undefined)).toMatchObject({ cursor: 'page-2' });
    expect(screen.queryByRole('button', { name: vi_['llm.usage.reservations.more'] })).toBeNull();
    expect(within(screen.getByTestId('waiting-table')).getAllByRole('row').length).toBe(2);
  });

  it('tells beside the list that it could not be loaded and keeps the budget in view', async () => {
    mount(<UsageScreen route={USAGE} />, client({ ...normal(), reservations: failure(500, 'INTERNAL_ERROR') }), { permissions: FINOPS });
    expect(await screen.findByTestId('usage-counter')).toBeTruthy();
    expect(await screen.findByTestId('reservation-table-failed')).toBeTruthy();
    expect(screen.getByTestId('waiting-table-failed')).toBeTruthy();
  });

  describe('the standard states', () => {
    it.each([
      ['denied', { ...normal(), budgets: failure(403, 'SCOPE_DENIED') }, vi_['states.denied.title']],
      ['offline', { ...normal(), budgets: new ApiError({ status: 0, code: NETWORK_ERROR_CODE, correlationId: 'c' }) }, vi_['states.offline.title']],
      ['error', { ...normal(), spend: failure(500, 'INTERNAL_ERROR') }, vi_['states.error.title']],
      ['signed out', { ...normal(), budgets: failure(401, 'SESSION_EXPIRED') }, vi_['states.signedOut.title']],
    ] as Array<[string, World, string]>)('UI-LLM-09 shows the %s state', async (_name, world, text) => {
      mount(<UsageScreen route={USAGE} />, client(world), { permissions: FINOPS });
      expect((await screen.findAllByText(text)).length).toBeGreaterThan(0);
    });

    it('UI-LLM-09 says that there is no budget to see', async () => {
      mount(<UsageScreen route={USAGE} />, client({ ...normal(), budgets: [] }), { permissions: FINOPS });
      expect((await screen.findByTestId('usage-none')).textContent).toBe(vi_['llm.usage.none']);
    });

    it('UI-LLM-09 shows the loading state first and names the page', () => {
      const h = harness(() => new Error('unexpected'));
      (h.client as unknown as { readAll: unknown }).readAll = vi.fn(() => new Promise(() => undefined));
      mount(<UsageScreen route={USAGE} />, h, { permissions: FINOPS });
      expect(screen.getByRole('status', { name: vi_['states.loading.label'] })).toBeTruthy();
      expect(screen.getByRole('region', { name: vi_['llm.usage.page.title'] })).toBeTruthy();
    });
  });
});
