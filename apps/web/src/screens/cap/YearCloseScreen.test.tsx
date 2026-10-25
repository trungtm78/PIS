import { ApiError, NETWORK_ERROR_CODE } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../i18n/vi.json';
import { harness } from '../sas/test-support';
import YearCloseScreen from './YearCloseScreen';
import { mount, routeOf } from './test-support';

const ROUTE = routeOf('CAP-11', 'FR-CAP-11');
const CLOSER = ['capital.read', 'capital.year.close'];
const REOPENER = ['capital.read', 'capital.year.reopen'];
const BOTH = ['capital.read', 'capital.year.close', 'capital.year.reopen'];
const READER = ['capital.read'];
const problem = (code: string, status = 409, extensions: Record<string, unknown> = {}, detail?: string) => new ApiError({ status, code, correlationId: 'c', ...(detail === undefined ? {} : { detail }), extensions });
const YEAR = new Date().getUTCFullYear() - 1;

const row = (year: number, overrides: Record<string, unknown> = {}) => ({ plan_year: year, status: 'OPEN', version: 1, ...overrides });

interface State {
  years: Array<Record<string, unknown>>;
  failing: Map<string, unknown>;
}

const state = (overrides: Partial<State> = {}): State => ({
  years: [row(YEAR - 1, { status: 'LOCKED', version: 3, locked_at: '2026-02-01T03:00:00Z', locked_by: 'x', close_reason: 'Hết kỳ chỉnh lý', reopen_reason: 'Kiểm toán phát hiện sai sót khi phân bổ vốn', reopened_until: '2026-02-03T03:00:00Z' })],
  failing: new Map(),
  ...overrides,
});

function open(permissions: readonly string[] | undefined, current: State = state(), command: (operation: string, input: unknown) => unknown = () => ({}), options: { mode?: 'FULL' | 'READ_ONLY'; path?: string } = {}) {
  const h = harness((operation) => {
    if (current.failing.has(operation)) return current.failing.get(operation) as Error;
    if (operation === 'listFiscalYears') return { items: current.years };
    return new Error(`unexpected read ${operation}`);
  }, command);
  mount(<YearCloseScreen route={ROUTE} />, h, { permissions, ...options });
  return h;
}
const yearState = () => screen.findByTestId('year-state');
const dialog = () => screen.getByRole('form', { name: vi_['cap.year.dialog.aria'] });

afterEach(cleanup);

describe('UI-CAP-11 the closing of a fiscal year (ST-CAP-008)', () => {
  it('shows a year the control does not know as open, with the closes it may be taken to', async () => {
    open(CLOSER);
    const facts = await yearState();
    expect(facts.getAttribute('data-status')).toBe('OPEN');
    expect(facts.getAttribute('data-version')).toBe('1');
    expect(within(facts).getByText(vi_['cap.year.status.open'])).toBeTruthy();
    expect(screen.getByRole('button', { name: vi_['cap.year.softClose.action'] })).toBeTruthy();
    expect(screen.getByRole('button', { name: vi_['cap.year.lock.action'] })).toBeTruthy();
    expect(screen.queryByRole('button', { name: vi_['cap.year.reopen.action'] })).toBeNull();
    expect(screen.queryByTestId('year-locked')).toBeNull();
  });

  it('soft-closes the year with a reason against the version that was read, and says the adjustment period began', async () => {
    const h = open(CLOSER);
    await yearState();
    fireEvent.click(screen.getByRole('button', { name: vi_['cap.year.softClose.action'] }));
    fireEvent.click(within(dialog()).getByRole('button', { name: vi_['cap.year.dialog.confirm.softClose'] }));
    expect(within(dialog()).getByText(vi_['cap.year.fieldError.closeReason'])).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
    fireEvent.change(within(dialog()).getByLabelText(vi_['cap.year.field.reason']), { target: { value: 'Hết năm, bắt đầu kỳ chỉnh lý' } });
    fireEvent.click(within(dialog()).getByRole('button', { name: vi_['cap.year.dialog.confirm.softClose'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(h.command).toHaveBeenCalledWith('closeFiscalYear', expect.objectContaining({ path: { year: YEAR }, ifMatchVersion: 1, body: { target_status: 'SOFT_CLOSED', reason: 'Hết năm, bắt đầu kỳ chỉnh lý' } }));
    expect(await screen.findByText(vi_['cap.year.done.softClosed'].replace('{year}', String(YEAR)))).toBeTruthy();
    expect(screen.queryByRole('form', { name: vi_['cap.year.dialog.aria'] })).toBeNull();
  });

  it('shows the adjustment period of a soft-closed year, which can only be locked', async () => {
    open(CLOSER, state({ years: [row(YEAR, { status: 'SOFT_CLOSED', version: 2, soft_closed_at: '2026-01-05T01:00:00Z', close_reason: 'Hết năm' })] }));
    expect((await yearState()).getAttribute('data-status')).toBe('SOFT_CLOSED');
    expect((await screen.findByTestId('year-soft')).textContent).toContain(String(YEAR));
    expect(screen.queryByRole('button', { name: vi_['cap.year.softClose.action'] })).toBeNull();
    expect(screen.getByRole('button', { name: vi_['cap.year.lock.action'] })).toBeTruthy();
  });

  it('locks the year: the dialog says what lapses, and the lock is sent with the version of the soft close', async () => {
    const h = open(CLOSER, state({ years: [row(YEAR, { status: 'SOFT_CLOSED', version: 2, soft_closed_at: '2026-01-05T01:00:00Z' })] }));
    await yearState();
    fireEvent.click(screen.getByRole('button', { name: vi_['cap.year.lock.action'] }));
    expect(within(dialog()).getByText(vi_['cap.year.dialog.effect.lock'])).toBeTruthy();
    fireEvent.change(within(dialog()).getByLabelText(vi_['cap.year.field.reason']), { target: { value: 'Hết kỳ chỉnh lý' } });
    fireEvent.click(within(dialog()).getByRole('button', { name: vi_['cap.year.dialog.confirm.lock'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(h.command).toHaveBeenCalledWith('closeFiscalYear', expect.objectContaining({ ifMatchVersion: 2, body: { target_status: 'LOCKED', reason: 'Hết kỳ chỉnh lý' } }));
    expect(await screen.findByText(vi_['cap.year.done.locked'].replace('{year}', String(YEAR)))).toBeTruthy();
  });

  it('shows a locked year with a red banner and its history, and offers it only to the reopening (AC-ST-CAP-008-1)', async () => {
    open(BOTH, state(), undefined, { path: `/?year=${YEAR - 1}` });
    const facts = await yearState();
    expect(facts.getAttribute('data-status')).toBe('LOCKED');
    const banner = screen.getByTestId('year-locked');
    expect(banner.className).toContain('warning');
    expect(banner.textContent).toBe(vi_['cap.year.locked.banner'].replace('{year}', String(YEAR - 1)));
    expect(within(facts).getByText('Hết kỳ chỉnh lý')).toBeTruthy();
    expect(within(facts).getByText('Kiểm toán phát hiện sai sót khi phân bổ vốn')).toBeTruthy();
    expect(screen.getByRole('button', { name: vi_['cap.year.reopen.action'] })).toBeTruthy();
    expect(screen.queryByRole('button', { name: vi_['cap.year.lock.action'] })).toBeNull();
  });

  it('reopens a locked year: asks a reason of 20 characters and a window of 1 to 168 hours, then sends both', async () => {
    const h = open(REOPENER, state(), undefined, { path: `/?year=${YEAR - 1}` });
    await yearState();
    fireEvent.click(screen.getByRole('button', { name: vi_['cap.year.reopen.action'] }));
    fireEvent.change(within(dialog()).getByLabelText(vi_['cap.year.field.reason']), { target: { value: 'ngắn' } });
    fireEvent.change(within(dialog()).getByLabelText(vi_['cap.year.field.hours']), { target: { value: '200' } });
    fireEvent.click(within(dialog()).getByRole('button', { name: vi_['cap.year.dialog.confirm.reopen'] }));
    expect(within(dialog()).getByText(vi_['cap.year.fieldError.reopenReason'])).toBeTruthy();
    expect(within(dialog()).getByText(vi_['cap.year.fieldError.hours'])).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
    fireEvent.change(within(dialog()).getByLabelText(vi_['cap.year.field.reason']), { target: { value: 'Kiểm toán phát hiện sai sót khi phân bổ vốn' } });
    fireEvent.change(within(dialog()).getByLabelText(vi_['cap.year.field.hours']), { target: { value: '48' } });
    fireEvent.click(within(dialog()).getByRole('button', { name: vi_['cap.year.dialog.confirm.reopen'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(h.command).toHaveBeenCalledWith(
      'reopenFiscalYear',
      expect.objectContaining({ path: { year: YEAR - 1 }, ifMatchVersion: 3, body: { reason: 'Kiểm toán phát hiện sai sót khi phân bổ vốn', window_hours: 48 } }),
    );
    expect(await screen.findByText(vi_['cap.year.done.reopened'].replace('{year}', String(YEAR - 1)))).toBeTruthy();
  });

  it('lets the person choose another year, which starts the dialog over', async () => {
    open(CLOSER);
    await yearState();
    fireEvent.click(screen.getByRole('button', { name: vi_['cap.year.lock.action'] }));
    fireEvent.change(screen.getByLabelText(vi_['cap.year.field.year']), { target: { value: String(YEAR - 1) } });
    expect(screen.queryByRole('form', { name: vi_['cap.year.dialog.aria'] })).toBeNull();
    expect((await yearState()).getAttribute('data-status')).toBe('LOCKED');
  });

  it('tells the person when the server refuses a close or a reopening, in the words of the refusal', async () => {
    const cases: Array<[Error, string]> = [
      [problem('YEAR_STATE_INVALID', 409, { reason: 'PLANS_PENDING', plan_ids: ['a', 'b'] }), vi_['cap.year.problem.plansPending'].replace('{count}', '2')],
      [problem('YEAR_STATE_INVALID', 409, { reason: 'RESERVATIONS_ACTIVE', reservation_ids: ['a'] }), vi_['cap.year.problem.reservationsActive'].replace('{count}', '1')],
      [problem('YEAR_STATE_INVALID', 409, { reason: 'ALREADY_LOCKED' }), vi_['cap.year.problem.alreadyLocked']],
      [problem('YEAR_STATE_INVALID', 409, { reason: 'ALREADY_SOFT_CLOSED' }), vi_['cap.year.problem.alreadySoftClosed']],
      [problem('VERSION_CONFLICT', 409), vi_['cap.year.problem.conflict']],
      [problem('VALIDATION_FAILED', 422, {}, 'reason'), vi_['cap.year.problem.invalidAt'].replace('{field}', 'reason')],
      [problem('VALIDATION_FAILED', 422), vi_['cap.year.problem.invalid']],
      [problem('SCOPE_DENIED', 403), vi_['cap.year.problem.denied']],
      [problem('RESOURCE_NOT_FOUND', 404), vi_['cap.year.problem.notFound']],
      [problem('SESSION_EXPIRED', 401), vi_['cap.year.problem.session']],
      [problem('INTERNAL_ERROR', 500), vi_['cap.year.problem.general']],
    ];
    for (const [error, message] of cases) {
      const h = open(CLOSER, state(), () => error);
      await yearState();
      fireEvent.click(screen.getByRole('button', { name: vi_['cap.year.lock.action'] }));
      fireEvent.change(within(dialog()).getByLabelText(vi_['cap.year.field.reason']), { target: { value: 'Hết kỳ chỉnh lý' } });
      fireEvent.click(within(dialog()).getByRole('button', { name: vi_['cap.year.dialog.confirm.lock'] }));
      expect(await screen.findByText(message)).toBeTruthy();
      expect(h.command).toHaveBeenCalledTimes(1);
      // A refused close drops the dialog: the person looks at the year as it is now.
      expect(screen.queryByRole('form', { name: vi_['cap.year.dialog.aria'] })).toBeNull();
      cleanup();
    }
    const refused = open(REOPENER, state(), () => problem('SELF_APPROVAL_DENIED', 403), { path: `/?year=${YEAR - 1}` });
    await yearState();
    fireEvent.click(screen.getByRole('button', { name: vi_['cap.year.reopen.action'] }));
    fireEvent.change(within(dialog()).getByLabelText(vi_['cap.year.field.reason']), { target: { value: 'Kiểm toán phát hiện sai sót khi phân bổ vốn' } });
    fireEvent.click(within(dialog()).getByRole('button', { name: vi_['cap.year.dialog.confirm.reopen'] }));
    expect(await screen.findByText(vi_['cap.year.problem.selfApproval'])).toBeTruthy();
    expect(refused.command).toHaveBeenCalledTimes(1);
  });

  it('shows the list of the years the control knows and offers a reader nothing to do, nor anything in the frozen mode', async () => {
    open(READER);
    await yearState();
    expect(screen.getByRole('table', { name: vi_['cap.year.list.title'] })).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
    cleanup();
    open(BOTH, state(), undefined, { mode: 'READ_ONLY' });
    await yearState();
    expect(screen.queryByRole('button', { name: vi_['cap.year.lock.action'] })).toBeNull();
  });

  it('says so when no year was closed, and shows the loading, signed-out, denied, offline and error states', async () => {
    open(READER, state({ years: [] }));
    expect(document.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(await screen.findByText(vi_['cap.year.list.empty'])).toBeTruthy();
    cleanup();
    const failing = [
      [401, 'SESSION_EXPIRED', 'states.signedOut.title'],
      [403, 'SCOPE_DENIED', 'states.denied.title'],
      [0, NETWORK_ERROR_CODE, 'states.offline.title'],
      [500, 'INTERNAL_ERROR', 'states.error.title'],
    ] as const;
    for (const [status, code, key] of failing) {
      open(READER, state({ failing: new Map([['listFiscalYears', new ApiError({ status, code, correlationId: 'c' })]]) }));
      expect(await screen.findByText(vi_[key as keyof typeof vi_])).toBeTruthy();
      cleanup();
    }
  });

  it('retries the list from the error state', async () => {
    let reads = 0;
    const h = harness(() => {
      reads += 1;
      return reads === 1 ? new ApiError({ status: 500, code: 'INTERNAL_ERROR', correlationId: 'c' }) : { items: [] };
    });
    mount(<YearCloseScreen route={ROUTE} />, h, { permissions: READER });
    await screen.findByText(vi_['states.error.title']);
    fireEvent.click(screen.getByRole('button', { name: vi_['states.retry.action'] }));
    expect(await screen.findByText(vi_['cap.year.list.empty'])).toBeTruthy();
  });
});
