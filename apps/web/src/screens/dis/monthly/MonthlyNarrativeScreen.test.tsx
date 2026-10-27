import { ApiError } from '@machvon/api-client';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import { MAKER, PROJECT, READER, REPORT, client, mount, period, reportRecord, routeOf, world } from '../report/test-support';
import MonthlyNarrativeScreen from './MonthlyNarrativeScreen';

const ROUTE = routeOf('DIS-13', 'FR-DIS-13');
const PATH = '/dis/dis-13';
const MONTH_ID = '00000000-0000-4000-8000-0000000000f1';
const MONTH = { ...period(MONTH_ID, '2027-M09', 'OPEN'), period_type: 'MONTH', start_date: '2027-09-01', end_date: '2027-09-30' };
const monthly = (over: Record<string, unknown> = {}) => reportRecord({ report_type: 'MONTHLY', period: { id: MONTH_ID, code: '2027-M09', period_type: 'MONTH', fiscal_year: 2027, start_date: '2027-09-01', end_date: '2027-09-30', status: 'OPEN' }, ...over });

afterEach(cleanup);

const start = (command: (operation: string, input: unknown) => unknown = () => ({ status: 'DRAFT', resource_id: REPORT, resource_version: 1 }), permissions: readonly string[] | undefined = MAKER) => {
  const h = client(world({ periods: [MONTH], details: { [REPORT]: monthly() } }), command);
  mount(<MonthlyNarrativeScreen route={ROUTE} />, h, { permissions, path: PATH });
  return h;
};
const edit = (record: Record<string, unknown> = monthly(), permissions: readonly string[] | undefined = MAKER, command: (operation: string, input: unknown) => unknown = () => ({ status: 'DRAFT', resource_version: 4 })) => {
  const h = client(world({ periods: [MONTH], details: { [REPORT]: record } }), command);
  mount(<MonthlyNarrativeScreen route={ROUTE} />, h, { permissions, path: `${PATH}?report=${REPORT}` });
  return h;
};
const bodyOf = (h: ReturnType<typeof client>): Record<string, unknown> => (h.command.mock.calls.find((call) => call[0] === 'post_reports_id_revisions')?.[1] as { body: Record<string, unknown> }).body;

describe('DIS-13 monthly narrative report', () => {
  it('starts the monthly draft of a project for a month: only months are offered, and the draft is created as a MONTHLY report', async () => {
    const user = userEvent.setup();
    const h = start();
    expect(await screen.findByRole('heading', { level: 1, name: vi_['dis.monthly.page.title'] })).toBeTruthy();
    const month = (await screen.findByLabelText(vi_['dis.monthly.month.label'])) as HTMLSelectElement;
    expect(within(month).getAllByRole('option').map((option) => option.textContent)).toEqual([vi_['dis.monthly.month.choose'], vi_['dis.monthly.month.option'].replace('{code}', '2027-M09').replace('{start}', '2027-09-01').replace('{end}', '2027-09-30')]);
    await user.click(screen.getByRole('button', { name: vi_['dis.monthly.start.action'] }));
    expect(await screen.findByText(vi_['dis.monthly.month.required'])).toBeTruthy();
    expect(screen.getByText(vi_['dis.monthly.project.required'])).toBeTruthy();
    expect(h.command.mock.calls.some((call) => call[0] === 'post_reports')).toBe(false);
    await user.selectOptions(month, MONTH_ID);
    await user.selectOptions(screen.getByLabelText(vi_['dis.monthly.project.label']), PROJECT);
    await user.click(screen.getByRole('button', { name: vi_['dis.monthly.start.action'] }));
    await waitFor(() => expect(h.command.mock.calls.some((call) => call[0] === 'post_reports')).toBe(true));
    const sent = (h.command.mock.calls.find((call) => call[0] === 'post_reports')?.[1] as { body: Record<string, unknown> }).body;
    expect(sent).toMatchObject({ project_id: PROJECT, period_id: MONTH_ID, report_type: 'MONTHLY' });
    // The narrative of the new draft opens on the same screen.
    expect(await screen.findByRole('heading', { level: 2, name: vi_['dis.monthly.narrative.title'].replace('{project}', 'DA-2027-001').replace('{period}', '2027-M09') })).toBeTruthy();
  });

  it('tells that the project already has a draft for the month and leads to it; a person without the right to create is told so', async () => {
    const user = userEvent.setup();
    start(() => new ApiError({ status: 409, code: 'DRAFT_EXISTS', correlationId: 'c', extensions: { report_id: REPORT, revision: 1, report_status: 'DRAFT' } }));
    await screen.findByLabelText(vi_['dis.monthly.month.label']);
    await user.selectOptions(screen.getByLabelText(vi_['dis.monthly.month.label']), MONTH_ID);
    await user.selectOptions(screen.getByLabelText(vi_['dis.monthly.project.label']), PROJECT);
    await user.click(screen.getByRole('button', { name: vi_['dis.monthly.start.action'] }));
    const refusal = await screen.findByTestId('refusal');
    expect(within(refusal).getByRole('link', { name: vi_['dis.monthly.existing.link'] }).getAttribute('href')).toBe(`${PATH}?report=${REPORT}`);
    cleanup();
    start(undefined, READER);
    expect(await screen.findByTestId('create-denied')).toBeTruthy();
    expect((screen.getByRole('button', { name: vi_['dis.monthly.start.action'] }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('AC-ST-DIS-015-2 / UAT-AC262: says the causes are required to send, saves the whole narrative under the version shown, and leads to the review where the server judges the send', async () => {
    const user = userEvent.setup();
    const h = edit();
    expect(await screen.findByText(vi_['dis.monthly.causes.required'])).toBeTruthy();
    await user.type(screen.getByLabelText(vi_['dis.monthly.field.results']), 'Đạt 60% khối lượng');
    await user.type(screen.getByLabelText(vi_['dis.monthly.field.causes']), 'Chờ phê duyệt điều chỉnh thiết kế');
    expect(screen.getByText(vi_['dis.monthly.causes.hint'])).toBeTruthy();
    await user.click(screen.getByRole('button', { name: vi_['dis.monthly.save.action'] }));
    expect(await screen.findByTestId('narrative-saved')).toBeTruthy();
    expect(bodyOf(h).narrative).toEqual({ results: 'Đạt 60% khối lượng', causes: 'Chờ phê duyệt điều chỉnh thiết kế' });
    expect(h.command.mock.calls.find((call) => call[0] === 'post_reports_id_revisions')?.[1]).toMatchObject({ path: { id: REPORT }, ifMatchVersion: 3 });
    expect(screen.getByRole('link', { name: vi_['dis.monthly.review.link'] }).getAttribute('href')).toBe(`/dis/dis-06?report=${REPORT}`);
  });

  it('keeps the confirmation and what was typed when the report is read again at the next version, and the next save goes under that version', async () => {
    const user = userEvent.setup();
    const state = world({ periods: [MONTH], details: { [REPORT]: monthly() } });
    const h = client(state, (operation) => {
      // The server moves the version of the draft on every save.
      if (operation === 'post_reports_id_revisions') state.details[REPORT] = monthly({ version: 4, narrative: { results: null, causes: 'Chờ phê duyệt', solutions: null, proposals: null, linked_issue_ids: [] } });
      return { status: 'DRAFT', resource_version: 4 };
    });
    mount(<MonthlyNarrativeScreen route={ROUTE} />, h, { permissions: MAKER, path: `${PATH}?report=${REPORT}` });
    await user.type(await screen.findByLabelText(vi_['dis.monthly.field.causes']), 'Chờ phê duyệt');
    await user.click(screen.getByRole('button', { name: vi_['dis.monthly.save.action'] }));
    expect(await screen.findByTestId('narrative-saved')).toBeTruthy();
    await waitFor(() => expect(h.read.mock.calls.filter((call) => call[0] === 'getReportRevision').length).toBeGreaterThan(1));
    expect(screen.getByTestId('narrative-saved')).toBeTruthy();
    expect((screen.getByLabelText(vi_['dis.monthly.field.causes']) as HTMLTextAreaElement).value).toBe('Chờ phê duyệt');
    await user.type(screen.getByLabelText(vi_['dis.monthly.field.results']), 'Đạt 60%');
    await user.click(screen.getByRole('button', { name: vi_['dis.monthly.save.action'] }));
    await waitFor(() => expect(h.command.mock.calls.filter((call) => call[0] === 'post_reports_id_revisions')).toHaveLength(2));
    expect(h.command.mock.calls.filter((call) => call[0] === 'post_reports_id_revisions')[1]?.[1]).toMatchObject({ ifMatchVersion: 4 });
  });

  it('shows the narrative that was kept, refuses a section above 4000 characters before it asks, and shows the refusal of the server', async () => {
    const user = userEvent.setup();
    edit(monthly({ narrative: { results: 'Đã có', causes: 'Nguyên nhân cũ', solutions: null, proposals: null, linked_issue_ids: [] } }), MAKER, () => new ApiError({ status: 422, code: 'VALIDATION_FAILED', correlationId: 'c' }));
    expect((await screen.findByLabelText(vi_['dis.monthly.field.causes'])) as HTMLTextAreaElement).toHaveProperty('value', 'Nguyên nhân cũ');
    const solutions = screen.getByLabelText(vi_['dis.monthly.field.solutions']) as HTMLTextAreaElement;
    solutions.focus();
    await user.click(solutions);
    await user.paste('x'.repeat(4001));
    await user.click(screen.getByRole('button', { name: vi_['dis.monthly.save.action'] }));
    expect(await screen.findByText(vi_['dis.monthly.tooLong.error'])).toBeTruthy();
    await user.clear(solutions);
    await user.click(screen.getByRole('button', { name: vi_['dis.monthly.save.action'] }));
    expect(await screen.findByTestId('narrative-refusal')).toBeTruthy();
  });

  it('is read only for a report that is not a draft, for a person who may not edit, and for a weekly report, which it says is not monthly', async () => {
    edit(monthly({ status: 'SUBMITTED' }));
    await screen.findByLabelText(vi_['dis.monthly.field.causes']);
    expect(screen.queryByRole('button', { name: vi_['dis.monthly.save.action'] })).toBeNull();
    expect((screen.getByLabelText(vi_['dis.monthly.field.causes']) as HTMLTextAreaElement).disabled).toBe(true);
    cleanup();
    edit(monthly(), READER);
    await screen.findByLabelText(vi_['dis.monthly.field.causes']);
    expect(screen.queryByRole('button', { name: vi_['dis.monthly.save.action'] })).toBeNull();
    cleanup();
    edit(reportRecord());
    expect(await screen.findByTestId('not-monthly')).toBeTruthy();
    expect(screen.queryByRole('button', { name: vi_['dis.monthly.save.action'] })).toBeNull();
  });

  it('is in the states of a screen when the report cannot be read', async () => {
    const state = world({ periods: [MONTH] });
    mount(<MonthlyNarrativeScreen route={ROUTE} />, client(state), { permissions: MAKER, path: `${PATH}?report=${REPORT}` });
    expect(await screen.findByText(vi_['states.error.title'])).toBeTruthy();
  });
});
