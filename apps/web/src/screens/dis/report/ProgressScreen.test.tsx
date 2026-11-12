import { ApiError, NETWORK_ERROR_CODE } from '@machvon/api-client';
import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import ProgressScreen from './ProgressScreen';
import { MAKER, PLAN_VERSION, READER, REPORT, client, lineRecord, mount, pageRecord, progressRecord, reportRecord, routeOf, world } from './test-support';

const ROUTE = routeOf('DIS-03', 'FR-DIS-03');
const PATH = `/dis/dis-03?report=${REPORT}`;

afterEach(cleanup);

const open = (record: Record<string, unknown> = reportRecord(), command: (operation: string, input: unknown) => unknown = () => ({ status: 'DRAFT', resource_version: 4 }), permissions: readonly string[] | undefined = MAKER, mode?: 'FULL' | 'READ_ONLY') => {
  const h = client(world({ details: { [REPORT]: record } }), command);
  mount(<ProgressScreen route={ROUTE} />, h, { permissions, path: PATH, ...(mode === undefined ? {} : { mode }) });
  return h;
};
const input = (field: string): HTMLInputElement => document.getElementById(`volume-${field}`) as HTMLInputElement;
const fill = async (user: ReturnType<typeof userEvent.setup>, field: string, value: string) => {
  await user.clear(input(field));
  await user.type(input(field), value);
};
const fillAll = async (user: ReturnType<typeof userEvent.setup>) => {
  await fill(user, 'construction', '300.000.000');
  await fill(user, 'acceptance', '200.000.000');
  await fill(user, 'treasury', '150.000.000');
  await fill(user, 'preparing', '50.000.000');
};

describe('DIS-03 enter the volumes', () => {
  it('AC-ST-DIS-004-1: shows the report, the steps of the draft with this one marked, the date of the figures, and the basis of the year to date as awaiting the sign-off', async () => {
    open();
    expect(await screen.findByRole('heading', { level: 1, name: vi_['dis.progress.page.title'] })).toBeTruthy();
    await screen.findByTestId('report-facts');
    expect(screen.getByTestId('fact-project').textContent).toBe('DA-2027-001 · Cầu qua sông');
    expect(screen.getByTestId('progress-note').textContent).toBe(`${vi_['dis.progress.note']} ${vi_['dis.progress.asOf.text'].replace('{date}', '2027-01-10')}`);
    const steps = screen.getByRole('navigation', { name: vi_['dis.reportSteps.nav.aria'] });
    expect(Array.from(steps.querySelectorAll('a')).map((link) => [link.textContent, link.getAttribute('href'), link.getAttribute('aria-current')])).toEqual([
      [vi_['dis.reportSteps.progress.link'], `/dis/dis-03?report=${REPORT}`, 'step'],
      [vi_['dis.reportSteps.cells.link'], `/dis/dis-04?report=${REPORT}`, null],
      [vi_['dis.reportSteps.registration.link'], `/dis/dis-05?report=${REPORT}`, null],
      [vi_['dis.reportSteps.review.link'], `/dis/dis-06?report=${REPORT}`, null],
    ]);
    expect((screen.getByLabelText(vi_['dis.reportEdit.basis.label']) as HTMLSelectElement).value).toBe('YTD');
    expect(screen.getByTestId('basis-pending').textContent).toBe(vi_['dis.progress.basis.pending']);
    expect(input('construction').value).toBe('');
  });

  it('shows the volumes that were kept, and takes the mark away when the basis is not the year to date', async () => {
    const user = userEvent.setup();
    open(reportRecord({ progress: progressRecord() }));
    await screen.findByTestId('report-facts');
    expect([input('construction').value, input('acceptance').value, input('treasury').value, input('preparing').value, input('percent').value]).toEqual(['300.000.000', '200.000.000', '150.000.000', '50.000.000', '37.50']);
    await user.selectOptions(screen.getByLabelText(vi_['dis.reportEdit.basis.label']), 'PERIOD');
    expect(screen.queryByTestId('basis-pending')).toBeNull();
  });

  it('saves the four amounts, the percent and the basis under the version of the report and takes the person to the draft that was saved (DIS-18)', async () => {
    const user = userEvent.setup();
    const h = open();
    await screen.findByTestId('report-facts');
    await fillAll(user);
    await fill(user, 'percent', '37,5');
    await user.selectOptions(screen.getByLabelText(vi_['dis.reportEdit.basis.label']), 'PERIOD');
    await user.click(screen.getByRole('button', { name: vi_['dis.progress.save.action'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(h.command.mock.calls[0]?.[0]).toBe('post_reports_id_revisions');
    expect(h.command.mock.calls[0]?.[1]).toMatchObject({
      path: { id: REPORT },
      ifMatchVersion: 3,
      body: { measurement_basis: 'PERIOD', plan_version_id: PLAN_VERSION, construction_vnd: '300000000', acceptance_vnd: '200000000', treasury_submitted_vnd: '150000000', preparing_dossier_vnd: '50000000', physical_progress_pct: '37.5' },
    });
    const sent = h.command.mock.calls[0]?.[1] as { body: { funding_lines: unknown[] } };
    expect(sent.body.funding_lines).toHaveLength(6);
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe(`/dis/dis-18?report=${REPORT}`));
  });

  it('tells what is missing and what is wrong in words, and sends nothing', async () => {
    const user = userEvent.setup();
    const h = open();
    await screen.findByTestId('report-facts');
    await user.click(screen.getByRole('button', { name: vi_['dis.progress.save.action'] }));
    expect(screen.getAllByText(vi_['dis.progress.problem.required'])).toHaveLength(4);
    await fillAll(user);
    await fill(user, 'construction', '12x');
    await fill(user, 'percent', '101');
    await user.click(screen.getByRole('button', { name: vi_['dis.progress.save.action'] }));
    expect(await screen.findByText(vi_['dis.progress.problem.invalid'])).toBeTruthy();
    expect(screen.getByText(vi_['dis.progress.problem.range'])).toBeTruthy();
    expect(input('construction').getAttribute('aria-invalid')).toBe('true');
    expect(h.command).not.toHaveBeenCalled();
  });

  const REFUSALS: Array<[string, string]> = [
    ['VERSION_CONFLICT', vi_['dis.reportProblem.versionConflict']],
    ['REVISION_IMMUTABLE', vi_['dis.reportProblem.immutable']],
    ['PERIOD_LOCKED', vi_['dis.reportProblem.periodLocked']],
    ['VALIDATION_FAILED', vi_['dis.reportProblem.validation']],
    ['SOMETHING_ELSE', vi_['dis.reportProblem.general']],
  ];
  it.each(REFUSALS)('tells the refusal %s in words and keeps what was typed', async (code, message) => {
    const user = userEvent.setup();
    open(reportRecord(), () => new ApiError({ status: 409, code, correlationId: 'c' }));
    await screen.findByTestId('report-facts');
    await fillAll(user);
    await user.click(screen.getByRole('button', { name: vi_['dis.progress.save.action'] }));
    expect((await screen.findByTestId('refusal')).textContent).toBe(message);
    expect(input('construction').value).toBe('300.000.000');
    expect(screen.getByTestId('location').textContent).toBe(PATH);
  });

  it('shows a report that was handed in, and a draft the person may not edit, as read only', async () => {
    open(reportRecord({ status: 'SUBMITTED' }));
    await screen.findByTestId('report-facts');
    expect(screen.getByTestId('readonly-note').textContent).toBe(vi_['dis.progress.readonly.note']);
    expect(input('construction').disabled).toBe(true);
    expect(screen.queryByRole('button', { name: vi_['dis.progress.save.action'] })).toBeNull();
    cleanup();
    open(reportRecord(), undefined, READER);
    await screen.findByTestId('report-facts');
    expect(screen.getByTestId('readonly-note').textContent).toBe(vi_['dis.progress.denied.note']);
    expect(screen.queryByRole('button', { name: vi_['dis.progress.save.action'] })).toBeNull();
    cleanup();
    open(reportRecord(), undefined, MAKER, 'READ_ONLY');
    await screen.findByTestId('report-facts');
    expect(screen.queryByRole('button', { name: vi_['dis.progress.save.action'] })).toBeNull();
  });

  it('opens on the first draft of the list when none is chosen, says so, and offers the list to switch (menu entry)', async () => {
    const h = client(world({ details: { [REPORT]: reportRecord() }, page: pageRecord([lineRecord(1), lineRecord(2)]) }));
    mount(<ProgressScreen route={ROUTE} />, h, { permissions: MAKER, path: '/dis/dis-03' });
    expect((await screen.findByTestId('default-report')).textContent).toContain(vi_['dis.default.notice']);
    await screen.findByTestId('report-facts');
    const select = screen.getByTestId('default-report-select') as HTMLSelectElement;
    expect(select.value).toBe(REPORT);
    expect(select.querySelectorAll('option')).toHaveLength(2);
    expect(h.read).toHaveBeenCalledWith('get_resources_report_revision', expect.objectContaining({ query: expect.objectContaining({ status: 'DRAFT' }) }));
    expect(screen.queryByTestId('report-choose')).toBeNull();
  });

  it('names no default and reads no list when the address names the report', async () => {
    const h = open();
    await screen.findByTestId('report-facts');
    expect(screen.queryByTestId('default-report')).toBeNull();
    expect(h.read).not.toHaveBeenCalledWith('get_resources_report_revision', expect.anything());
  });

  it('asks for a report when none is chosen, and says nothing is there for one that is not found', async () => {
    mount(<ProgressScreen route={ROUTE} />, client(world()), { permissions: MAKER, path: '/dis/dis-03' });
    expect((await screen.findByTestId('report-choose')).textContent).toBe(vi_['dis.progress.choose.text']);
    expect(screen.queryByRole('navigation', { name: vi_['dis.reportSteps.nav.aria'] })).toBeNull();
    cleanup();
    mount(<ProgressScreen route={ROUTE} />, client(world()), { permissions: MAKER, path: PATH });
    expect(await screen.findByText(vi_['states.empty.title'])).toBeTruthy();
  });

  it('shows a loading state first, then the denied, signed-out, offline and error states', async () => {
    const failing = (error: Error) => {
      const state = world({ details: { [REPORT]: reportRecord() } });
      state.failing.set('getReportRevision', error);
      return client(state);
    };
    mount(<ProgressScreen route={ROUTE} />, failing(new ApiError({ status: 403, code: 'SCOPE_DENIED', correlationId: 'c' })), { permissions: MAKER, path: PATH });
    expect(screen.getByRole('status', { name: vi_['states.loading.label'] })).toBeTruthy();
    expect(await screen.findByText(vi_['states.denied.title'])).toBeTruthy();
    cleanup();
    mount(<ProgressScreen route={ROUTE} />, failing(new ApiError({ status: 401, code: 'SESSION_EXPIRED', correlationId: 'c' })), { permissions: MAKER, path: PATH });
    expect(await screen.findByText(vi_['states.signedOut.title'])).toBeTruthy();
    cleanup();
    mount(<ProgressScreen route={ROUTE} />, failing(new ApiError({ status: 0, code: NETWORK_ERROR_CODE, correlationId: 'c' })), { permissions: MAKER, path: PATH });
    expect(await screen.findByText(vi_['states.offline.title'])).toBeTruthy();
    cleanup();
    mount(<ProgressScreen route={ROUTE} />, failing(new ApiError({ status: 500, code: 'INTERNAL_ERROR', correlationId: 'c' })), { permissions: MAKER, path: PATH });
    expect(await screen.findByText(vi_['states.error.title'])).toBeTruthy();
  });
});
