import { ApiError, NETWORK_ERROR_CODE } from '@machvon/api-client';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import { todayInVietnam } from '../model';
import { READER, UNIT, client, conclusionRecord, detailRecord, engagementRecord, mount, reportRecord, reportTotalsRecord, routeOf, world } from '../test-support';
import ReportScreen from './ReportScreen';

const ROUTE = routeOf('AUD-10', 'FR-AUD-10');
const ID = detailRecord(1).id as string;
const CONCLUSION = conclusionRecord().id as string;
const PATH = `/aud/aud-10?engagement=${ID}`;
const REPORTER = ['aud.report.issue', 'aud.read'];
const CLOSER = ['aud.engagement.close', 'aud.read'];
const BOTH = ['aud.report.issue', 'aud.engagement.close', 'aud.read'];
const TODAY = todayInVietnam();
const UNIT_SCOPE = [{ kind: 'UNIT', id: UNIT, code: 'SXD', name: 'Sở Xây dựng' }];

afterEach(cleanup);

interface Setup {
  status?: string;
  scope?: Array<Record<string, unknown>>;
  reports?: Array<Record<string, unknown>>;
  closedOn?: string | null;
}

const stateOf = ({ status = 'FOLLOW_UP', scope = UNIT_SCOPE, reports = [reportRecord(1)], closedOn = null }: Setup) =>
  world({
    engagements: [engagementRecord(1, { status })],
    details: { [ID]: detailRecord(1, { status, version: 5, started_on: '2026-10-01', closed_on: closedOn, scope }) },
    conclusions: { [ID]: [conclusionRecord()] },
    reports: { [ID]: reports },
  });

const open = (setup: Setup = {}, permissions: readonly string[] | undefined = BOTH, command: (operation: string, input: unknown) => unknown = () => ({ status: 'OK' }), mode?: 'FULL' | 'READ_ONLY') => {
  const h = client(stateOf(setup), command);
  mount(<ReportScreen route={ROUTE} />, h, { permissions, path: PATH, ...(mode === undefined ? {} : { mode }) });
  return h;
};

const text = (id: string): string => screen.getByTestId(id).textContent ?? '';
const heading = (): HTMLElement => within(document.querySelector('.heading') as HTMLElement).getByRole('heading', { level: 1 });

describe('AUD-10 report of the results and closure', () => {
  it('shows the engagement and each report with the figures frozen with it, the hash, where DOC has got to and who asked', async () => {
    open({ reports: [reportRecord(1)] });
    expect(await screen.findByRole('heading', { level: 1, name: vi_['aud.report.page.title'] })).toBeTruthy();
    const row = await screen.findByTestId('report-figures');
    expect(text('report-engagement')).toContain('TTCP-2026-001');
    expect(text('figures-counts')).toBe(vi_['aud.report.figures.counts'].replace('{closed}', '2').replace('{inProgress}', '1').replace('{open}', '0').replace('{disputed}', '0').replace('{total}', '3'));
    expect(text('figures-money')).toBe(vi_['aud.report.figures.money'].replace('{amount}', '1.200.000.000').replace('{recovered}', '1.100.000.000').replace('{remaining}', '100.000.000'));
    expect(text('report-rate-money')).toBe(`91,67% ${vi_['aud.recovery.rate.parts'].replace('{numerator}', '1.100.000.000').replace('{denominator}', '1.200.000.000')}`);
    expect(text('report-rate-count')).toBe(`66,67% ${vi_['aud.recovery.rate.parts'].replace('{numerator}', '2').replace('{denominator}', '3')}`);
    const reportRow = row.closest('tr') as HTMLElement;
    const cells = within(reportRow).getAllByRole('cell');
    expect(cells[0]?.textContent).toBe(`2027-01-04${vi_['aud.report.revision'].replace('{revision}', '1')}`);
    expect(cells[1]?.textContent).toBe('88/BC-KTNN');
    const full = reportRecord(1).payload_sha256 as string;
    expect(within(reportRow).getByText(full.slice(0, 12)).getAttribute('title')).toBe(full);
    expect(cells[4]?.textContent).toBe(vi_['aud.reportStatus.issueRequested']);
    expect(cells[5]?.textContent).toBe('—');
    expect(cells[6]?.textContent).toContain(vi_['aud.report.people.requested'].replace('{name}', 'Nguyễn Văn An'));
    expect(text('approver')).toBe(vi_['aud.report.people.pending']);
  });

  it('shows a report DOC issued with its document, its day and the approver, and one issued with no approver recorded as such', async () => {
    open({
      reports: [
        reportRecord(1, { status: 'ISSUED', report_document_id: '00000000-0000-4000-8000-0000000000d1', issued_at: '2027-01-05T03:00:00Z', approved_by: { id: UNIT, display_name: 'Trần Thị Bình' } }),
        reportRecord(2, { as_of_date: '2027-01-03', status: 'ISSUED', report_document_id: '00000000-0000-4000-8000-0000000000d2', issued_at: '2027-01-04T03:00:00Z' }),
      ],
    });
    await screen.findAllByTestId('report-figures');
    const rows = Array.from(document.querySelectorAll('tr[data-report-id]')).map((row) => within(row as HTMLElement).getAllByRole('cell'));
    expect(rows[0]?.[4]?.textContent).toBe(`${vi_['aud.reportStatus.issued']}2027-01-05`);
    expect(rows[0]?.[5]?.textContent).toBe('00000000-000');
    expect(rows[0]?.[6]?.textContent).toContain(vi_['aud.report.people.approved'].replace('{name}', 'Trần Thị Bình'));
    expect(rows[1]?.[6]?.textContent).toContain(vi_['aud.report.people.unrecorded']);
  });

  it('tells why DOC did not issue a report, in words, with the code of DOC at hand, and another reason as another reason', async () => {
    open({ reports: [reportRecord(1, { status: 'REJECTED', reject_code: 'PAYLOAD_SCHEMA_INVALID' }), reportRecord(2, { as_of_date: '2027-01-03', status: 'REJECTED', reject_code: 'SOURCE_WITHDRAWN' })] });
    await screen.findAllByTestId('report-figures');
    const reasons = screen.getAllByTestId('reject-reason');
    expect(reasons.map((reason) => reason.textContent)).toEqual([vi_['aud.reportReject.schemaInvalid'], vi_['aud.reportReject.other']]);
    expect(reasons.map((reason) => reason.getAttribute('title'))).toEqual(['PAYLOAD_SCHEMA_INVALID', 'SOURCE_WITHDRAWN']);
    expect(screen.getAllByText(vi_['aud.reportStatus.rejected'])[0]?.className).toContain('warning');
  });

  it('says a rate is not applicable, never 0 percent, when the report has nothing to divide by', async () => {
    open({ reports: [reportRecord(1, { totals: reportTotalsRecord({ total: 0, closed: 0, in_progress: 0, amount: '0', recovered: '0', remaining: '0', money_rate: { numerator: '0', denominator: '0', percent: null }, count_rate: { numerator: '0', denominator: '0', percent: null } }) })] });
    await screen.findByTestId('report-figures');
    expect(text('report-rate-money')).toContain(vi_['aud.recovery.rate.na']);
    expect(text('report-rate-count')).not.toContain('0%');
  });

  it('says there is no report yet, in words', async () => {
    open({ reports: [] });
    expect((await screen.findByTestId('no-reports')).textContent).toBe(vi_['aud.report.list.none']);
  });

  it('links the engagement to its file and its ledger, and states the rule of the closure while it is followed up', async () => {
    open();
    await screen.findByTestId('report-engagement');
    expect(screen.getByRole('link', { name: vi_['aud.report.engagement.file.link'] }).getAttribute('href')).toBe(`/aud/aud-03?engagement=${ID}`);
    expect(screen.getByRole('link', { name: vi_['aud.report.engagement.ledger.link'] }).getAttribute('href')).toBe(`/aud/aud-08?engagement=${ID}`);
    expect(text('closure-rule')).toBe(vi_['aud.closure.rule.note']);
    expect(text('report-rule')).toBe(vi_['aud.report.rule.note']);
    // The day the conclusion says the report is due by is on the card of the engagement.
    expect(text('report-due')).toBe('2027-01-15');
  });

  describe('the buttons', () => {
    const buttons = (): string[] => Array.from(document.querySelectorAll('.heading .actions button')).map((button) => button.textContent ?? '');

    it('are for the person they fit: the request for the one who may issue, the closure for the one who may close', async () => {
      open({}, REPORTER);
      await screen.findByTestId('report-engagement');
      expect(buttons()).toEqual([vi_['aud.report.request.action']]);
      cleanup();
      open({}, CLOSER);
      await screen.findByTestId('report-engagement');
      expect(buttons()).toEqual([vi_['aud.closure.action']]);
      cleanup();
      open({}, BOTH);
      await screen.findByTestId('report-engagement');
      expect(buttons()).toEqual([vi_['aud.report.request.action'], vi_['aud.closure.action']]);
    });

    it('are not shown to a reader, nor in a tenant that is read only, nor for an engagement that is closed', async () => {
      open({}, READER);
      await screen.findByTestId('report-engagement');
      expect(buttons()).toEqual([]);
      cleanup();
      open({}, BOTH, undefined, 'READ_ONLY');
      await screen.findByTestId('report-engagement');
      expect(buttons()).toEqual([]);
      cleanup();
      open({ status: 'CLOSED', closedOn: '2027-01-06' });
      await screen.findByTestId('report-engagement');
      expect(buttons()).toEqual([]);
      expect(text('closed-on')).toBe('2027-01-06');
      expect(screen.queryByTestId('closure-rule')).toBeNull();
    });
  });

  describe('asking for a report (AC-ST-AUD-005-1)', () => {
    const dialog = async (setup: Setup = {}, command: (operation: string, input: unknown) => unknown = () => ({ status: 'OK' })) => {
      const h = open(setup, REPORTER, command);
      const user = userEvent.setup();
      await screen.findByTestId('report-engagement');
      await user.click(within(document.querySelector('.heading .actions') as HTMLElement).getByRole('button', { name: vi_['aud.report.request.action'] }));
      return { h, user, box: screen.getByRole('dialog') };
    };
    const place = (box: HTMLElement) => within(box).getByLabelText(vi_['aud.report.request.place.label']) as HTMLInputElement;

    it('starts with the current conclusion, today, and the only unit the engagement is about, and asks for the place before it sends anything', async () => {
      const { h, user, box } = await dialog();
      expect(within(box).getByTestId('request-note').textContent).toBe(vi_['aud.report.request.note']);
      expect((within(box).getByLabelText(vi_['aud.report.request.conclusion.label']) as HTMLSelectElement).value).toBe(CONCLUSION);
      expect((within(box).getByLabelText(vi_['aud.report.request.asOf.label']) as HTMLInputElement).value).toBe(TODAY);
      expect((within(box).getByLabelText(vi_['aud.report.request.unit.label']) as HTMLSelectElement).value).toBe(UNIT);
      await user.click(within(box).getByRole('button', { name: vi_['aud.dialog.submit.action'] }));
      expect(within(box).getAllByText(vi_['aud.formProblem.required']).length).toBe(1);
      expect(h.command).not.toHaveBeenCalled();
    });

    it('sends the conclusion, the day, the place and the unit under the version of the engagement, and closes', async () => {
      const { h, user, box } = await dialog();
      await user.type(place(box), 'Cao Bằng');
      await user.click(within(box).getByRole('button', { name: vi_['aud.dialog.submit.action'] }));
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
      expect(h.command.mock.calls[0]?.[0]).toBe('requestAuditFollowUpReport');
      expect(h.command.mock.calls[0]?.[1]).toMatchObject({ path: { id: ID }, ifMatchVersion: 5, body: { conclusion_id: CONCLUSION, as_of_date: TODAY, place: 'Cao Bằng', drafting_unit_id: UNIT } });
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    });

    it('refuses a day before the conclusion was received and a day to come before it sends anything', async () => {
      const { h, user, box } = await dialog();
      await user.type(place(box), 'Cao Bằng');
      const day = within(box).getByLabelText(vi_['aud.report.request.asOf.label']) as HTMLInputElement;
      await user.clear(day);
      await user.type(day, '2026-10-14');
      await user.click(within(box).getByRole('button', { name: vi_['aud.dialog.submit.action'] }));
      expect(within(box).getByText(vi_['aud.formProblem.early'])).toBeTruthy();
      expect(h.command).not.toHaveBeenCalled();
    });

    it('offers every unit of the tenant when the engagement is about none, and the unit must be chosen', async () => {
      const { h, user, box } = await dialog({ scope: [{ kind: 'PROJECT', id: '00000000-0000-4000-8000-000000000001', code: 'DA-2026-001', name: 'Cầu qua sông' }] });
      const unit = within(box).getByLabelText(vi_['aud.report.request.unit.label']) as HTMLSelectElement;
      await waitFor(() => expect(within(unit).getAllByRole('option').length).toBe(2));
      expect(unit.value).toBe('');
      await user.type(place(box), 'Cao Bằng');
      await user.click(within(box).getByRole('button', { name: vi_['aud.dialog.submit.action'] }));
      expect(within(box).getByText(vi_['aud.formProblem.required'])).toBeTruthy();
      expect(h.command).not.toHaveBeenCalled();
      await user.selectOptions(unit, UNIT);
      await user.click(within(box).getByRole('button', { name: vi_['aud.dialog.submit.action'] }));
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    });

    const REFUSALS: Array<[string, string]> = [
      ['FOLLOW_UP_REPORT_EXISTS', vi_['aud.reportProblem.exists']],
      ['ENGAGEMENT_STATE_INVALID', vi_['aud.reportProblem.engagementState']],
      ['CONCLUSION_REVISION_INVALID', vi_['aud.reportProblem.conclusionReplaced']],
      ['DOC_TEMPLATE_MISSING', vi_['aud.reportProblem.templateMissing']],
      ['PROVIDER_UNAVAILABLE', vi_['aud.reportProblem.providerUnavailable']],
      ['VERSION_CONFLICT', vi_['aud.reportProblem.versionConflict']],
      ['SCOPE_DENIED', vi_['aud.reportProblem.scopeDenied']],
      ['VALIDATION_FAILED', vi_['aud.reportProblem.validation']],
      ['RESOURCE_NOT_FOUND', vi_['aud.reportProblem.notFound']],
      ['SOMETHING_ELSE', vi_['aud.reportProblem.general']],
    ];

    it.each(REFUSALS)('tells the refusal %s in words and keeps the dialog and what was typed', async (code, message) => {
      const { user, box } = await dialog({}, () => new ApiError({ status: 409, code, correlationId: 'c' }));
      await user.type(place(box), 'Cao Bằng');
      await user.click(within(box).getByRole('button', { name: vi_['aud.dialog.submit.action'] }));
      expect((await within(box).findByTestId('refusal')).textContent).toBe(message);
      expect(place(box).value).toBe('Cao Bằng');
    });
  });

  describe('closing the engagement (AC-ST-AUD-005-1)', () => {
    const dialog = async (command: (operation: string, input: unknown) => unknown = () => ({ status: 'OK' })) => {
      const h = open({}, CLOSER, command);
      const user = userEvent.setup();
      await screen.findByTestId('report-engagement');
      await user.click(within(document.querySelector('.heading .actions') as HTMLElement).getByRole('button', { name: vi_['aud.closure.action'] }));
      return { h, user, box: screen.getByRole('dialog') };
    };

    it('says what closing does, asks for a day from the start to today and sends it under the version of the engagement', async () => {
      const { h, user, box } = await dialog();
      expect(within(box).getByTestId('closure-note').textContent).toBe(vi_['aud.closure.note']);
      const day = within(box).getByLabelText(vi_['aud.closure.day.label']) as HTMLInputElement;
      expect(day.value).toBe(TODAY);
      await user.clear(day);
      await user.type(day, '2026-09-30');
      await user.click(within(box).getByRole('button', { name: vi_['aud.dialog.submit.action'] }));
      expect(within(box).getByText(vi_['aud.formProblem.early'])).toBeTruthy();
      expect(h.command).not.toHaveBeenCalled();
      await user.clear(day);
      await user.type(day, TODAY);
      await user.click(within(box).getByRole('button', { name: vi_['aud.dialog.submit.action'] }));
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
      expect(h.command.mock.calls[0]?.[0]).toBe('closeAuditEngagement');
      expect(h.command.mock.calls[0]?.[1]).toMatchObject({ path: { id: ID }, ifMatchVersion: 5, body: { on_date: TODAY } });
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    });

    it('tells how many recommendations are still open when the server refuses (OPEN_RECOMMENDATIONS_REMAIN), and the report that is missing', async () => {
      const open1 = await dialog(() => new ApiError({ status: 409, code: 'OPEN_RECOMMENDATIONS_REMAIN', correlationId: 'c', extensions: { open_recommendations: 2 } }));
      await open1.user.click(within(open1.box).getByRole('button', { name: vi_['aud.dialog.submit.action'] }));
      expect((await within(open1.box).findByTestId('refusal')).textContent).toBe(vi_['aud.reportProblem.openRecommendations'].replace('{count}', '2'));
      cleanup();
      const open2 = await dialog(() => new ApiError({ status: 422, code: 'FOLLOW_UP_REPORT_MISSING', correlationId: 'c' }));
      await open2.user.click(within(open2.box).getByRole('button', { name: vi_['aud.dialog.submit.action'] }));
      expect((await within(open2.box).findByTestId('refusal')).textContent).toBe(vi_['aud.reportProblem.reportMissing']);
    });
  });

  describe('choosing the engagement and the seven states', () => {
    it('with none chosen asks for one', async () => {
      mount(<ReportScreen route={ROUTE} />, client(stateOf({})), { permissions: READER, path: '/aud/aud-10' });
      expect((await screen.findByTestId('report-choose')).textContent).toBe(vi_['aud.report.choose.text']);
      expect(heading().textContent).toBe(vi_['aud.report.page.title']);
      await waitFor(() => expect(screen.getAllByRole('option').length).toBe(2));
    });

    it('says the engagement is not there for one that is not found (the same words as an engagement of another scope)', async () => {
      mount(<ReportScreen route={ROUTE} />, client(world()), { permissions: READER, path: PATH });
      expect(await screen.findByText(vi_['states.empty.title'])).toBeTruthy();
    });

    it('shows a loading state first, then the denied, signed-out, offline and error states', async () => {
      const failing = (operation: string, error: Error) => {
        const state = stateOf({});
        state.failing.set(operation, error);
        return client(state);
      };
      mount(<ReportScreen route={ROUTE} />, failing('getAuditEngagement', new ApiError({ status: 403, code: 'SCOPE_DENIED', correlationId: 'c' })), { permissions: READER, path: PATH });
      expect(screen.getByRole('status', { name: vi_['states.loading.label'] })).toBeTruthy();
      expect(await screen.findByText(vi_['states.denied.title'])).toBeTruthy();
      cleanup();
      mount(<ReportScreen route={ROUTE} />, failing('listAuditFollowUpReports', new ApiError({ status: 401, code: 'SESSION_EXPIRED', correlationId: 'c' })), { permissions: READER, path: PATH });
      expect(await screen.findByText(vi_['states.signedOut.title'])).toBeTruthy();
      cleanup();
      mount(<ReportScreen route={ROUTE} />, failing('listAuditFollowUpReports', new ApiError({ status: 0, code: NETWORK_ERROR_CODE, correlationId: 'c' })), { permissions: READER, path: PATH });
      expect(await screen.findByText(vi_['states.offline.title'])).toBeTruthy();
      cleanup();
      mount(<ReportScreen route={ROUTE} />, failing('getAuditEngagement', new ApiError({ status: 500, code: 'INTERNAL_ERROR', correlationId: 'c' })), { permissions: READER, path: PATH });
      expect(await screen.findByText(vi_['states.error.title'])).toBeTruthy();
    });
  });
});
