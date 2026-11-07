import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../i18n/vi.json';
import { mountInSession } from '../adm/security/test-support';
import PeriodReopenScreen from './PeriodReopenScreen';
import { APPROVER, BOTH, MAKER, ME, PROJECT_ONE, PROJECT_TWO, REQUESTER, SOMEONE_ELSE, client, mount, period, project, reopen, routeOf, world } from './test-support';

const ROUTE = routeOf('DIS-22', 'FR-DIS-22');
const PATH = '/dis/dis-22';
const HOUR = 3_600_000;

afterEach(cleanup);

const text = (key: keyof typeof vi_, params: Record<string, string | number> = {}): string => Object.entries(params).reduce((message, [name, value]) => message.replace(`{${name}}`, String(value)), vi_[key]);
const requestRows = (): HTMLElement[] => Array.from(document.querySelectorAll<HTMLElement>('[data-reopen-id]'));
const ready = () => waitFor(() => expect(requestRows().length).toBeGreaterThan(0));
const markerOf = (n: number): HTMLElement => document.querySelector(`[data-reopen-id="00000000-0000-4000-8000-0004${String(n).padStart(8, '0')}"]`) as HTMLElement;
const rowOf = (n: number): HTMLElement => markerOf(n).closest('tr') as HTMLElement;
const decisionButton = (n: number, decision: 'approve' | 'reject'): HTMLButtonElement => rowOf(n).querySelector(`button[data-decision="${decision}"]`) as HTMLButtonElement;
/** The time as the screen shows it: Vietnam time, UTC+7, to the minute. */
const vietnam = (instant: number): string => new Date(instant + 7 * HOUR).toISOString().slice(0, 16).replace('T', ' ');

const LOCKED = period(3, { status: 'LOCKED', soft_closed_at: '2026-10-02T03:05:00.000Z', locked_at: '2026-10-02T03:10:00.000Z', locked_by: SOMEONE_ELSE, version: 3 });
const OPEN = period(1, { status: 'OPEN' });
const PROJECTS = [project(PROJECT_ONE, 'P-A-001', 'Road to the district'), project(PROJECT_TWO, 'P-A-002', 'School of the commune')];

describe('PeriodReopenScreen (DIS-22): the reasoned reopening of a locked period (UI-DIS-22)', () => {
  it('lists the requests that wait first, with the scope, the reason, who asked, the hours and the status in words (UI-DIS-22)', async () => {
    const open = Date.now() + 3 * HOUR;
    const lapsed = Date.now() - 2 * HOUR;
    const windowOpen = new Date(open).toISOString();
    const state = world({
      periods: [
        {
          ...LOCKED,
          reopens: [
            reopen(1, { status: 'APPROVED', window_until: windowOpen, approved_by: SOMEONE_ELSE, decided_by: SOMEONE_ELSE, decided_at: '2026-10-01T02:00:00.000Z', decision_reason: 'The vouchers are documented' }),
            reopen(2, { scope_kind: 'PERIOD', projects: [], requested_by: ME }),
            reopen(3, { status: 'REJECTED', decided_by: SOMEONE_ELSE, decided_at: '2026-10-03T02:00:00.000Z', decision_reason: 'Not documented' }),
            reopen(4, { status: 'APPROVED', window_until: new Date(lapsed).toISOString(), approved_by: SOMEONE_ELSE, decided_by: SOMEONE_ELSE, decided_at: '2026-10-01T02:00:00.000Z', decision_reason: 'Granted' }),
          ],
        },
        OPEN,
      ],
    });
    mount(<PeriodReopenScreen route={ROUTE} />, client(state), BOTH, PATH);
    await ready();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['dis.reopen.page.title']);
    // The request that waits is first; the decided ones follow, the newest first.
    expect(requestRows().map((row) => row.getAttribute('data-reopen-id')?.slice(-1))).toEqual(['2', '4', '3', '1']);
    expect(rowOf(2).textContent).toContain(vi_['dis.reopen.queue.requester.mine']);
    expect(rowOf(1).textContent).toContain(vi_['dis.reopen.queue.requester.other']);
    expect(rowOf(1).textContent).toContain('The Treasury returned the vouchers for a wrong source code');
    expect(rowOf(1).textContent).toContain(text('dis.reopen.queue.window.asked', { hours: 72 }));
    expect(rowOf(1).textContent).toContain(text('dis.reopen.queue.window.until', { when: vietnam(open) }));
    expect(rowOf(2).textContent).toContain(vi_['dis.reopen.queue.allProjects.text']);
    expect(rowOf(1).textContent).toContain('P-A-001');
    const statusOf = (n: number): string => (rowOf(n).querySelectorAll('td')[5]?.querySelector('.ui-pill') as HTMLElement).textContent ?? '';
    expect([1, 2, 3, 4].map(statusOf)).toEqual([
      vi_['dis.calendar.reopenStatus.approved.text'],
      vi_['dis.calendar.reopenStatus.requested.text'],
      vi_['dis.calendar.reopenStatus.rejected.text'],
      vi_['dis.calendar.reopenStatus.expired.text'],
    ]);
    // An approved window that has ended is Expired on the screen although the server still says Approved.
    expect(markerOf(4).getAttribute('data-status')).toBe('EXPIRED');
  });

  it('marks the projects of an open window with "reopened until hh:mm", and no project of a window that has ended or was never granted (TK-DIS-002-3)', async () => {
    const until = Date.now() + 5 * HOUR;
    const state = world({
      periods: [
        {
          ...LOCKED,
          reopens: [
            reopen(1, { status: 'APPROVED', window_until: new Date(until).toISOString(), projects: [{ id: PROJECT_ONE, code: 'P-A-001' }, { id: PROJECT_TWO, code: 'P-A-002' }], approved_by: SOMEONE_ELSE, decided_by: SOMEONE_ELSE, decided_at: '2026-10-01T02:00:00.000Z', decision_reason: 'Granted' }),
            reopen(2, { status: 'APPROVED', scope_kind: 'PERIOD', projects: [], window_until: new Date(until).toISOString(), approved_by: SOMEONE_ELSE, decided_by: SOMEONE_ELSE, decided_at: '2026-10-01T02:00:00.000Z', decision_reason: 'Granted' }),
            reopen(3),
            reopen(4, { status: 'APPROVED', window_until: new Date(Date.now() - HOUR).toISOString(), approved_by: SOMEONE_ELSE, decided_by: SOMEONE_ELSE, decided_at: '2026-10-01T02:00:00.000Z', decision_reason: 'Granted' }),
          ],
        },
      ],
    });
    mount(<PeriodReopenScreen route={ROUTE} />, client(state), APPROVER, PATH);
    await ready();
    const chips = (n: number): string[] => Array.from(rowOf(n).querySelectorAll('[data-testid="window-chip"]')).map((chip) => chip.textContent ?? '');
    const chip = text('dis.reopen.window.active.chip', { when: vietnam(until) });
    expect(chips(1)).toEqual([chip, chip]);
    expect(rowOf(1).querySelector('li[data-project-id]')?.textContent).toContain('P-A-001');
    expect(chips(2)).toEqual([chip]);
    expect(chips(3)).toEqual([]);
    expect(chips(4)).toEqual([]);
  });

  it('shows only the scope and the window to a reader who is neither the requester nor an approver, and offers nothing (AC-ST-DIS-002-2)', async () => {
    const state = world({
      periods: [{ ...LOCKED, reopens: [{ id: 'r1', scope_kind: 'PROJECTS', status: 'APPROVED', window_until: new Date(Date.now() + HOUR).toISOString(), requested_at: '2026-10-03T01:00:00.000Z' }] }],
    });
    mount(<PeriodReopenScreen route={ROUTE} />, client(state), MAKER, PATH);
    await waitFor(() => expect(document.querySelector('[data-reopen-id="r1"]')).not.toBeNull());
    const row = document.querySelector('[data-reopen-id="r1"]')?.closest('tr') as HTMLElement;
    expect(row.textContent).toContain(vi_['dis.calendar.reopenScope.projects.text']);
    expect(row.textContent).not.toContain('Treasury');
    expect(row.querySelectorAll('button')).toHaveLength(0);
    expect(row.querySelectorAll('[data-testid="window-chip"]')).toHaveLength(0);
    expect(screen.getByTestId('read-only').textContent).toBe(vi_['dis.reopen.readOnly.denied.notice']);
    expect(screen.queryByTestId('reopen-form')).toBeNull();
  });

  describe('the decision (AC-ST-DIS-002-2)', () => {
    const waiting = (): ReturnType<typeof world> => world({ periods: [{ ...LOCKED, reopens: [reopen(1, { requested_by: ME }), reopen(2, { requested_by: SOMEONE_ELSE })] }] });

    it('disables the decision on a request the approver made, with the separation rule as its tooltip, and offers it on the request of somebody else (AC-ST-DIS-002-2)', async () => {
      const h = client(waiting());
      mount(<PeriodReopenScreen route={ROUTE} />, h, BOTH, PATH);
      await ready();
      for (const decision of ['approve', 'reject'] as const) {
        const own = decisionButton(1, decision);
        expect(own.disabled).toBe(true);
        expect(own.getAttribute('title')).toBe(vi_['dis.reopen.decision.own.tooltip']);
        expect(document.getElementById(own.getAttribute('aria-describedby') as string)?.textContent).toBe(vi_['dis.reopen.decision.own.tooltip']);
        expect(decisionButton(2, decision).disabled).toBe(false);
        expect(decisionButton(2, decision).getAttribute('title')).toBeNull();
      }
      const user = userEvent.setup();
      await user.click(decisionButton(1, 'approve'));
      expect(screen.queryByTestId('decision-row')).toBeNull();
      expect(h.command).not.toHaveBeenCalled();
    });

    it('approves for the hours the requester asked for by default, against the version that was read, and shows the new status', async () => {
      const state = waiting();
      const h = client(state, (operation, input) => {
        if (operation === 'decidePeriodReopen') {
          const target = (state.periods[0]?.reopens as Array<Record<string, unknown>>).find((item) => item.id === (input as { path: { id: string } }).path.id) as Record<string, unknown>;
          Object.assign(target, { status: 'APPROVED', window_until: new Date(Date.now() + 72 * HOUR).toISOString(), approved_by: ME, decided_by: ME, version: 2 });
        }
        return {};
      });
      mount(<PeriodReopenScreen route={ROUTE} />, h, BOTH, PATH);
      await ready();
      const user = userEvent.setup();
      await user.click(decisionButton(2, 'approve'));
      const form = await screen.findByRole('form', { name: text('dis.reopen.decision.approve.title', { code: LOCKED.code }) });
      expect((within(form).getByLabelText(vi_['dis.reopen.decision.hours.label']) as HTMLInputElement).value).toBe('72');
      // A reason of five characters is required before anything is sent.
      await user.click(within(form).getByRole('button', { name: vi_['dis.reopen.decision.approve.confirm'] }));
      expect((await within(form).findByRole('alert')).textContent).toBe(vi_['dis.reopen.field.required.error']);
      await user.type(within(form).getByLabelText(vi_['dis.reopen.decision.reason.label']), 'ok');
      await user.click(within(form).getByRole('button', { name: vi_['dis.reopen.decision.approve.confirm'] }));
      expect((await within(form).findByRole('alert')).textContent).toBe(vi_['dis.reopen.field.decisionShort.error']);
      expect(h.command).not.toHaveBeenCalled();
      const hours = within(form).getByLabelText(vi_['dis.reopen.decision.hours.label']);
      await user.clear(hours);
      await user.type(hours, '169');
      await user.type(within(form).getByLabelText(vi_['dis.reopen.decision.reason.label']), 'cuments are in order');
      await user.click(within(form).getByRole('button', { name: vi_['dis.reopen.decision.approve.confirm'] }));
      expect(within(form).getByText(vi_['dis.reopen.field.hours.error'])).toBeTruthy();
      await user.clear(hours);
      await user.type(hours, '48');
      await user.click(within(form).getByRole('button', { name: vi_['dis.reopen.decision.approve.confirm'] }));
      await waitFor(() => expect(screen.queryByTestId('decision-row')).toBeNull());
      expect(h.command).toHaveBeenCalledTimes(1);
      expect(h.command).toHaveBeenCalledWith('decidePeriodReopen', expect.objectContaining({ path: { id: markerOf(2).getAttribute('data-reopen-id') }, body: { decision: 'approve', reason: 'okcuments are in order', window_hours: 48 }, ifMatchVersion: 1 }));
      await waitFor(() => expect(markerOf(2).getAttribute('data-status')).toBe('APPROVED'));
      expect(decisionButton(2, 'approve')).toBeNull();
    });

    it('rejects with a reason and no hours', async () => {
      const h = client(waiting());
      mount(<PeriodReopenScreen route={ROUTE} />, h, APPROVER, PATH);
      await ready();
      const user = userEvent.setup();
      await user.click(decisionButton(2, 'reject'));
      const form = await screen.findByRole('form', { name: text('dis.reopen.decision.reject.title', { code: LOCKED.code }) });
      expect(within(form).queryByLabelText(vi_['dis.reopen.decision.hours.label'])).toBeNull();
      await user.type(within(form).getByLabelText(vi_['dis.reopen.decision.reason.label']), '  The vouchers are not documented  ');
      await user.click(within(form).getByRole('button', { name: vi_['dis.reopen.decision.reject.confirm'] }));
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
      expect(h.command).toHaveBeenCalledWith('decidePeriodReopen', expect.objectContaining({ body: { decision: 'reject', reason: 'The vouchers are not documented' }, ifMatchVersion: 1 }));
    });

    it('names the request before it asks for the reason: its period, its scope and its status, read only', async () => {
      mount(<PeriodReopenScreen route={ROUTE} />, client(waiting()), APPROVER, PATH);
      await ready();
      await userEvent.setup().click(decisionButton(2, 'approve'));
      const panel = await screen.findByTestId('decision-row');
      expect(within(panel).getByRole('group', { name: vi_['dis.reopen.queue.period.column'] }).textContent).toContain(LOCKED.code);
      expect(within(panel).getByRole('group', { name: vi_['dis.reopen.queue.status.column'] }).textContent).toContain(vi_['dis.calendar.reopenStatus.requested.text']);
    });

    it('can be cancelled without sending anything', async () => {
      const h = client(waiting());
      mount(<PeriodReopenScreen route={ROUTE} />, h, APPROVER, PATH);
      await ready();
      const user = userEvent.setup();
      await user.click(decisionButton(2, 'approve'));
      await user.click(await screen.findByRole('button', { name: vi_['dis.reopen.decision.cancel.action'] }));
      expect(screen.queryByTestId('decision-row')).toBeNull();
      expect(h.command).not.toHaveBeenCalled();
    });

    it.each([
      ['SELF_APPROVAL_DENIED', 403, 'dis.reopen.problem.selfApproval.error'],
      ['VERSION_CONFLICT', 409, 'dis.reopen.problem.versionConflict.error'],
      ['PERIOD_STATE_INVALID', 409, 'dis.reopen.problem.stateInvalid.error'],
      ['RESOURCE_NOT_FOUND', 404, 'dis.reopen.problem.notFound.error'],
      ['VALIDATION_FAILED', 422, 'dis.reopen.problem.validation.error'],
      ['SCOPE_DENIED', 403, 'dis.reopen.problem.denied.error'],
      ['SOMETHING_ELSE', 500, 'dis.reopen.problem.general.error'],
    ] as const)('shows the sentence for the refusal %s and keeps the form open', async (code, status, key) => {
      const h = client(waiting(), () => new ApiError({ status, code, correlationId: 'c', retryAfterSeconds: undefined, detail: undefined, extensions: {} }));
      mount(<PeriodReopenScreen route={ROUTE} />, h, APPROVER, PATH);
      await ready();
      const user = userEvent.setup();
      await user.click(decisionButton(2, 'approve'));
      const form = await screen.findByRole('form', { name: text('dis.reopen.decision.approve.title', { code: LOCKED.code }) });
      await user.type(within(form).getByLabelText(vi_['dis.reopen.decision.reason.label']), 'The documents are in order');
      await user.click(within(form).getByRole('button', { name: vi_['dis.reopen.decision.approve.confirm'] }));
      expect((await screen.findByTestId('decision-problem')).textContent).toBe(vi_[key]);
      expect(screen.getByTestId('decision-row')).toBeTruthy();
    });

    it('offers neither decision while the tenant is read-only', async () => {
      mountInSession(<PeriodReopenScreen route={ROUTE} />, client(waiting()), { permissions: BOTH, mode: 'READ_ONLY' });
      await ready();
      expect(document.querySelectorAll('button[data-decision]')).toHaveLength(0);
      expect(screen.getByTestId('read-only').textContent).toBe(vi_['dis.reopen.readOnly.frozen.notice']);
      expect(screen.queryByTestId('reopen-form')).toBeNull();
    });
  });

  describe('the request form', () => {
    const calendar = () => world({ periods: [OPEN, LOCKED, period(2, { status: 'SOFT_CLOSED' })], projects: PROJECTS });

    it('lists the locked periods only, and the projects within the scope of the requester', async () => {
      mount(<PeriodReopenScreen route={ROUTE} />, client(calendar()), REQUESTER, PATH);
      const form = await screen.findByTestId('reopen-form');
      const select = within(form).getByLabelText(vi_['dis.reopen.form.period.label']) as HTMLSelectElement;
      expect(Array.from(select.options).map((option) => option.textContent)).toEqual([vi_['dis.reopen.form.period.placeholder'], text('dis.reopen.form.period.option', { code: LOCKED.code, start: LOCKED.start_date, end: LOCKED.end_date })]);
      expect(await within(form).findByLabelText('P-A-001', { exact: false })).toBeTruthy();
      expect(within(form).getByLabelText('P-A-002', { exact: false })).toBeTruthy();
      // The search narrows the list by code or name, ignoring case.
      const user = userEvent.setup();
      await user.type(within(form).getByLabelText(vi_['dis.reopen.projects.filter.label']), 'SCHOOL');
      expect(within(form).queryByLabelText('P-A-001', { exact: false })).toBeNull();
      expect(within(form).getByLabelText('P-A-002', { exact: false })).toBeTruthy();
      await user.clear(within(form).getByLabelText(vi_['dis.reopen.projects.filter.label']));
      await user.type(within(form).getByLabelText(vi_['dis.reopen.projects.filter.label']), 'nothing like it');
      expect(within(form).getByText(vi_['dis.reopen.projects.empty.text'])).toBeTruthy();
    });

    it('asks for the period, the projects, a reason of 20 characters and the hours before anything is sent (UAT-AC246)', async () => {
      const h = client(calendar());
      mount(<PeriodReopenScreen route={ROUTE} />, h, REQUESTER, PATH);
      const form = await screen.findByTestId('reopen-form');
      const user = userEvent.setup();
      await within(form).findByLabelText('P-A-001', { exact: false });
      await user.click(within(form).getByRole('button', { name: vi_['dis.reopen.form.submit.action'] }));
      const alerts = (): string[] => within(form).getAllByRole('alert').map((alert) => alert.textContent ?? '');
      expect(alerts()).toEqual([vi_['dis.reopen.field.required.error'], vi_['dis.reopen.field.required.error'], vi_['dis.reopen.field.required.error']]);
      await user.selectOptions(within(form).getByLabelText(vi_['dis.reopen.form.period.label']), LOCKED.id);
      await user.click(within(form).getByLabelText('P-A-001', { exact: false }));
      await user.type(within(form).getByLabelText(vi_['dis.reopen.form.reason.label']), 'sai');
      await user.clear(within(form).getByLabelText(vi_['dis.reopen.form.hours.label']));
      await user.type(within(form).getByLabelText(vi_['dis.reopen.form.hours.label']), '0');
      await user.click(within(form).getByRole('button', { name: vi_['dis.reopen.form.submit.action'] }));
      expect(alerts()).toEqual([vi_['dis.reopen.field.hours.error'], vi_['dis.reopen.field.reasonShort.error']]);
      expect(h.command).not.toHaveBeenCalled();
    });

    it('sends the request for the projects chosen and clears the form (AC-ST-DIS-002-1)', async () => {
      const h = client(calendar());
      mount(<PeriodReopenScreen route={ROUTE} />, h, REQUESTER, PATH);
      const form = await screen.findByTestId('reopen-form');
      const user = userEvent.setup();
      await user.selectOptions(within(form).getByLabelText(vi_['dis.reopen.form.period.label']), LOCKED.id);
      await user.click(await within(form).findByLabelText('P-A-001', { exact: false }));
      await user.click(within(form).getByLabelText('P-A-002', { exact: false }));
      await user.click(within(form).getByLabelText('P-A-002', { exact: false }));
      await user.type(within(form).getByLabelText(vi_['dis.reopen.form.reason.label']), '  Kho bạc trả lại chứng từ do sai mã nguồn  ');
      await user.clear(within(form).getByLabelText(vi_['dis.reopen.form.hours.label']));
      await user.type(within(form).getByLabelText(vi_['dis.reopen.form.hours.label']), '48');
      await user.click(within(form).getByRole('button', { name: vi_['dis.reopen.form.submit.action'] }));
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
      expect(h.command).toHaveBeenCalledWith(
        'requestPeriodReopen',
        expect.objectContaining({ path: { id: LOCKED.id }, body: { scope_kind: 'PROJECTS', project_ids: [PROJECT_ONE], reason: 'Kho bạc trả lại chứng từ do sai mã nguồn', window_hours: 48 } }),
      );
      expect((await screen.findByTestId('reopen-done')).textContent).toBe(vi_['dis.reopen.form.done.notice']);
      expect((within(form).getByLabelText(vi_['dis.reopen.form.reason.label']) as HTMLTextAreaElement).value).toBe('');
      expect((within(form).getByLabelText(vi_['dis.reopen.form.period.label']) as HTMLSelectElement).value).toBe('');
    });

    it('asks for the whole period without naming projects', async () => {
      const h = client(calendar());
      mount(<PeriodReopenScreen route={ROUTE} />, h, REQUESTER, PATH);
      const form = await screen.findByTestId('reopen-form');
      const user = userEvent.setup();
      await user.click(within(form).getByLabelText(vi_['dis.calendar.reopenScope.period.text']));
      expect(within(form).queryByLabelText(vi_['dis.reopen.projects.filter.label'])).toBeNull();
      expect(within(form).getByText(vi_['dis.reopen.form.periodScope.help'])).toBeTruthy();
      await user.selectOptions(within(form).getByLabelText(vi_['dis.reopen.form.period.label']), LOCKED.id);
      await user.type(within(form).getByLabelText(vi_['dis.reopen.form.reason.label']), 'The whole week is wrong at the Treasury');
      await user.click(within(form).getByRole('button', { name: vi_['dis.reopen.form.submit.action'] }));
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
      expect(h.command).toHaveBeenCalledWith('requestPeriodReopen', expect.objectContaining({ body: { scope_kind: 'PERIOD', reason: 'The whole week is wrong at the Treasury', window_hours: 24 } }));
    });

    it.each([
      ['REOPEN_REASON_REQUIRED', 422, 'dis.reopen.problem.reasonRequired.error'],
      ['SCOPE_DENIED', 403, 'dis.reopen.problem.denied.error'],
      ['PERIOD_STATE_INVALID', 409, 'dis.reopen.problem.stateInvalid.error'],
    ] as const)('shows the sentence for the refusal %s and keeps what was typed', async (code, status, key) => {
      const h = client(calendar(), () => new ApiError({ status, code, correlationId: 'c', retryAfterSeconds: undefined, detail: undefined, extensions: {} }));
      mount(<PeriodReopenScreen route={ROUTE} />, h, REQUESTER, PATH);
      const form = await screen.findByTestId('reopen-form');
      const user = userEvent.setup();
      await user.selectOptions(within(form).getByLabelText(vi_['dis.reopen.form.period.label']), LOCKED.id);
      await user.click(await within(form).findByLabelText('P-A-001', { exact: false }));
      await user.type(within(form).getByLabelText(vi_['dis.reopen.form.reason.label']), 'The Treasury returned the vouchers');
      await user.click(within(form).getByRole('button', { name: vi_['dis.reopen.form.submit.action'] }));
      expect((await screen.findByTestId('reopen-problem')).textContent).toBe(vi_[key]);
      expect((within(form).getByLabelText(vi_['dis.reopen.form.reason.label']) as HTMLTextAreaElement).value).toBe('The Treasury returned the vouchers');
    });

    it('says so when the register cannot be read, and tries again on request', async () => {
      const state = calendar();
      state.failing.add('get_resources_project');
      mount(<PeriodReopenScreen route={ROUTE} />, client(state), REQUESTER, PATH);
      const form = await screen.findByTestId('reopen-form');
      expect((await within(form).findByRole('alert')).textContent).toContain(vi_['dis.reopen.projects.error.text']);
      state.failing.delete('get_resources_project');
      fireEvent.click(within(form).getByRole('button', { name: vi_['dis.reopen.projects.retry.action'] }));
      expect(await within(form).findByLabelText('P-A-001', { exact: false })).toBeTruthy();
    });
  });

  it('says there are no requests yet, and shows the form to a requester', async () => {
    mount(<PeriodReopenScreen route={ROUTE} />, client(world({ periods: [LOCKED] })), REQUESTER, PATH);
    expect((await screen.findByTestId('empty-requests')).textContent).toBe(vi_['dis.reopen.queue.empty.text']);
    expect(screen.getByTestId('reopen-form')).toBeTruthy();
  });

  it('shows the error state with a retry when the periods cannot be read', async () => {
    const state = world();
    state.failing.add('get_resources_reporting_period');
    mount(<PeriodReopenScreen route={ROUTE} />, client(state), BOTH, PATH);
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryByTestId('reopen-form')).toBeNull();
  });

  it('shows the reference of the screen', async () => {
    mount(<PeriodReopenScreen route={ROUTE} />, client(world({ periods: [LOCKED] })), BOTH, PATH);
    await screen.findByTestId('empty-requests');
    expect(document.querySelector('.prototype-note')?.textContent).toBe(text('dis.reopen.footer.reference', { id: 'DIS-22', req: 'FR-DIS-22' }));
    expect(document.querySelector('section')?.getAttribute('data-screen-id')).toBe('DIS-22');
  });
});
