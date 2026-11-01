import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import ForecastPlanScreen from './ForecastPlanScreen';
import { FAILURES, PROJECT_A, PROJECT_B, YEAR, allReadsOf, estimateAnswer, fill, lineRow, millions, mount, open, problem, readsOf, routeOf, word } from './test-support';
import type { Served } from './test-support';

const ROUTE = routeOf('CAP-12', 'FR-CAP-12');
const READER = ['capital.read', 'project.read', 'disbursement.read'];
const REGISTRAR = [...READER, 'capital.schedule.register'];

afterEach(cleanup);

const LINES = [
  lineRow(10, 'REGISTERED', 'CURRENT_YEAR', millions(800), { achievement: { disbursed_vnd: millions(300), rate: '0.3750' } }),
  lineRow(10, 'FORECAST', 'CURRENT_YEAR', millions(600)),
  lineRow(11, 'FORECAST', 'CURRENT_YEAR', millions(100)),
  lineRow(11, 'FORECAST', 'CARRYOVER', millions(50), { revision: 2 }),
  lineRow(11, 'REGISTERED', 'CURRENT_YEAR', millions(90), { achievement: { disbursed_vnd: '0', rate: '0.0000' } }),
  lineRow(12, 'FORECAST', 'CURRENT_YEAR', millions(150)),
  lineRow(12, 'WEEKLY_COMMITMENT', 'CURRENT_YEAR', millions(5), { granularity: 'WEEK' }),
];

const show = (served: Served, permissions: readonly string[] = READER, options: { mode?: 'FULL' | 'READ_ONLY'; path?: string } = {}) => {
  const h = open({ estimate: estimateAnswer(), ...served });
  mount(<ForecastPlanScreen route={ROUTE} />, h, { permissions, ...(options.mode === undefined ? {} : { mode: options.mode }), path: options.path ?? '/cap/cap-12' });
  return h;
};
const month = (n: number): HTMLElement => document.querySelector(`tr[data-month="${n}"]`) as HTMLElement;

describe('ForecastPlanScreen (CAP-12): the plan of estimated disbursement', () => {
  it('UI-CAP-12: shows each month with the estimate, the registration, the payment and the difference, and the year-end estimate of the project', async () => {
    const h = show({ lines: LINES });
    await screen.findByTestId('total-forecast');
    const plan = screen.getByTestId('plan');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(word('cap.forecast.page.title'));
    for (const key of ['cap.forecast.column.month', 'cap.forecast.column.forecast', 'cap.forecast.column.registered', 'cap.forecast.column.actual', 'cap.forecast.column.difference'] as const) {
      expect(within(plan).getByRole('columnheader', { name: word(key) })).toBeTruthy();
    }
    expect(screen.getByTestId('promise').textContent).toBe(word('cap.forecast.note.promise.notice'));
    expect(plan.querySelectorAll('tbody tr')).toHaveLength(13);
    // October: 600 estimated, 800 registered, 300 paid; the estimate is 200 below the registration.
    expect(within(month(10)).getByTestId('forecast').textContent).toBe('600');
    expect(within(month(10)).getByTestId('registered').textContent).toBe('800');
    expect(within(month(10)).getByTestId('actual').textContent).toBe('300');
    expect(within(month(10)).getByTestId('difference').textContent).toBe('-200');
    // November: two source groups of estimates are added; 150 over the 90 registered, nothing paid.
    expect(within(month(11)).getByTestId('forecast').textContent).toBe('150');
    expect(within(month(11)).getByTestId('difference').textContent).toBe('60');
    expect(within(month(11)).getByTestId('actual').textContent).toBe('0');
    // December has an estimate and no registration: no difference to speak of. A month with nothing says so.
    expect(within(month(12)).getByTestId('forecast').textContent).toBe('150');
    expect(within(month(12)).getByTestId('registered').textContent).toBe('—');
    expect(within(month(12)).getByTestId('difference').textContent).toBe('—');
    expect(within(month(3)).getByTestId('forecast').textContent).toBe('—');
    expect(screen.getByTestId('total-forecast').textContent).toBe('900');
    expect(screen.getByTestId('total-registered').textContent).toBe('890');
    expect(screen.getByTestId('total-actual').textContent).toBe('300');
    expect(screen.getByTestId('total-difference').textContent).toBe('10');
    expect(month(13).querySelector('th')?.textContent).toBe(word('cap.schedule.month.adjustment.label'));
    // The year-end estimate comes from DIS for this project.
    expect(await screen.findByTestId('eac-estimate')).toBeTruthy();
    expect(screen.getByTestId('eac-estimate').textContent).toBe('650');
    expect(screen.getByTestId('eac-disbursed').textContent).toBe('400');
    expect(screen.getByTestId('eac-plan').textContent).toBe('1.000');
    expect(screen.getByTestId('eac-gap').textContent).toBe('-350');
    expect(screen.getByTestId('eac-coverage').textContent).toBe(word('dis.forecast.coverage.complete'));
    expect(readsOf(h, 'getDisbursementForecast')[0]?.[1]).toEqual({ query: { project_id: PROJECT_A } });
    expect(allReadsOf(h, 'listDisbursementSchedules')[0]?.[1]).toEqual({ query: { project_id: PROJECT_A, plan_year: Number(YEAR), granularity: 'MONTH' } });
  });

  it('says when the project has nothing in the year, and writes the gaps of an estimate that is not complete', async () => {
    show({ lines: [], estimate: estimateAnswer({ eac_vnd: null, gap_vnd: null, disbursed_vnd: null, coverage: 'NONE' }) });
    expect((await screen.findByTestId('no-estimate')).textContent).toBe(word('cap.forecast.empty.notice'));
    expect(screen.getByTestId('total-forecast').textContent).toBe('—');
    expect(screen.getByTestId('total-difference').textContent).toBe('—');
    await screen.findByTestId('eac-estimate');
    expect(screen.getByTestId('eac-estimate').textContent).toBe('—');
    expect(screen.getByTestId('eac-gap').textContent).toBe('—');
    expect(screen.getByTestId('eac-disbursed').textContent).toBe('—');
    expect(screen.getByTestId('eac-coverage').textContent).toBe(word('dis.forecast.coverage.none'));
  });

  it('writes the coverage of an estimate that misses some months', async () => {
    show({ lines: LINES, estimate: estimateAnswer({ coverage: 'PARTIAL' }) });
    expect((await screen.findByTestId('eac-coverage')).textContent).toBe(word('dis.forecast.coverage.partial'));
  });

  it('sends whoever may register to the entry with the project and the year, and shows nobody else the way', async () => {
    show({ lines: LINES }, REGISTRAR);
    const link = await screen.findByTestId('enter');
    expect(link.getAttribute('href')).toBe(`/cap/cap-13?project=${PROJECT_A}&year=${YEAR}`);
    cleanup();
    show({ lines: LINES }, READER);
    await screen.findByTestId('total-forecast');
    expect(screen.queryByTestId('enter')).toBeNull();
    cleanup();
    show({ lines: LINES }, REGISTRAR, { mode: 'READ_ONLY' });
    await screen.findByTestId('total-forecast');
    expect(screen.queryByTestId('enter')).toBeNull();
  });

  it('keeps the project and the year in the address, and reads again for another project', async () => {
    const h = show({ lines: LINES }, READER, { path: `/cap/cap-12?project=${PROJECT_B}&year=2025` });
    await screen.findByTestId('total-forecast');
    expect((screen.getByLabelText(word('cap.forecast.project.label')) as HTMLSelectElement).value).toBe(PROJECT_B);
    expect((screen.getByLabelText(word('cap.forecast.year.label')) as HTMLInputElement).value).toBe('2025');
    expect(allReadsOf(h, 'listDisbursementSchedules')[0]?.[1]).toEqual({ query: { project_id: PROJECT_B, plan_year: 2025, granularity: 'MONTH' } });
    fireEvent.change(screen.getByLabelText(word('cap.forecast.project.label')), { target: { value: PROJECT_A } });
    fireEvent.change(screen.getByLabelText(word('cap.forecast.year.label')), { target: { value: '2027' } });
    await waitFor(() =>
      expect(
        allReadsOf(h, 'listDisbursementSchedules').some(([, input]) => JSON.stringify(input) === JSON.stringify({ query: { project_id: PROJECT_A, plan_year: 2027, granularity: 'MONTH' } })),
      ).toBe(true),
    );
    expect(await screen.findByLabelText(word('cap.forecast.table.aria').replace('{year}', '2027'))).toBeTruthy();
  });

  it('asks for a year the server takes, and reads no schedule for a year that is not one', async () => {
    const h = show({ lines: LINES }, READER, { path: '/cap/cap-12?year=20x6' });
    expect(await screen.findByText(fill(word('cap.forecast.year.invalid.error'), { min: 1990, max: 2100 }))).toBeTruthy();
    expect(screen.queryByTestId('plan')).toBeNull();
    expect(allReadsOf(h, 'listDisbursementSchedules')).toHaveLength(0);
  });

  it('tells whoever may not read DIS that the year-end estimate is not shown, and asks DIS nothing', async () => {
    const h = show({ lines: LINES }, ['capital.read', 'project.read']);
    await screen.findByTestId('total-forecast');
    expect(screen.getByTestId('eac-hidden').textContent).toBe(word('cap.forecast.eac.hidden.notice'));
    expect(readsOf(h, 'getDisbursementForecast')).toHaveLength(0);
  });

  it('keeps the plan when the year-end estimate fails, and says in its own card that it failed', async () => {
    show({ lines: LINES, estimate: problem(500, 'INTERNAL_ERROR') });
    await screen.findByTestId('total-forecast');
    expect(await within(screen.getByTestId('eac')).findByText(word('states.error.title'))).toBeTruthy();
    expect(screen.getByTestId('total-forecast').textContent).toBe('900');
  });

  it('shows the empty card in the estimate when DIS gives none for the project', async () => {
    show({ lines: LINES, estimate: {} });
    expect(await within(await screen.findByTestId('eac')).findByText(word('states.empty.title'))).toBeTruthy();
  });

  it('shows the denied card and reads nothing when the caller may not read capital', async () => {
    const h = show({ lines: LINES }, ['disbursement.read']);
    expect(await screen.findByText(word('states.denied.title'))).toBeTruthy();
    expect(screen.queryByTestId('plan')).toBeNull();
    expect(allReadsOf(h, 'listDisbursementSchedules')).toHaveLength(0);
    expect(readsOf(h, 'getDisbursementForecast')).toHaveLength(0);
  });

  it('shows the empty card when no project is in the register, and the skeleton while it is read', async () => {
    show({ lines: [], projects: [] });
    expect(await screen.findByText(word('states.empty.title'))).toBeTruthy();
    cleanup();
    const h = open({ lines: [] });
    (h.client as unknown as { readAll: unknown }).readAll = () => new Promise(() => undefined);
    mount(<ForecastPlanScreen route={ROUTE} />, h, { permissions: READER, path: '/cap/cap-12' });
    expect(await screen.findByLabelText(word('states.loading.label'))).toBeTruthy();
  });

  for (const [name, failure, title] of FAILURES) {
    it(`shows the ${name} card when the schedules fail, and reads again on retry`, async () => {
      const h = show({ lines: LINES, failing: { listDisbursementSchedules: failure } });
      expect(await screen.findByText(title)).toBeTruthy();
      expect(screen.queryByTestId('total-forecast')).toBeNull();
      expect(screen.getByLabelText(word('cap.forecast.project.label'))).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: word('states.retry.action') }));
      await waitFor(() => expect(allReadsOf(h, 'listDisbursementSchedules').length).toBeGreaterThan(1));
    });
  }

  it('shows the error card when the register of projects fails', async () => {
    show({ lines: LINES, failing: { get_resources_project: problem(500, 'INTERNAL_ERROR') } });
    expect(await screen.findByText(word('states.error.title'))).toBeTruthy();
  });
});
