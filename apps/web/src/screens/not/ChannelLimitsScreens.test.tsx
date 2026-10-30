import { ApiError, NETWORK_ERROR_CODE } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../i18n/vi.json';
import ChannelLimitsScreen from './ChannelLimitsScreen';
import OverviewScreen from './OverviewScreen';
import { harness, mount, routeOf } from './delivery/test-support';
import { describeProblem, formOf, limitsBody, limitsProblems, periodRange, toOverview, utilisation } from './limits/model';

const ADMIN = ['notification.channel.manage', 'delivery_attempt.read'];
const READER = ['delivery_attempt.read'];
const NOBODY = ['notification.self'];
const reason = 'The budget of the quarter was approved.';
const problem = (code: string, status = 409, detail?: string) => new ApiError({ status, code, correlationId: 'c', detail });

const overviewRow = (overrides: Record<string, unknown> = {}) => ({
  from: '2026-10-23T03:00:00Z',
  to: '2026-10-30T03:00:00Z',
  as_of: '2026-10-30T03:00:05Z',
  channels: [
    { channel: 'SMS', delivered: 70, read: 10, ended: 100, suppressed: 5, unknown: 11, failed: 4, denominator: 95, delivered_rate: 84.21 },
    { channel: 'EMAIL', delivered: 0, read: 0, ended: 3, suppressed: 3, unknown: 0, failed: 0, denominator: 0, delivered_rate: null },
  ],
  accounts: [
    { channel_account_id: 'account-1', channel: 'SMS', display_name: 'SMS gateway', status: 'Active', daily_send_cap: 100, sent_today: 90, monthly_budget_vnd: '1000000', spent_month_vnd: '999900', held_by_limit: 2, version: 3 },
    { channel_account_id: 'account-2', channel: 'ZALO_ZNS', display_name: 'Zalo ZNS', status: 'Active', daily_send_cap: null, sent_today: 4, monthly_budget_vnd: null, spent_month_vnd: '1200', held_by_limit: 0, version: 1 },
  ],
  ...overrides,
});

afterEach(cleanup);

function open(element: JSX.Element, permissions: readonly string[], answer: () => unknown, command: (operation: string, input: unknown) => unknown = () => ({})) {
  const h = harness((operation) => (operation === 'getDeliveryOverview' ? answer() : new Error(`unexpected read ${operation}`)), command);
  return { h, ...mount(element, h, { permissions }) };
}
const overview = (permissions: readonly string[], answer: () => unknown) => open(<OverviewScreen route={routeOf('NOT-04', 'FR-NOT-04')} />, permissions, answer);
const limits = (permissions: readonly string[], answer: () => unknown, command?: (operation: string, input: unknown) => unknown) => open(<ChannelLimitsScreen route={routeOf('NOT-15', 'FR-NOT-15')} />, permissions, answer, command);

describe('NOT-04 the operations overview (UI-NOT-04)', () => {
  it('AC-ST-NOT-010-3 UI-NOT-04: shows the formula, the cutoff and the budget utilisation, the rate with the unknown apart, and no rate where nothing was sent', async () => {
    overview(READER, () => overviewRow());
    const table = await screen.findByRole('table');
    const sms = table.querySelector('[data-channel="SMS"]') as HTMLElement;
    expect(sms.querySelector('[data-rate]')?.textContent).toBe('84.21%');
    expect(sms.querySelector('[data-denominator]')?.textContent).toBe('95');
    expect(sms.querySelector('[data-unknown]')?.textContent).toContain('11');
    expect(within(sms).getByRole('link', { name: vi_['not.overview.unknown.reconcile'] }).getAttribute('href')).toBe('/not/not-11');
    const email = table.querySelector('[data-channel="EMAIL"]') as HTMLElement;
    expect(email.querySelector('[data-rate]')?.textContent).toBe(vi_['not.overview.rate.none']);
    expect(email.querySelector('[data-unknown]')?.textContent).toBe('0');
    expect(screen.getByText(vi_['not.overview.formula'])).toBeTruthy();
    expect(document.querySelector('[data-cutoff]')?.textContent).toContain('30/10/26');
    const first = document.querySelector('[data-account-id="account-1"]') as HTMLElement;
    expect(first.querySelector('[data-day-use]')?.textContent).toContain('90/100');
    expect(first.querySelector('[data-month-use]')?.textContent).toContain('99%');
    expect(first.querySelector('[data-held]')?.textContent).toContain('2');
    const second = document.querySelector('[data-account-id="account-2"]') as HTMLElement;
    expect(second.querySelector('[data-day-use]')?.textContent).toContain('4');
    expect(second.querySelector('[data-month-use]')?.textContent).toContain(vi_['not.overview.use.noBudget'].split('{')[0]?.trim() ?? '');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['not.overview.page.title']);
  });

  it('AC-ST-NOT-010-3 UI-NOT-04: shows a loading state, then the denied, signed-out, offline and error states, and says in words when nothing is there', async () => {
    for (const [error, title] of [
      [new ApiError({ status: 403, code: 'SCOPE_DENIED', correlationId: 'c' }), vi_['states.denied.title']],
      [new ApiError({ status: 401, code: 'SESSION_EXPIRED', correlationId: 'c' }), vi_['states.signedOut.title']],
      [new ApiError({ status: 0, code: NETWORK_ERROR_CODE, correlationId: 'c' }), vi_['states.offline.title']],
      [new ApiError({ status: 500, code: 'INTERNAL_ERROR', correlationId: 'c' }), vi_['states.error.title']],
    ] as const) {
      overview(READER, () => error);
      expect(await screen.findByText(title)).toBeTruthy();
      cleanup();
    }
    const loading = overview(READER, () => overviewRow({ channels: [], accounts: [] }));
    expect(loading.container.querySelector('[role="status"]')).not.toBeNull();
    expect(await screen.findByText(vi_['states.empty.title'])).toBeTruthy();
    cleanup();
    const { h } = overview(NOBODY, () => overviewRow());
    expect(await screen.findByText(vi_['states.denied.title'])).toBeTruthy();
    expect(h.read).not.toHaveBeenCalled();
  });

  it('reads the period chosen, ending when the screen was opened', async () => {
    const { h } = overview(READER, () => overviewRow());
    await screen.findByRole('table');
    fireEvent.change(screen.getByLabelText(vi_['not.overview.period.label']), { target: { value: 'day' } });
    await waitFor(() => {
      const [operation, input] = h.read.mock.calls.at(-1) as [string, { query: { from: string; to: string } }];
      expect(operation).toBe('getDeliveryOverview');
      expect(Date.parse(input.query.to) - Date.parse(input.query.from)).toBe(86_400_000);
    });
  });
});

describe('NOT-15 the limits of the channels (UI-NOT-15)', () => {
  it('AC-ST-NOT-010-4 UI-NOT-15: shows each account against its cap and budget, and the rule that a CRITICAL message is never held back', async () => {
    limits(ADMIN, () => overviewRow());
    expect(await screen.findAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByText(vi_['not.limits.rule.text'])).toBeTruthy();
    const first = document.querySelector('[data-account-id="account-1"]') as HTMLElement;
    expect(first.querySelector('[data-day-use]')?.textContent).toContain('90/100');
    expect(within(first).getByRole('button', { name: vi_['not.limits.edit.action'] })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['not.limits.page.title']);
  });

  it('AC-ST-NOT-010-4 UI-NOT-15: shows a loading state, then the denied, signed-out, offline and error states, and says in words when there is no account', async () => {
    for (const [error, title] of [
      [new ApiError({ status: 403, code: 'SCOPE_DENIED', correlationId: 'c' }), vi_['states.denied.title']],
      [new ApiError({ status: 401, code: 'SESSION_EXPIRED', correlationId: 'c' }), vi_['states.signedOut.title']],
      [new ApiError({ status: 0, code: NETWORK_ERROR_CODE, correlationId: 'c' }), vi_['states.offline.title']],
      [new ApiError({ status: 500, code: 'INTERNAL_ERROR', correlationId: 'c' }), vi_['states.error.title']],
    ] as const) {
      limits(ADMIN, () => error);
      expect(await screen.findByText(title)).toBeTruthy();
      cleanup();
    }
    limits(ADMIN, () => overviewRow({ accounts: [] }));
    expect(await screen.findByText(vi_['states.empty.title'])).toBeTruthy();
    cleanup();
    const { h } = limits(NOBODY, () => overviewRow());
    expect(await screen.findByText(vi_['states.denied.title'])).toBeTruthy();
    expect(h.read).not.toHaveBeenCalled();
  });

  it('sets a cap and a budget with a reason at the version read, sending only what changed, and tells before sending what the server would refuse', async () => {
    const { h } = limits(ADMIN, () => overviewRow(), () => ({ operation_id: 'o', status: 'ACTIVE', resource_version: 4, resource_id: 'account-1' }));
    const first = (await screen.findAllByRole('listitem'))[0] as HTMLElement;
    fireEvent.click(within(first).getByRole('button', { name: vi_['not.limits.edit.action'] }));
    const form = (await screen.findByRole('form', { name: vi_['not.limits.form.aria'].replace('{name}', 'SMS gateway') })) as HTMLElement;
    fireEvent.change(within(form).getByLabelText(vi_['not.limits.form.cap.label']), { target: { value: '0' } });
    fireEvent.change(within(form).getByLabelText(vi_['not.limits.form.budget.label']), { target: { value: '-5' } });
    fireEvent.click(within(form).getByRole('button', { name: vi_['not.limits.form.submit.action'] }));
    expect(within(form).getByText(vi_['not.limits.form.cap.invalid'])).toBeTruthy();
    expect(within(form).getByText(vi_['not.limits.form.budget.invalid'])).toBeTruthy();
    expect(within(form).getByText(vi_['not.limits.form.reason.invalid'])).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
    fireEvent.change(within(form).getByLabelText(vi_['not.limits.form.cap.label']), { target: { value: '200' } });
    fireEvent.change(within(form).getByLabelText(vi_['not.limits.form.budget.label']), { target: { value: '1000000' } });
    fireEvent.change(within(form).getByLabelText(vi_['not.limits.form.reason.label']), { target: { value: reason } });
    fireEvent.click(within(form).getByRole('button', { name: vi_['not.limits.form.submit.action'] }));
    expect(await screen.findByText(vi_['not.limits.done.saved'])).toBeTruthy();
    // The budget is what it was: only the cap goes.
    expect(h.command).toHaveBeenCalledWith('setChannelLimits', expect.objectContaining({ path: { channelAccountId: 'account-1' }, body: { daily_send_cap: 200, reason }, ifMatchVersion: 3 }));
  });

  it('takes a limit off with its flag, and refuses to send a form that changes nothing', async () => {
    const { h } = limits(ADMIN, () => overviewRow(), () => ({ operation_id: 'o', status: 'ACTIVE', resource_version: 4, resource_id: 'account-1' }));
    const first = (await screen.findAllByRole('listitem'))[0] as HTMLElement;
    fireEvent.click(within(first).getByRole('button', { name: vi_['not.limits.edit.action'] }));
    const form = (await screen.findByRole('form')) as HTMLElement;
    fireEvent.change(within(form).getByLabelText(vi_['not.limits.form.reason.label']), { target: { value: reason } });
    fireEvent.click(within(form).getByRole('button', { name: vi_['not.limits.form.submit.action'] }));
    expect(within(form).getByText(vi_['not.limits.form.nothing.invalid'])).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
    fireEvent.click(within(form).getByLabelText(vi_['not.limits.form.budget.clear']));
    fireEvent.click(within(form).getByRole('button', { name: vi_['not.limits.form.submit.action'] }));
    await screen.findByText(vi_['not.limits.done.saved']);
    expect(h.command).toHaveBeenCalledWith('setChannelLimits', expect.objectContaining({ body: { clear_monthly_budget: true, reason } }));
  });

  it('says in words what the server refused with, and keeps the form open', async () => {
    limits(ADMIN, () => overviewRow(), () => problem('VERSION_CONFLICT'));
    const first = (await screen.findAllByRole('listitem'))[0] as HTMLElement;
    fireEvent.click(within(first).getByRole('button', { name: vi_['not.limits.edit.action'] }));
    const form = (await screen.findByRole('form')) as HTMLElement;
    fireEvent.change(within(form).getByLabelText(vi_['not.limits.form.cap.label']), { target: { value: '5' } });
    fireEvent.change(within(form).getByLabelText(vi_['not.limits.form.reason.label']), { target: { value: reason } });
    fireEvent.click(within(form).getByRole('button', { name: vi_['not.limits.form.submit.action'] }));
    expect(await within(form).findByText(vi_['not.limits.problem.conflict'])).toBeTruthy();
    expect(screen.queryByText(vi_['not.limits.done.saved'])).toBeNull();
  });

  it('offers a reader the figures and no way to change them', async () => {
    limits(READER, () => overviewRow());
    await screen.findAllByRole('listitem');
    expect(screen.queryByRole('button', { name: vi_['not.limits.edit.action'] })).toBeNull();
  });
});

describe('the model of NOT-04 and NOT-15', () => {
  it('reads an overview and takes what is not one for nothing', () => {
    expect(toOverview(null)).toEqual({ from: '', to: '', asOf: '', channels: [], accounts: [] });
    const read = toOverview(overviewRow());
    expect(read.channels[0]).toMatchObject({ channel: 'SMS', rate: 84.21, denominator: 95, unknown: 11 });
    expect(read.channels[1]?.rate).toBeUndefined();
    expect(read.accounts[0]).toMatchObject({ id: 'account-1', dailySendCap: 100, monthlyBudgetVnd: '1000000', spentMonthVnd: '999900', heldByLimit: 2, version: 3 });
    expect(read.accounts[1]).toMatchObject({ dailySendCap: undefined, monthlyBudgetVnd: undefined });
  });

  it('measures how much of a limit is used, capped at the whole, and has nothing for no limit', () => {
    expect(utilisation(90, 100)).toBe(90);
    expect(utilisation('999900', '1000000')).toBe(99.99);
    expect(utilisation(150, 100)).toBe(100);
    expect(utilisation(5, undefined)).toBeUndefined();
    expect(utilisation(5, 0)).toBeUndefined();
  });

  it('judges the form the way the server does and sends only what changed', () => {
    const account = { dailySendCap: 100, monthlyBudgetVnd: '1000000' };
    const base = { ...formOf(account), reason };
    expect(limitsProblems(base, account)).toEqual(['nothing']);
    expect(limitsProblems({ ...base, cap: '0', budget: 'x', reason: 'short' }, account)).toEqual(['cap', 'budget', 'reason']);
    expect(limitsBody({ ...base, cap: '250', budget: '000' }, account)).toEqual({ daily_send_cap: 250, monthly_budget_vnd: '0' });
    expect(limitsBody({ ...base, clearCap: true, clearBudget: true }, account)).toEqual({ clear_daily_send_cap: true, clear_monthly_budget: true });
    // Taking off a limit that is not there changes nothing.
    expect(limitsBody({ ...formOf({ dailySendCap: undefined, monthlyBudgetVnd: undefined }), clearCap: true }, { dailySendCap: undefined, monthlyBudgetVnd: undefined })).toEqual({});
  });

  it('cuts the period back from now and puts what the server refused with into words', () => {
    const now = new Date('2026-10-30T03:00:00Z');
    expect(periodRange('week', now)).toEqual({ from: '2026-10-23T03:00:00.000Z', to: '2026-10-30T03:00:00.000Z' });
    expect(describeProblem(problem('CHANNEL_ACCOUNT_STATE_INVALID'))).toEqual({ reason: 'state', field: undefined });
    expect(describeProblem(problem('VALIDATION_FAILED', 422, 'daily_send_cap'))).toEqual({ reason: 'invalid', field: 'daily_send_cap' });
    expect(describeProblem(new Error('x'))).toEqual({ reason: 'general', field: undefined });
  });
});
