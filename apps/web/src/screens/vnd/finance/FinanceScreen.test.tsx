import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { translator } from '../../../i18n';
import base from '../../../i18n/vi.json';
import FinanceScreen from './FinanceScreen';
import { AS_OF, DOCUMENT, client, mount, policy, routeOf, uuid } from '../shared/test/vnd-test-support';
import type { World } from '../shared/test/vnd-test-support';

const word = (key: string): string => (base as Record<string, string>)[key] ?? key;
const text = (key: string, params: Record<string, string | number> = {}): string => Object.entries(params).reduce((value, [name, replacement]) => value.replace(`{${name}}`, String(replacement)), word(key));
const route = routeOf('VND-08', 'FR-VND-08');
const CONTRACTOR = uuid('0001', 1);
const PACKAGE = uuid('0030', 1);
const ME = 'membership-1';
const ADMIN = ['vnd.read', 'vnd.finance.write', 'vnd.finance.verify'];

afterEach(() => {
  cleanup();
  translator.setLocale('vi');
});

const escaped = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, (char) => `\\${char}`);
const type = (scope: HTMLElement, label: string, value: string): void => {
  fireEvent.change(within(scope).getByLabelText(new RegExp(escaped(label))), { target: { value } });
};
const dialog = (name: string): HTMLElement => screen.getByRole('dialog', { name });

const period = (n: number, over: Record<string, unknown> = {}) => ({
  id: uuid('0060', n),
  fiscal_year: 2026 - n,
  revenue: 1000000,
  total_assets: 2000000,
  current_assets: 1200000,
  current_liabilities: 800000,
  total_debt: 900000,
  equity: 1100000,
  ebit: 300000,
  interest_expense: 100000,
  document_id: DOCUMENT,
  verified: true,
  verified_by: uuid('0020', 2),
  verified_at: '2026-11-02T03:00:00.000Z',
  created_by: uuid('0020', 3),
  version: 2,
  ratios: { current_ratio: 1.5, debt_to_assets_pct: 45, interest_cover: 3, equity_to_assets_pct: 55 },
  ...over,
});

const finance = (over: Record<string, unknown> = {}) => ({
  contractor_id: CONTRACTOR,
  periods: [period(1), period(2, { verified: false, verified_by: null, verified_at: null, version: 1 })],
  overall: 'BELOW',
  verified_years: 1,
  average_revenue: 1000000,
  required_revenue: 2400000,
  results: [
    { test: 'CURRENT_RATIO', status: 'PASS', value: 1.5, threshold: 1, year: 2025 },
    { test: 'DEBT_TO_ASSETS', status: 'PASS', value: 45, threshold: 80, year: 2025 },
    { test: 'INTEREST_COVER', status: 'PASS', value: 3, threshold: 1.5, year: 2025 },
    { test: 'AVERAGE_REVENUE', status: 'FAIL', value: 1000000, threshold: 2400000, year: null },
  ],
  requirement: { package_id: PACKAGE, package_value: 1200000, duration_months: 12, value_from: 'ESTIMATED_VALUE' },
  policy: policy('VENDOR_FINANCE'),
  as_of: AS_OF,
  ...over,
});

const capacity = (over: Record<string, unknown> = {}) => ({
  contractor_id: CONTRACTOR,
  facts: { open_contract_value: 600000, open_contract_count: 1, late_contract_count: 3, pending_award_value: 700000, pending_award_count: 1, average_annual_revenue: 500000 },
  load: 1300000,
  load_multiple: 2.6,
  limit_multiple: 3,
  signals: ['LATE_CONTRACTS'],
  status: 'OVER',
  capacity_policy: policy('VENDOR_CAPACITY'),
  finance_policy: policy('VENDOR_FINANCE'),
  as_of: AS_OF,
  ...over,
});

interface Options {
  permissions?: string[];
  mode?: 'FULL' | 'READ_ONLY';
  path?: string;
  answers?: Record<string, unknown>;
  failing?: World['failing'];
}

function open(options: Options = {}) {
  const world: World = { answers: { getVendorFinance: finance(), getVendorCapacity: capacity(), ...options.answers }, ...(options.failing === undefined ? {} : { failing: options.failing }) };
  const h = client(world);
  mount(<FinanceScreen route={route} />, h, { permissions: options.permissions ?? ADMIN, path: options.path ?? `/vnd/vnd-08?contractor=${CONTRACTOR}&package=${PACKAGE}`, ...(options.mode === undefined ? {} : { mode: options.mode }) });
  return { h };
}

const loaded = async (): Promise<void> => {
  await screen.findAllByText(word('vnd.finance.test.currentRatio.name'));
};

describe('FinanceScreen (VND-08): the finance and the load of a contractor', () => {
  it('asks for a contractor when the address names none', () => {
    open({ path: '/vnd/vnd-08' });
    const picker = screen.getByTestId('contractor-picker');
    expect((within(picker).getByRole('button', { name: word('vnd.finance.pick.action') }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('pick-empty').textContent).toBe(word('vnd.finance.pick.empty.text'));
  });

  it('reads the finance with the package named and shows the ratios against the lines, each with the "i" of its rule', async () => {
    const { h } = open();
    await loaded();
    expect(h.read).toHaveBeenCalledWith('getVendorFinance', { path: { id: CONTRACTOR }, query: { package_id: PACKAGE } });
    expect(screen.getByTestId('finance-overall').textContent).toContain(word('vnd.finance.overall.below.name'));
    expect(screen.getByTestId('finance-overall').textContent).toContain(text('vnd.finance.judgment.years.text', { years: 1 }));
    const revenue = document.querySelector('tr[data-test=AVERAGE_REVENUE]') as HTMLElement;
    expect(revenue.textContent).toContain(word('vnd.finance.status.fail.name'));
    expect(revenue.textContent).toContain('2.400.000');
    expect(within(revenue).getByRole('button', { name: text('vnd.info.open.label', { name: word('vnd.finance.test.averageRevenue.name') }) })).toBeTruthy();
    fireEvent.click(within(revenue).getByRole('button', { name: text('vnd.info.open.label', { name: word('vnd.finance.test.averageRevenue.name') }) }));
    const panel = screen.getByRole('dialog', { name: word('vnd.finance.test.averageRevenue.name') });
    expect(panel.querySelector('[data-field=formula] dd')?.textContent).toBe('Formula of VENDOR_FINANCE');
    expect(panel.querySelector('[data-field=unverified]')).toBeTruthy();
    expect(screen.getByText(text('vnd.finance.judgment.requirement.text', { value: '1.200.000', months: 12 }))).toBeTruthy();
  });

  it('shows too little data as such and never as a pass', async () => {
    open({ answers: { getVendorFinance: finance({ periods: [], overall: 'INSUFFICIENT_DATA', verified_years: 0, average_revenue: null, required_revenue: null, requirement: null, results: [{ test: 'CURRENT_RATIO', status: 'NO_DATA', value: null, threshold: null, year: null }] }) } });
    await loaded();
    expect(screen.getByTestId('finance-overall').textContent).toContain(word('vnd.finance.overall.insufficientData.name'));
    expect(screen.getByTestId('periods-empty').textContent).toBe(word('vnd.finance.periods.empty.text'));
    expect(document.querySelector('tr[data-test=CURRENT_RATIO]')?.textContent).toContain(word('vnd.finance.status.noData.name'));
  });

  it('lists the years with their ratios and who verified them, and offers the verification only on a year another person entered', async () => {
    const { h } = open({ answers: { getVendorFinance: finance({ periods: [period(1), period(2, { verified: false, verified_by: null, verified_at: null, version: 1 }), period(3, { verified: false, verified_by: null, verified_at: null, created_by: ME })] }) } });
    await loaded();
    const rows = Array.from(document.querySelectorAll<HTMLElement>('tr[data-period-id]'));
    expect(rows[0]?.textContent).toContain(word('vnd.finance.verified.yes'));
    expect(rows[1]?.textContent).toContain(word('vnd.finance.verified.no'));
    expect(within(rows[0] as HTMLElement).queryByTestId('verify-period')).toBeNull();
    expect(within(rows[1] as HTMLElement).getByTestId('verify-period')).toBeTruthy();
    fireEvent.click(within(rows[1] as HTMLElement).getByTestId('verify-period'));
    const form = dialog(word('vnd.finance.verify.title'));
    fireEvent.click(within(form).getByRole('button', { name: word('vnd.finance.verify.confirm') }));
    await waitFor(() => expect(h.command).toHaveBeenCalledWith('verifyVendorFinancialPeriod', { path: { id: uuid('0060', 2) }, ifMatchVersion: 1, attempt: { key: expect.any(String) } }));
    expect((await screen.findByTestId('receipt')).textContent).toContain(word('vnd.finance.verify.title'));
  });

  it('enters a year in whole dong and keeps the button off while a figure is not one', async () => {
    const { h } = open();
    await loaded();
    fireEvent.click(screen.getByTestId('record-period'));
    const form = dialog(word('vnd.finance.record.title'));
    const send = within(form).getByRole('button', { name: word('vnd.finance.record.confirm') }) as HTMLButtonElement;
    type(form, word('vnd.finance.field.year.label'), '2025');
    const figures: Array<[string, string]> = [
      ['vnd.finance.field.revenue.label', '1000000'],
      ['vnd.finance.field.totalAssets.label', '2000000'],
      ['vnd.finance.field.currentAssets.label', '1200000'],
      ['vnd.finance.field.currentLiabilities.label', '800000'],
      ['vnd.finance.field.totalDebt.label', '900000'],
      ['vnd.finance.field.equity.label', '-5'],
      ['vnd.finance.field.ebit.label', '300000'],
      ['vnd.finance.field.interestExpense.label', '12,5'],
    ];
    for (const [key, value] of figures) type(form, word(key), value);
    expect(send.disabled).toBe(true);
    type(form, word('vnd.finance.field.interestExpense.label'), '100000');
    type(form, word('vnd.finance.field.document.label'), DOCUMENT);
    expect(send.disabled).toBe(false);
    fireEvent.click(send);
    await waitFor(() =>
      expect(h.command).toHaveBeenCalledWith('recordVendorFinancialPeriod', {
        path: { id: CONTRACTOR },
        body: { fiscal_year: 2025, revenue: 1000000, total_assets: 2000000, current_assets: 1200000, current_liabilities: 800000, total_debt: 900000, equity: -5, ebit: 300000, interest_expense: 100000, document_id: DOCUMENT }, attempt: { key: expect.any(String) },
      }),
    );
  });

  it('shows the load with its facts, each with the "i", the status and the signals', async () => {
    open();
    await loaded();
    const status = await screen.findByTestId('capacity-status');
    expect(status.textContent).toContain(word('vnd.finance.capacityStatus.over.name'));
    expect(status.textContent).toContain(text('vnd.finance.capacity.rule.text', { limit: 3 }));
    const facts = screen.getByTestId('capacity-facts');
    expect(facts.textContent).toContain('600.000 (1)');
    expect(facts.textContent).toContain('700.000 (1)');
    expect(within(facts).getAllByRole('button').length).toBe(6);
    expect(screen.getByTestId('capacity-signals').textContent).toContain(word('vnd.finance.signal.lateContracts.name'));
  });

  it('says in place that the load could not be computed, without hiding the finance', async () => {
    open({ failing: { getVendorCapacity: { error: new Error('down'), times: 5 } } });
    await loaded();
    expect(await screen.findByTestId('capacity-failed')).toBeTruthy();
  });

  it('hides the actions in a read-only workspace and for a caller without the rights', async () => {
    open({ mode: 'READ_ONLY' });
    await loaded();
    expect(screen.queryByTestId('record-period')).toBeNull();
    expect(screen.queryByTestId('verify-period')).toBeNull();
    cleanup();
    open({ permissions: ['vnd.read'] });
    await loaded();
    expect(screen.queryByTestId('record-period')).toBeNull();
  });

  it('says a contractor that is not found, and an error with a retry', async () => {
    open({ failing: { getVendorFinance: { error: new ApiError({ status: 404, code: 'RESOURCE_NOT_FOUND', correlationId: 'c' }), times: 5 } } });
    expect(await screen.findByText(word('states.empty.title'))).toBeTruthy();
    cleanup();
    open({ failing: { getVendorFinance: { error: new ApiError({ status: 500, code: 'INTERNAL', correlationId: 'c' }), times: 1 } } });
    fireEvent.click(await screen.findByRole('button', { name: word('states.retry.action') }));
    await loaded();
  });
});
