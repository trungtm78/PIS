import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../i18n/vi.json';
import DisbursementScheduleScreen from './DisbursementScheduleScreen';
import { PROJECT_A, PROJECT_B, mount, planClient, planWorld, routeOf } from './plan-test-support';
import type { PlanWorld } from './plan-test-support';

const ROUTE = routeOf('CAP-08', 'FR-CAP-08');
const INVESTOR = ['capital.read', 'project.read', 'capital.schedule.register'];
const READER = ['capital.read', 'project.read'];
const MILLION = 1_000_000;
const millions = (n: number): string => String(n * MILLION);
const YEAR = String(new Date().getFullYear());
const answer = { operation_id: 'o', status: 'CURRENT', resource_version: 1, resource_id: 'r' };
const problem = (code: string, status = 422) => new ApiError({ status, code, correlationId: 'c', extensions: {} });

afterEach(cleanup);

const row = (month: number, bucket: string, amount: string, paid: string, overrides: Record<string, unknown> = {}) => ({
  id: `row-${month}-${bucket}-${overrides.budget_level ?? 'CENTRAL'}`,
  project: { id: PROJECT_A, code: 'DA-01', name: 'Đường vành đai 3' },
  plan_year: Number(YEAR),
  granularity: 'MONTH',
  month,
  period: null,
  bucket,
  budget_level: 'CENTRAL',
  kind: 'REGISTERED',
  amount_vnd: amount,
  ctmtqg_subset_vnd: null,
  assumption: null,
  revision: 1,
  is_current: true,
  supersedes_id: null,
  achievement: { disbursed_vnd: paid, rate: null },
  ...overrides,
});

function world(rows: Array<Record<string, unknown>> = [row(10, 'CURRENT_YEAR', millions(800), millions(300)), row(11, 'CARRYOVER', millions(100), '0')]): PlanWorld {
  return { ...planWorld(), schedules: () => rows };
}

const open = (state: PlanWorld, permissions: readonly string[] = INVESTOR, command?: (operation: string, input: unknown) => unknown, options: { mode?: 'READ_ONLY'; path?: string } = {}) => {
  const h = planClient(state, command);
  mount(<DisbursementScheduleScreen route={ROUTE} />, h, { permissions, path: options.path ?? '/', ...(options.mode === undefined ? {} : { mode: options.mode }) });
  return h;
};
const ready = () => waitFor(() => expect(screen.getByTestId('grid')).toBeTruthy());
const monthRow = (month: number): HTMLElement => document.querySelector(`tr[data-month="${month}"]`) as HTMLElement;
const fill = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

describe('DisbursementScheduleScreen (CAP-08): the registration of the disbursement of a month', () => {
  it('shows the thirteen months by source group beside what the Treasury paid, and says that a registration is not money paid (AC-ST-CAP-009-1)', async () => {
    const h = open(world());
    await ready();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['cap.schedule.page.title']);
    expect(screen.getByTestId('promise').textContent).toBe(vi_['cap.schedule.note.promise.notice']);
    expect(document.querySelectorAll('tbody tr')).toHaveLength(13);
    expect(h.client.readAll).toHaveBeenCalledWith('listDisbursementSchedules', { query: { project_id: PROJECT_A, plan_year: Number(YEAR), kind: 'REGISTERED', granularity: 'MONTH' } });
    // 800 million registered in October of the year, 300 million paid: 0,3750.
    const october = monthRow(10);
    expect(within(october).getByTestId('registered').textContent).toBe('800');
    expect(within(october).getByTestId('disbursed').textContent).toBe('300');
    expect(within(october).getByTestId('rate').getAttribute('data-rate')).toBe('0.3750');
    expect(within(october).getByTestId('rate').textContent).toMatch(/^37,50\s?%$/);
    expect(october.querySelector('td[data-bucket="CURRENT_YEAR"]')?.textContent).toBe('800');
    // The carried-over capital of November is in its own column; nothing paid, so 0 of 100.
    expect(monthRow(11).querySelector('td[data-bucket="CARRYOVER"]')?.textContent).toBe('100');
    expect(within(monthRow(11)).getByTestId('rate').getAttribute('data-rate')).toBe('0.0000');
    // A month with no registration says so, and does not show 0 %.
    expect(within(monthRow(3)).getByTestId('rate').textContent).toBe(vi_['cap.schedule.rate.none.label']);
    expect(screen.getByTestId('total-registered').textContent).toBe('900');
    expect(screen.getByTestId('total-disbursed').textContent).toBe('300');
    expect(monthRow(13).querySelector('th')?.textContent).toBe(vi_['cap.schedule.month.adjustment.label']);
    expect(monthRow(1).querySelector('th')?.textContent).toBe('Tháng 1');
  });

  it('says so when the project has registered nothing in the year', async () => {
    open(world([]));
    await ready();
    expect(screen.getByTestId('no-registration').textContent).toBe(vi_['cap.schedule.empty.notice']);
    expect(screen.getByTestId('total-rate').textContent).toBe(vi_['cap.schedule.rate.none.label']);
  });

  it('registers a month with exact VND and the programme amount, and says which revision it made', async () => {
    const h = open(world(), INVESTOR, () => answer);
    await ready();
    fill(vi_['cap.schedule.month.field.label'], '12');
    fireEvent.change(screen.getByLabelText(vi_['cap.schedule.bucket.label']), { target: { value: 'CARRYOVER' } });
    fireEvent.change(screen.getByLabelText(vi_['cap.schedule.level.label']), { target: { value: 'LOCAL' } });
    fill(vi_['cap.schedule.amount.label'], '1500');
    fill(vi_['cap.schedule.ctmtqg.label'], '200');
    fireEvent.click(screen.getByRole('button', { name: vi_['cap.schedule.save.action'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    const [operation, input] = h.command.mock.calls[0] as [string, { body: Record<string, unknown> }];
    expect(operation).toBe('registerDisbursementSchedule');
    expect(input.body).toEqual({
      project_id: PROJECT_A,
      plan_year: Number(YEAR),
      granularity: 'MONTH',
      month: 12,
      kind: 'REGISTERED',
      bucket: 'CARRYOVER',
      budget_level: 'LOCAL',
      amount_vnd: millions(1_500),
      ctmtqg_subset_vnd: millions(200),
    });
    await waitFor(() => expect(screen.getByTestId('saved').textContent).toBe('Đã đăng ký, phiên bản 1.'));
  });

  it('offers the figure already registered for the month and the source group, and a new save makes the next revision', async () => {
    const h = open(world(), INVESTOR, () => answer);
    await ready();
    fill(vi_['cap.schedule.month.field.label'], '10');
    expect((screen.getByLabelText(vi_['cap.schedule.amount.label']) as HTMLInputElement).value).toBe('800');
    expect(screen.getByTestId('current').textContent).toContain('800');
    expect(screen.getByTestId('current').textContent).toContain('phiên bản 1');
    fill(vi_['cap.schedule.amount.label'], '900');
    fill(vi_['cap.schedule.reason.label'], 'Đã ký phụ lục hợp đồng');
    fireEvent.click(screen.getByRole('button', { name: vi_['cap.schedule.save.action'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect((h.command.mock.calls[0] as [string, { body: Record<string, unknown> }])[1].body).toMatchObject({ month: 10, amount_vnd: millions(900), revision_reason: 'Đã ký phụ lục hợp đồng' });
    await waitFor(() => expect(screen.getByTestId('saved').textContent).toBe('Đã đăng ký, phiên bản 2.'));
  });

  it('checks the form before anything is sent: the month, the amount, and a programme amount above it (AC-ST-CAP-009-2)', async () => {
    const h = open(world(), INVESTOR, () => answer);
    await ready();
    fireEvent.click(screen.getByRole('button', { name: vi_['cap.schedule.save.action'] }));
    expect(screen.getByText(vi_['cap.schedule.month.required.error'])).toBeTruthy();
    expect(screen.getByText(vi_['cap.schedule.amount.required.error'])).toBeTruthy();
    fill(vi_['cap.schedule.month.field.label'], '5');
    fill(vi_['cap.schedule.amount.label'], 'nhiều');
    fireEvent.click(screen.getByRole('button', { name: vi_['cap.schedule.save.action'] }));
    expect(screen.getByText(vi_['cap.schedule.amount.invalid.error'])).toBeTruthy();
    fill(vi_['cap.schedule.amount.label'], '100');
    fill(vi_['cap.schedule.ctmtqg.label'], '101');
    fireEvent.click(screen.getByRole('button', { name: vi_['cap.schedule.save.action'] }));
    expect(screen.getByText(vi_['cap.schedule.ctmtqg.exceeds.error'])).toBeTruthy();
    fill(vi_['cap.schedule.ctmtqg.label'], 'x');
    fireEvent.click(screen.getByRole('button', { name: vi_['cap.schedule.save.action'] }));
    expect(screen.getByText(vi_['cap.schedule.ctmtqg.invalid.error'])).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
  });

  it('accepts 0 as a registration: nothing is planned this month', async () => {
    const h = open(world(), INVESTOR, () => answer);
    await ready();
    fill(vi_['cap.schedule.month.field.label'], '4');
    fill(vi_['cap.schedule.amount.label'], '0');
    fireEvent.click(screen.getByRole('button', { name: vi_['cap.schedule.save.action'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect((h.command.mock.calls[0] as [string, { body: Record<string, unknown> }])[1].body).toMatchObject({ month: 4, amount_vnd: '0' });
  });

  it.each([
    ['SUBSET_EXCEEDS_PARENT', 422, 'subset'],
    ['PERIOD_LOCKED', 409, 'periodLocked'],
    ['FISCAL_YEAR_LOCKED', 409, 'yearLocked'],
    ['PROJECT_STAGE_INVALID', 422, 'stage'],
    ['SCOPE_DENIED', 403, 'denied'],
    ['RESOURCE_NOT_FOUND', 404, 'notFound'],
  ])('tells what the server refused with %s', async (code, status, kind) => {
    open(world(), INVESTOR, () => problem(code, status));
    await ready();
    fill(vi_['cap.schedule.month.field.label'], '6');
    fill(vi_['cap.schedule.amount.label'], '10');
    fireEvent.click(screen.getByRole('button', { name: vi_['cap.schedule.save.action'] }));
    await waitFor(() => expect(screen.getByTestId('problem')).toBeTruthy());
    expect(screen.getByTestId('problem').getAttribute('data-problem')).toBe(kind);
    expect(screen.queryByTestId('saved')).toBeNull();
  });

  it('shows no form to those who may not register, and says why; a frozen tenant is told so', async () => {
    open(world(), READER);
    await ready();
    expect(screen.getByTestId('register-denied').textContent).toBe(vi_['cap.schedule.denied.notice']);
    expect(screen.queryByRole('button', { name: vi_['cap.schedule.save.action'] })).toBeNull();
    cleanup();
    open(world(), INVESTOR, undefined, { mode: 'READ_ONLY' });
    await ready();
    expect(screen.getByTestId('register-denied').textContent).toBe(vi_['cap.readOnly.frozen.notice']);
  });

  it('offers only the projects that take capital, follows the address, and reads the year that was typed', async () => {
    const state = world();
    state.projects = [
      { id: PROJECT_A, code: 'DA-01', name: 'Đường vành đai 3', status: 'PIPELINE' },
      { id: PROJECT_B, code: 'DA-02', name: 'Cầu Thủ Thiêm 4', status: 'BUDGETED' },
      { id: '00000000-0000-4000-8000-000000000077', code: 'DA-77', name: 'Đã đóng', status: 'CLOSED' },
    ];
    const h = open(state, INVESTOR, undefined, { path: `/?project=${PROJECT_B}` });
    await ready();
    const options = Array.from((screen.getByLabelText(vi_['cap.schedule.project.label']) as HTMLSelectElement).options).map((option) => option.value);
    expect(options).toEqual([PROJECT_A, PROJECT_B]);
    expect((screen.getByLabelText(vi_['cap.schedule.project.label']) as HTMLSelectElement).value).toBe(PROJECT_B);
    expect(h.client.readAll).toHaveBeenCalledWith('listDisbursementSchedules', { query: expect.objectContaining({ project_id: PROJECT_B }) });
    fireEvent.change(screen.getByLabelText(vi_['cap.schedule.year.label']), { target: { value: '2031' } });
    await waitFor(() => expect(screen.getByTestId('grid').getAttribute('data-year')).toBe('2031'));
    expect(h.client.readAll).toHaveBeenCalledWith('listDisbursementSchedules', { query: expect.objectContaining({ plan_year: 2031 }) });
    // A year the server would not take is said, and no grid or form is shown for it.
    fireEvent.change(screen.getByLabelText(vi_['cap.schedule.year.label']), { target: { value: '31' } });
    expect(screen.getByText(vi_['cap.schedule.year.invalid.error'].replace('{min}', '1990').replace('{max}', '2100'))).toBeTruthy();
    expect(screen.queryByTestId('grid')).toBeNull();
    expect(screen.queryByTestId('register')).toBeNull();
    fireEvent.change(screen.getByLabelText(vi_['cap.schedule.project.label']), { target: { value: PROJECT_A } });
  });

  it('shows the empty state when no project takes capital, and the error state when the read fails', async () => {
    const none = world();
    none.projects = [];
    open(none);
    await waitFor(() => expect(screen.getByText(vi_['states.empty.title'])).toBeTruthy());
    cleanup();
    const failing = world();
    failing.failing.set('listDisbursementSchedules', problem('INTERNAL', 500));
    open(failing);
    await waitFor(() => expect(screen.getByText(vi_['states.error.title'])).toBeTruthy());
  });
});
