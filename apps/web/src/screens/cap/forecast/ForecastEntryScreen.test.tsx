import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import ForecastEntryScreen from './ForecastEntryScreen';
import { FAILURES, PROJECT_A, PROJECT_B, YEAR, allReadsOf, estimateAnswer, lineRow, millions, mount, open, problem, readsOf, routeOf, word } from './test-support';
import type { Served } from './test-support';

const ROUTE = routeOf('CAP-13', 'FR-CAP-13');
const REGISTRAR = ['capital.read', 'project.read', 'disbursement.read', 'capital.schedule.register'];
const READER = ['capital.read', 'project.read', 'disbursement.read'];
const answer = { operation_id: 'o', status: 'CURRENT', resource_version: 1, resource_id: 'r' };

afterEach(cleanup);

// DA-02 of the test register is BUDGETED and DA-01 PIPELINE: both can take an estimate; a project in another stage is not offered.
const NOVEMBER = lineRow(11, 'FORECAST', 'CURRENT_YEAR', millions(100), { assumption: 'Nghiệm thu khối lượng đợt 3' });
const DECEMBER = lineRow(12, 'FORECAST', 'CURRENT_YEAR', millions(150), { assumption: 'Giải ngân vốn còn lại', revision: 2 });

const show = (served: Served, permissions: readonly string[] = REGISTRAR, options: { mode?: 'FULL' | 'READ_ONLY'; path?: string; command?: (operation: string, input: unknown) => unknown } = {}) => {
  const h = open({ estimate: estimateAnswer(), ...served }, options.command ?? (() => answer));
  mount(<ForecastEntryScreen route={ROUTE} />, h, { permissions, ...(options.mode === undefined ? {} : { mode: options.mode }), path: options.path ?? '/cap/cap-13' });
  return h;
};
const type = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const save = () => fireEvent.click(screen.getByRole('button', { name: word('cap.estimate.save.action') }));
const commands = (h: ReturnType<typeof show>) => h.command.mock.calls as Array<[string, { body: Record<string, unknown> }]>;

describe('ForecastEntryScreen (CAP-13): the entry of the estimated disbursement', () => {
  it('UI-CAP-13: lists the estimates in force with their assumption and revision, the entry form, and the year-end estimate', async () => {
    const h = show({ lines: [DECEMBER, NOVEMBER, lineRow(11, 'REGISTERED', 'CURRENT_YEAR', millions(90))] });
    const table = await screen.findByTestId('estimates');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(word('cap.estimate.page.title'));
    expect(screen.getByTestId('promise').textContent).toBe(word('cap.estimate.note.assumption.notice'));
    await within(table).findByRole('table');
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.getAttribute('data-month')).toBe('11');
    expect(rows[0]?.textContent).toContain('100');
    expect(rows[0]?.querySelector('[data-testid="assumption"]')?.textContent).toBe('Nghiệm thu khối lượng đợt 3');
    expect(rows[1]?.getAttribute('data-month')).toBe('12');
    expect(rows[1]?.textContent).toContain('2');
    for (const key of ['cap.estimate.column.month', 'cap.estimate.column.amount', 'cap.estimate.column.assumption'] as const)
      expect(within(table).getByRole('columnheader', { name: word(key) })).toBeTruthy();
    expect(screen.getByRole('form', { name: word('cap.estimate.form.title') })).toBeTruthy();
    expect((await screen.findByTestId('eac-estimate')).textContent).toBe('650');
    expect(screen.getByTestId('back-to-plan').getAttribute('href')).toBe(`/cap/cap-12?project=${PROJECT_A}&year=${YEAR}`);
    expect(allReadsOf(h, 'listDisbursementSchedules')[0]?.[1]).toEqual({ query: { project_id: PROJECT_A, plan_year: Number(YEAR), granularity: 'MONTH' } });
  });

  it('AC-ST-CAP-012-1, UAT-AC232: changing the November estimate from 100 to 150 million sends the amount with its assumption, and the year-end estimate moves from 650 to 700 million', async () => {
    let november = 100;
    const h = show(
      {
        lines: () => [lineRow(11, 'FORECAST', 'CURRENT_YEAR', millions(november), { assumption: 'Nghiệm thu khối lượng đợt 3' }), DECEMBER],
        estimate: () => estimateAnswer({ eac_vnd: millions(400 + november + 150) }),
      },
      REGISTRAR,
      {
        command: () => {
          november = 150;
          return answer;
        },
      },
    );
    expect((await screen.findByTestId('eac-estimate')).textContent).toBe('650');
    fireEvent.click(await screen.findByRole('button', { name: word('cap.estimate.change.action').replace('{month}', '11') }));
    expect((screen.getByLabelText(word('cap.estimate.month.label')) as HTMLSelectElement).value).toBe('11');
    expect((screen.getByLabelText(word('cap.estimate.amount.label')) as HTMLInputElement).value).toBe('100');
    expect((screen.getByLabelText(word('cap.estimate.assumption.label')) as HTMLTextAreaElement).value).toBe('Nghiệm thu khối lượng đợt 3');
    type(word('cap.estimate.amount.label'), '150');
    type(word('cap.estimate.assumption.label'), '  Nhà thầu hoàn thành sớm hơn kế hoạch  ');
    type(word('cap.estimate.reason.label'), 'Cập nhật tiến độ');
    save();
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(commands(h)[0]).toEqual([
      'registerDisbursementSchedule',
      expect.objectContaining({
        body: {
          project_id: PROJECT_A,
          plan_year: Number(YEAR),
          granularity: 'MONTH',
          month: 11,
          kind: 'FORECAST',
          bucket: 'CURRENT_YEAR',
          budget_level: 'CENTRAL',
          amount_vnd: millions(150),
          assumption: 'Nhà thầu hoàn thành sớm hơn kế hoạch',
          revision_reason: 'Cập nhật tiến độ',
        },
      }),
    ]);
    expect((await screen.findByTestId('saved')).textContent).toBe(word('cap.estimate.save.done').replace('{revision}', '2'));
    await waitFor(() => expect(screen.getByTestId('eac-estimate').textContent).toBe('700'));
    // The form starts over for the next estimate.
    expect((screen.getByLabelText(word('cap.estimate.amount.label')) as HTMLInputElement).value).toBe('');
    expect(readsOf(h, 'getDisbursementForecast').length).toBeGreaterThan(1);
  });

  it('keeps what the person went on typing while the estimate is being registered, and clears the form when nothing was changed', async () => {
    let settle: () => void = () => undefined;
    const h = show({ lines: [] }, REGISTRAR, { command: () => new Promise((resolve) => (settle = () => resolve(answer))) });
    await screen.findByTestId('no-estimate');
    type(word('cap.estimate.month.label'), '13');
    type(word('cap.estimate.amount.label'), '0,5');
    type(word('cap.estimate.assumption.label'), 'Vốn kéo dài');
    save();
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    type(word('cap.estimate.amount.label'), '0,7');
    await act(async () => settle());
    await screen.findByTestId('saved');
    expect((screen.getByLabelText(word('cap.estimate.amount.label')) as HTMLInputElement).value).toBe('0,7');
    expect((screen.getByLabelText(word('cap.estimate.assumption.label')) as HTMLTextAreaElement).value).toBe('Vốn kéo dài');
    expect(h.command).toHaveBeenCalledTimes(1);
  });

  it('enters a first estimate for another source group and budget level, as exact VND, and says it is the first revision', async () => {
    const h = show({ lines: [] });
    expect((await screen.findByTestId('no-estimate')).textContent).toBe(word('cap.estimate.empty.notice'));
    type(word('cap.estimate.month.label'), '13');
    fireEvent.change(screen.getByLabelText(word('cap.schedule.bucket.label')), { target: { value: 'CARRYOVER' } });
    fireEvent.change(screen.getByLabelText(word('cap.schedule.level.label')), { target: { value: 'LOCAL' } });
    type(word('cap.estimate.amount.label'), '0,5');
    type(word('cap.estimate.assumption.label'), 'Vốn kéo dài');
    save();
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(commands(h)[0]?.[1].body).toMatchObject({ month: 13, bucket: 'CARRYOVER', budget_level: 'LOCAL', amount_vnd: '500000', assumption: 'Vốn kéo dài', kind: 'FORECAST' });
    expect(commands(h)[0]?.[1].body).not.toHaveProperty('revision_reason');
    expect((await screen.findByTestId('saved')).textContent).toBe(word('cap.estimate.save.done').replace('{revision}', '1'));
  });

  it('refuses before it sends: an estimate without its assumption, without a month or an amount, or with an amount that is not one', async () => {
    const h = show({ lines: [] });
    await screen.findByTestId('no-estimate');
    save();
    expect(await screen.findByText(word('cap.schedule.month.required.error'))).toBeTruthy();
    expect(screen.getByText(word('cap.schedule.amount.required.error'))).toBeTruthy();
    expect(screen.getByText(word('cap.estimate.assumption.required.error'))).toBeTruthy();
    type(word('cap.estimate.month.label'), '5');
    type(word('cap.estimate.amount.label'), 'nhiều');
    type(word('cap.estimate.assumption.label'), '   ');
    save();
    expect(await screen.findByText(word('cap.schedule.amount.invalid.error'))).toBeTruthy();
    expect(screen.getByText(word('cap.estimate.assumption.required.error'))).toBeTruthy();
    type(word('cap.estimate.amount.label'), '100');
    type(word('cap.estimate.assumption.label'), 'Có ký tự \u0001 lạ');
    save();
    expect(await screen.findByText(word('cap.estimate.assumption.invalid.error'))).toBeTruthy();
    type(word('cap.estimate.assumption.label'), 'Giả định hợp lệ');
    type(word('cap.estimate.reason.label'), 'x'.repeat(2000));
    expect(h.command).not.toHaveBeenCalled();
    expect(screen.queryByText(word('cap.estimate.assumption.invalid.error'))).toBeNull();
  });

  it('says how the server refused the estimate, and keeps what was typed', async () => {
    const h = show({ lines: [] }, REGISTRAR, {
      command: () => {
        throw problem(409, 'FISCAL_YEAR_LOCKED');
      },
    });
    await screen.findByTestId('no-estimate');
    type(word('cap.estimate.month.label'), '5');
    type(word('cap.estimate.amount.label'), '100');
    type(word('cap.estimate.assumption.label'), 'Giả định hợp lệ');
    save();
    const note = await screen.findByTestId('problem');
    expect(note.getAttribute('data-problem')).toBe('yearLocked');
    expect(note.textContent).toBe(word('cap.schedule.yearLocked.error'));
    expect((screen.getByLabelText(word('cap.estimate.amount.label')) as HTMLInputElement).value).toBe('100');
    expect(h.command).toHaveBeenCalledTimes(1);
  });

  it('shows the estimates without the form to whoever may not register, and says the session is frozen when it is read-only', async () => {
    show({ lines: [NOVEMBER] }, READER);
    await screen.findByTestId('estimates');
    expect((await screen.findByTestId('entry-denied')).textContent).toBe(word('cap.estimate.denied.notice'));
    expect(screen.queryByRole('form', { name: word('cap.estimate.form.title') })).toBeNull();
    expect(screen.queryByRole('button', { name: word('cap.estimate.change.action').replace('{month}', '11') })).toBeNull();
    cleanup();
    show({ lines: [NOVEMBER] }, REGISTRAR, { mode: 'READ_ONLY' });
    expect((await screen.findByTestId('entry-denied')).textContent).toBe(word('cap.readOnly.frozen.notice'));
  });

  it('offers only the projects that are in a stage that takes capital, and keeps the project and the year in the address', async () => {
    const h = show(
      {
        lines: [],
        projects: [
          { id: PROJECT_A, code: 'DA-01', name: 'Đường vành đai 3', status: 'CONCEPT' },
          { id: PROJECT_B, code: 'DA-02', name: 'Cầu Thủ Thiêm 4', status: 'IMPLEMENTATION' },
        ],
      },
      REGISTRAR,
      { path: `/cap/cap-13?year=2025` },
    );
    await screen.findByTestId('estimates');
    const select = screen.getByLabelText(word('cap.forecast.project.label')) as HTMLSelectElement;
    expect([...select.options].map((option) => option.value)).toEqual([PROJECT_B]);
    expect(select.value).toBe(PROJECT_B);
    expect(allReadsOf(h, 'listDisbursementSchedules')[0]?.[1]).toEqual({ query: { project_id: PROJECT_B, plan_year: 2025, granularity: 'MONTH' } });
    // Typing for one project and then choosing another does not carry the half-typed estimate over.
    type(word('cap.estimate.amount.label'), '77');
    type(word('cap.forecast.year.label'), '2026');
    await waitFor(() => expect((screen.getByLabelText(word('cap.estimate.amount.label')) as HTMLInputElement).value).toBe(''));
  });

  it('does not carry a half-typed estimate over to another project', async () => {
    show({ lines: [] });
    await screen.findByTestId('estimates');
    type(word('cap.estimate.amount.label'), '77');
    fireEvent.change(screen.getByLabelText(word('cap.forecast.project.label')), { target: { value: PROJECT_B } });
    await waitFor(() => expect((screen.getByLabelText(word('cap.estimate.amount.label')) as HTMLInputElement).value).toBe(''));
  });

  it('asks for a year the server takes before it shows the entry', async () => {
    show({ lines: [] }, REGISTRAR, { path: '/cap/cap-13?year=20x6' });
    expect(await screen.findByLabelText(word('cap.forecast.year.label'))).toBeTruthy();
    expect(screen.queryByTestId('estimates')).toBeNull();
    expect(screen.queryByRole('form', { name: word('cap.estimate.form.title') })).toBeNull();
  });

  it('keeps the entry when the estimates fail to load, with the card in the table', async () => {
    show({ lines: [], failing: { listDisbursementSchedules: problem(500, 'INTERNAL_ERROR') } });
    const table = await screen.findByTestId('estimates');
    expect(await within(table).findByText(word('states.error.title'))).toBeTruthy();
    expect(screen.getByRole('form', { name: word('cap.estimate.form.title') })).toBeTruthy();
  });

  it('shows the denied card and reads nothing when the caller may not read capital', async () => {
    const h = show({ lines: [] }, ['capital.schedule.register']);
    expect(await screen.findByText(word('states.denied.title'))).toBeTruthy();
    expect(screen.queryByRole('form', { name: word('cap.estimate.form.title') })).toBeNull();
    expect(allReadsOf(h, 'listDisbursementSchedules')).toHaveLength(0);
  });

  it('shows the empty card when no project can take an estimate, and the skeleton while the register is read', async () => {
    show({ lines: [], projects: [{ id: PROJECT_A, code: 'DA-01', name: 'x', status: 'CLOSED' }] });
    expect(await screen.findByText(word('states.empty.title'))).toBeTruthy();
    cleanup();
    const h = open({ lines: [] });
    (h.client as unknown as { readAll: unknown }).readAll = () => new Promise(() => undefined);
    mount(<ForecastEntryScreen route={ROUTE} />, h, { permissions: REGISTRAR, path: '/cap/cap-13' });
    expect(await screen.findByLabelText(word('states.loading.label'))).toBeTruthy();
  });

  for (const [name, failure, title] of FAILURES) {
    it(`shows the ${name} card when the register of projects fails, and reads again on retry`, async () => {
      const h = show({ lines: [], failing: { get_resources_project: failure } });
      expect(await screen.findByText(title)).toBeTruthy();
      expect(screen.queryByRole('form', { name: word('cap.estimate.form.title') })).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: word('states.retry.action') }));
      await waitFor(() => expect(allReadsOf(h, 'get_resources_project').length).toBeGreaterThan(1));
    });
  }
});
