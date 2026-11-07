import { ApiError, NETWORK_ERROR_CODE } from '@machvon/api-client';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import g from '../../i18n/vi.json';
import vi_ from '../../i18n/vi.json';
import { harness, mount, routeOf } from '../mne/test-support';
import KpiRegisterScreen from './KpiRegisterScreen';

const ROUTE = routeOf('BI-20', 'FR-BI-20');
const t = (key: keyof typeof g, values: Record<string, string | number> = {}): string => Object.entries(values).reduce((out, [name, value]) => out.replace(`{${name}}`, String(value)), g[key]);
const failure = (status: number, code: string) => new ApiError({ status, code, correlationId: 'c', extensions: {} });

const definition = (code: string, overrides: Record<string, unknown> = {}) => ({
  code,
  name: `Tên ${code}`,
  formula: `Công thức ${code}`,
  numerator: `Tử ${code}`,
  denominator: `Mẫu ${code}`,
  exclusions: ['Vốn chưa phân bổ', 'Dự án đã hủy'],
  unit: 'PERCENT',
  period: 'Lũy kế đến ngày chốt',
  source: 'DIS, số đã chốt',
  owner: 'CAPITAL_PLANNER',
  decimals: 2,
  refresh_hours: 24,
  allowed_lag_days: 2,
  rag_code: null,
  version: 0,
  origin: 'DEFAULT',
  unverified: true,
  certification: { status: 'CERTIFIED', version: 0, origin: 'PLATFORM', certified_by: null, at: null },
  ...overrides,
});
const ANSWER = {
  as_of: '2026-11-08',
  definitions: [
    definition('DISBURSEMENT_RATE_PM'),
    definition('OPEN_WARNINGS', { numerator: null, denominator: null, exclusions: [], allowed_lag_days: null, origin: 'RULE', version: 2, unverified: false, certification: { status: 'CERTIFIED', version: 2, origin: 'TENANT', certified_by: 'Người duyệt', at: '2026-11-03T01:00:00.000Z' } }),
    definition('OVERDUE_EXPLANATIONS', { origin: 'RULE', version: 4, unverified: false, certification: null }),
  ],
};

const client = (state: { value: unknown }) => harness((operation) => (operation === 'getKpiRegister' ? state.value : new Error(`unexpected read ${operation}`)));
const row = (code: string): HTMLElement => document.querySelector(`tr[data-code="${code}"]`) as HTMLElement;
const findRow = (code: string) =>
  waitFor(() => {
    const found = document.querySelector(`tr[data-code="${code}"]`);
    if (found === null) throw new Error(`no row ${code}`);
    return found as HTMLElement;
  });

afterEach(cleanup);

describe('BI-20 the KPI register (G0-4)', () => {
  it('shows the loading skeleton first, never a 0', () => {
    mount(<KpiRegisterScreen route={ROUTE} />, harness(() => new Promise(() => undefined)));
    expect(screen.getByRole('status', { name: vi_['states.loading.label'] })).toBeTruthy();
    expect(screen.queryByText('0')).toBeNull();
  });

  it('lists every field of each definition: code, name, formula, numerator, denominator, exclusions, period, source, owner, allowed lag, version and certification', async () => {
    mount(<KpiRegisterScreen route={ROUTE} />, client({ value: ANSWER }));
    const first = await findRow('DISBURSEMENT_RATE_PM');
    for (const text of ['Tên DISBURSEMENT_RATE_PM', 'Công thức DISBURSEMENT_RATE_PM', 'Tử DISBURSEMENT_RATE_PM', 'Mẫu DISBURSEMENT_RATE_PM', 'Vốn chưa phân bổ', 'Dự án đã hủy', 'Lũy kế đến ngày chốt', 'DIS, số đã chốt', 'CAPITAL_PLANNER', '2 ngày', '0 (mặc định)', 'Đã chứng nhận']) {
      expect(within(first).getByText(text)).toBeTruthy();
    }
    const second = row('OPEN_WARNINGS');
    expect(within(second).getByText('2')).toBeTruthy();
    expect(within(second).getAllByText(g['govc.bi.none']).length).toBeGreaterThanOrEqual(3);
    expect(within(row('OVERDUE_EXPLANATIONS')).getByTestId('register-no-cert').textContent).toBe('Chưa có chứng nhận');
  });

  it('flags a default that nobody confirmed, and only that', async () => {
    mount(<KpiRegisterScreen route={ROUTE} />, client({ value: ANSWER }));
    await findRow('DISBURSEMENT_RATE_PM');
    expect(within(row('DISBURSEMENT_RATE_PM')).getByTestId('register-unverified').textContent).toBe('Giá trị khởi điểm chưa được xác nhận');
    expect(within(row('OPEN_WARNINGS')).queryByTestId('register-unverified')).toBeNull();
  });

  it('opens the whole definition of a row, read only, and says so again for a starting value', async () => {
    const user = userEvent.setup();
    mount(<KpiRegisterScreen route={ROUTE} />, client({ value: ANSWER }));
    await findRow('OPEN_WARNINGS');
    await user.click(within(row('OPEN_WARNINGS')).getByRole('button', { name: t('govc.bi.register.detail.aria', { code: 'OPEN_WARNINGS' }) }));
    const detail = await screen.findByTestId('register-detail');
    expect(within(detail).getByText('Công thức OPEN_WARNINGS')).toBeTruthy();
    expect(within(detail).getByText(/Người duyệt/)).toBeTruthy();
    expect(within(detail).getByText(g['govc.bi.register.origin.rule'])).toBeTruthy();
    expect(screen.queryByTestId('register-detail-unverified')).toBeNull();
    expect(screen.queryByRole('textbox', { name: /Công thức/ })).toBeNull();
    await user.click(within(row('DISBURSEMENT_RATE_PM')).getByRole('button', { name: t('govc.bi.register.detail.aria', { code: 'DISBURSEMENT_RATE_PM' }) }));
    expect(await screen.findByTestId('register-detail-unverified')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: g['govc.bi.detail.close'] }));
    expect(screen.queryByTestId('register-detail')).toBeNull();
  });

  it('searches by code or name, and says so when nothing matches; an empty register says there is nothing', async () => {
    const user = userEvent.setup();
    mount(<KpiRegisterScreen route={ROUTE} />, client({ value: ANSWER }));
    await findRow('OPEN_WARNINGS');
    await user.type(screen.getByLabelText(g['govc.bi.register.search']), 'overdue');
    expect(row('OPEN_WARNINGS')).toBeNull();
    expect(row('OVERDUE_EXPLANATIONS')).toBeTruthy();
    await user.type(screen.getByLabelText(g['govc.bi.register.search']), 'zzz');
    expect(await screen.findByText(vi_['ui.dataTable.emptyFiltered'])).toBeTruthy();
    cleanup();
    mount(<KpiRegisterScreen route={ROUTE} />, client({ value: { as_of: '2026-11-08', definitions: [] } }));
    expect(await screen.findByText(vi_['ui.dataTable.emptyNone'])).toBeTruthy();
  });

  it('shows the day of the register in the context bar and links to the certification screen', async () => {
    mount(<KpiRegisterScreen route={ROUTE} />, client({ value: ANSWER }));
    await findRow('OPEN_WARNINGS');
    expect(within(screen.getByRole('group', { name: vi_['ui.contextBar.label'] })).getByText('08/11/2026')).toBeTruthy();
    expect(screen.getByRole('link', { name: g['govc.bi.register.certLink'] }).getAttribute('href')).toBe('/bi/bi-19');
  });

  it('counts the definitions it could not read', async () => {
    mount(<KpiRegisterScreen route={ROUTE} />, client({ value: { ...ANSWER, definitions: [...ANSWER.definitions, { code: 'BROKEN' }] } }));
    expect((await screen.findByTestId('register-partial')).textContent).toBe(t('govc.bi.cert.partial', { count: 1 }));
  });

  it('shows a read failure as an error with retry, never an empty register', async () => {
    const user = userEvent.setup();
    const state: { value: unknown } = { value: failure(500, 'INTERNAL_ERROR') };
    mount(<KpiRegisterScreen route={ROUTE} />, client(state));
    expect(await screen.findByText(vi_['states.error.title'])).toBeTruthy();
    expect(screen.queryByText(vi_['ui.dataTable.emptyNone'])).toBeNull();
    state.value = ANSWER;
    await user.click(screen.getByRole('button', { name: vi_['states.retry.action'] }));
    expect(await findRow('OPEN_WARNINGS')).toBeTruthy();
  });

  it.each([
    ['denied', failure(403, 'FORBIDDEN'), vi_['states.denied.title']],
    ['offline', new ApiError({ status: 0, code: NETWORK_ERROR_CODE, correlationId: 'c' }), vi_['states.offline.title']],
    ['an answer that is not a register', { as_of: '2026-11-08' }, vi_['states.error.title']],
  ])('shows %s', async (_name, value, title) => {
    mount(<KpiRegisterScreen route={ROUTE} />, client({ value }));
    expect(await screen.findByText(title)).toBeTruthy();
  });

  it('keeps the last good register and says it is old when a refresh fails', async () => {
    const state: { value: unknown } = { value: ANSWER };
    const { queries } = mount(<KpiRegisterScreen route={ROUTE} />, client(state));
    await findRow('OPEN_WARNINGS');
    state.value = failure(500, 'INTERNAL_ERROR');
    await queries.invalidateQueries();
    expect(await screen.findByTestId('register-stale')).toBeTruthy();
    expect(row('OPEN_WARNINGS')).toBeTruthy();
  });
});
