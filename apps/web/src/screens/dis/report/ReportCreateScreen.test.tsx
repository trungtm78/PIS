import { ApiError, NETWORK_ERROR_CODE } from '@machvon/api-client';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import { MAKER, PERIOD, PERIOD_LOCKED, PROJECT, READER, REPORT, client, mount, period, routeOf, world } from './test-support';
import ReportCreateScreen from './ReportCreateScreen';

const ROUTE = routeOf('DIS-02', 'FR-DIS-02');

afterEach(cleanup);

const open = (command: (operation: string, input: unknown) => unknown = () => ({ status: 'DRAFT', resource_id: REPORT, resource_version: 1 }), permissions: readonly string[] | undefined = MAKER, mode?: 'FULL' | 'READ_ONLY') => {
  const h = client(world(), command);
  mount(<ReportCreateScreen route={ROUTE} />, h, { permissions, path: '/dis/dis-02', ...(mode === undefined ? {} : { mode }) });
  return h;
};

const fill = async (user: ReturnType<typeof userEvent.setup>, period = PERIOD, project = PROJECT) => {
  await screen.findByTestId('create-note');
  await user.selectOptions(screen.getByLabelText(vi_['dis.reportCreate.year.label']), '2027');
  await user.selectOptions(screen.getByLabelText(vi_['dis.reportCreate.period.label']), period);
  await user.selectOptions(screen.getByLabelText(vi_['dis.reportCreate.project.label']), project);
};

describe('DIS-02 choose the period and the project', () => {
  it('asks for the year, the week, the project and the basis, and says what the system captures', async () => {
    open();
    expect(await screen.findByRole('heading', { level: 1, name: vi_['dis.reportCreate.page.title'] })).toBeTruthy();
    expect((await screen.findByTestId('create-note')).textContent).toBe(vi_['dis.reportCreate.note']);
    const week = screen.getByLabelText(vi_['dis.reportCreate.period.label']) as HTMLSelectElement;
    expect(within(week).getAllByRole('option').map((option) => option.textContent)).toEqual([vi_['dis.reportCreate.period.choose']]);
    await userEvent.setup().selectOptions(screen.getByLabelText(vi_['dis.reportCreate.year.label']), '2027');
    expect(within(week).getAllByRole('option').map((option) => option.textContent)).toEqual([
      vi_['dis.reportCreate.period.choose'],
      vi_['dis.reportCreate.period.option'].replace('{code}', '2027-W01').replace('{start}', '2027-01-04').replace('{end}', '2027-01-10').replace('{status}', vi_['dis.calendar.status.open.text']),
      vi_['dis.reportCreate.period.option'].replace('{code}', '2027-W02').replace('{start}', '2027-01-04').replace('{end}', '2027-01-10').replace('{status}', vi_['dis.calendar.status.locked.text']),
    ]);
    const basis = screen.getByLabelText(vi_['dis.reportCreate.basis.label']) as HTMLSelectElement;
    expect(basis.value).toBe('YTD');
    expect(within(basis).getAllByRole('option').map((option) => option.textContent)).toEqual([vi_['dis.reportBasis.period'], vi_['dis.reportBasis.ytd'], vi_['dis.reportBasis.projectToDate']]);
  });

  it('ST-DIS-015: offers only weeks for a weekly report, even when the calendar also has months', async () => {
    const month = { ...period('00000000-0000-4000-8000-0000000000f2', '2027-M01', 'OPEN'), period_type: 'MONTH', start_date: '2027-01-01', end_date: '2027-01-31' };
    const h = client(world({ periods: [period(PERIOD, '2027-W01', 'OPEN'), month] }));
    mount(<ReportCreateScreen route={ROUTE} />, h, { permissions: MAKER, path: '/dis/dis-02' });
    await screen.findByTestId('create-note');
    await userEvent.setup().selectOptions(screen.getByLabelText(vi_['dis.reportCreate.year.label']), '2027');
    const options = within(screen.getByLabelText(vi_['dis.reportCreate.period.label'])).getAllByRole('option').map((option) => option.textContent ?? '');
    expect(options).toHaveLength(2);
    expect(options.join(' ')).toContain('2027-W01');
    expect(options.join(' ')).not.toContain('2027-M01');
  });

  it('asks for the week and the project before it sends anything', async () => {
    const user = userEvent.setup();
    const h = open();
    await screen.findByTestId('create-note');
    await user.click(screen.getByRole('button', { name: vi_['dis.reportCreate.submit.action'] }));
    expect(screen.getByText(vi_['dis.reportCreate.period.required'])).toBeTruthy();
    expect(screen.getByText(vi_['dis.reportCreate.project.required'])).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
  });

  it('starts the draft of the project for the period and takes the person to its entry (DIS-04)', async () => {
    const user = userEvent.setup();
    const h = open();
    await fill(user);
    await user.selectOptions(screen.getByLabelText(vi_['dis.reportCreate.basis.label']), 'PERIOD');
    await user.click(screen.getByRole('button', { name: vi_['dis.reportCreate.submit.action'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(h.command.mock.calls[0]?.[0]).toBe('post_reports');
    expect(h.command.mock.calls[0]?.[1]).toMatchObject({ body: { project_id: PROJECT, period_id: PERIOD, measurement_basis: 'PERIOD', report_type: 'WEEKLY', funding_lines: [] } });
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe(`/dis/dis-04?report=${REPORT}`));
  });

  it('stays where it is when the answer names no report', async () => {
    const user = userEvent.setup();
    open(() => ({ status: 'DRAFT' }));
    await fill(user);
    await user.click(screen.getByRole('button', { name: vi_['dis.reportCreate.submit.action'] }));
    await waitFor(() => expect(screen.getByRole('button', { name: vi_['dis.reportCreate.submit.action'] })).toBeTruthy());
    expect(screen.getByTestId('location').textContent).toBe('/dis/dis-02');
  });

  it('tells a locked period and leads to the request to reopen it', async () => {
    const user = userEvent.setup();
    open();
    await fill(user, PERIOD_LOCKED);
    expect(screen.getByTestId('locked-note').textContent).toContain(vi_['dis.reportCreate.locked.note']);
    expect(screen.getByRole('link', { name: vi_['dis.reportCreate.locked.link'] }).getAttribute('href')).toBe('/dis/dis-22');
  });

  it('AC-ST-DIS-003-3 / UAT-PLAN-67: tells that the project has a draft in the period, and leads to it', async () => {
    const user = userEvent.setup();
    open(() => new ApiError({ status: 409, code: 'DRAFT_EXISTS', correlationId: 'c', extensions: { report_id: REPORT, revision: 1, report_status: 'DRAFT' } }));
    await fill(user);
    await user.click(screen.getByRole('button', { name: vi_['dis.reportCreate.submit.action'] }));
    const refusal = await screen.findByTestId('refusal');
    expect(refusal.textContent).toContain(vi_['dis.reportProblem.draftExists']);
    expect(within(refusal).getByRole('link', { name: vi_['dis.reportCreate.existing.link'] }).getAttribute('href')).toBe(`/dis/dis-04?report=${REPORT}`);
  });

  const REFUSALS: Array<[string, string]> = [
    ['REPORT_STATE_INVALID', vi_['dis.reportProblem.reportExists']],
    ['PERIOD_LOCKED', vi_['dis.reportProblem.periodLocked']],
    ['PLAN_VERSION_NOT_EFFECTIVE', vi_['dis.reportProblem.planNotEffective']],
    ['PROJECT_STAGE_INVALID', vi_['dis.reportProblem.stageInvalid']],
    ['SCOPE_DENIED', vi_['dis.reportProblem.scopeDenied']],
    ['RESOURCE_NOT_FOUND', vi_['dis.reportProblem.notFound']],
    ['SOMETHING_ELSE', vi_['dis.reportProblem.general']],
  ];

  it.each(REFUSALS)('tells the refusal %s in words and keeps what was chosen', async (code, message) => {
    const user = userEvent.setup();
    open(() => new ApiError({ status: 422, code, correlationId: 'c' }));
    await fill(user);
    await user.click(screen.getByRole('button', { name: vi_['dis.reportCreate.submit.action'] }));
    expect((await screen.findByTestId('refusal')).textContent).toBe(message);
    expect((screen.getByLabelText(vi_['dis.reportCreate.project.label']) as HTMLSelectElement).value).toBe(PROJECT);
  });

  it('does not let a person without the right to create start a draft, nor one in a tenant that is read only', async () => {
    const user = userEvent.setup();
    const h = open(undefined, READER);
    await screen.findByTestId('create-note');
    expect(screen.getByTestId('create-denied').textContent).toBe(vi_['dis.reportCreate.denied.note'].replace('{permission}', 'report.create'));
    const button = screen.getByRole('button', { name: vi_['dis.reportCreate.submit.action'] }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    await user.click(button);
    expect(h.command).not.toHaveBeenCalled();
    cleanup();
    open(undefined, MAKER, 'READ_ONLY');
    await screen.findByTestId('create-note');
    expect((screen.getByRole('button', { name: vi_['dis.reportCreate.submit.action'] }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows a loading state first, then the denied, signed-out, offline and error states', async () => {
    const failing = (error: Error) => {
      const state = world();
      state.failing.set('get_resources_reporting_period', error);
      return client(state);
    };
    mount(<ReportCreateScreen route={ROUTE} />, failing(new ApiError({ status: 403, code: 'SCOPE_DENIED', correlationId: 'c' })), { permissions: MAKER, path: '/dis/dis-02' });
    expect(screen.getByRole('status', { name: vi_['states.loading.label'] })).toBeTruthy();
    expect(await screen.findByText(vi_['states.denied.title'])).toBeTruthy();
    cleanup();
    mount(<ReportCreateScreen route={ROUTE} />, failing(new ApiError({ status: 401, code: 'SESSION_EXPIRED', correlationId: 'c' })), { permissions: MAKER, path: '/dis/dis-02' });
    expect(await screen.findByText(vi_['states.signedOut.title'])).toBeTruthy();
    cleanup();
    mount(<ReportCreateScreen route={ROUTE} />, failing(new ApiError({ status: 0, code: NETWORK_ERROR_CODE, correlationId: 'c' })), { permissions: MAKER, path: '/dis/dis-02' });
    expect(await screen.findByText(vi_['states.offline.title'])).toBeTruthy();
    cleanup();
    mount(<ReportCreateScreen route={ROUTE} />, failing(new ApiError({ status: 500, code: 'INTERNAL_ERROR', correlationId: 'c' })), { permissions: MAKER, path: '/dis/dis-02' });
    expect(await screen.findByText(vi_['states.error.title'])).toBeTruthy();
  });
});
