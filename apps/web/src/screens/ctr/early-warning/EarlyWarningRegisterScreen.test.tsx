import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import EarlyWarningRegisterScreen from './EarlyWarningRegisterScreen';
import { CONTRACT, WARNER, WARNING, WARNING_READER, clock, client, commandsOf, mount, page, readsOf, register, routeOf, text, uuid } from './test/support';

afterEach(() => cleanup());

const route = routeOf('CTR-35');
const failure = (code: string, status = 409) => new ApiError({ status, code, correlationId: 'c', extensions: {} });

const open = (answers: Record<string, unknown> = {}, permissions: readonly string[] = WARNER, path = `/?contract=${CONTRACT}`, command?: (operation: string, input: unknown) => unknown) => {
  const h = client({ listContractEarlyWarnings: page(), getContractEarlyWarningRegister: register(), ...answers }, command);
  return { h, ...mount(<EarlyWarningRegisterScreen route={route} />, h, permissions, path) };
};

describe('the early-warning register (CTR-35)', () => {
  it('lists the warnings with the party that raised each, the expected impact, who answers for it and the open actions', async () => {
    open();
    const links = await screen.findAllByTestId('warning-link');
    expect(links.map((link) => link.textContent)).toEqual(['EW-001', 'EW-002']);
    expect(links[0]?.getAttribute('href')).toBe(`/ctr/ctr-36?warning=${WARNING}`);
    const rows = document.querySelectorAll('[data-warning]');
    expect(rows[0]?.textContent).toContain(text('ctrWarn.party.contractor.label'));
    expect(rows[0]?.textContent).toContain('250.000.000');
    expect(rows[0]?.textContent).toContain('Pham Van D');
    // A warning nobody assessed has no owner and no impact: the register says so and does not write zero.
    expect(rows[1]?.textContent).toContain(text('ctrWarn.cell.noOwner.text'));
    expect(rows[1]?.getAttribute('data-status')).toBe('RAISED');
  });

  it('puts an "i" on every figure of the summary and says that the register is not the disbursement warning', async () => {
    open();
    await screen.findAllByTestId('warning-link');
    for (const key of ['ctrWarn.summary.total.label', 'ctrWarn.summary.open.label', 'ctrWarn.summary.unassessed.label', 'ctrWarn.summary.withoutOwner.label', 'ctrWarn.summary.overdueActions.label', 'ctrWarn.summary.exposureCost.label', 'ctrWarn.summary.exposureDays.label', 'ctrWarn.summary.impactUnknown.label']) {
      expect(screen.getByRole('button', { name: text('ctrReg.info.open.label', { name: text(key) }) })).toBeTruthy();
    }
    expect(within(screen.getByTestId('tile-exposureCost')).getByText('250.000.000')).toBeTruthy();
    expect(screen.getByText(text('ctrWarn.context.separate.value'))).toBeTruthy();
  });

  it('shows the three clocks of the rhythm with a state and a day, the rule behind them and that its numbers are not confirmed', async () => {
    open({ getContractEarlyWarningRegister: register({ clocks: { initial: clock('INITIAL_ISSUE', { state: 'MISSED', due_on: '2026-11-08', days_left: -1 }), meeting: clock('MEETING'), reissue: clock('REISSUE', { state: 'APPROACHING', meeting_id: uuid(80), due_on: '2026-11-10', days_left: 2 }) } }) });
    const initial = await screen.findByTestId('clock-initial_issue');
    expect(initial.getAttribute('data-state')).toBe('MISSED');
    expect(within(initial).getByTestId('due').textContent).toContain('08/11/2026');
    expect(within(initial).getByText(text('ctrWarn.clock.daysPast.text', { days: 1 }))).toBeTruthy();
    expect(screen.getByTestId('clock-meeting').getAttribute('data-state')).toBe('RUNNING');
    expect(screen.getByTestId('clock-reissue').getAttribute('data-state')).toBe('APPROACHING');
    expect(within(initial).getByRole('button', { name: text('ctrReg.info.open.label', { name: text('ctrWarn.clock.initialIssue.label') }) })).toBeTruthy();
    expect(screen.getByTestId('policy-line').textContent).toBe(text('ctrWarn.rhythm.policy.text', { initial: 7, meeting: 14, reissue: 7 }));
    expect(screen.getByText(text('ctrWarn.rhythm.unverified.label'))).toBeTruthy();
  });

  it('gives no day to a clock that cannot run: the contract is not in force, or the working calendar is not published', async () => {
    open({
      getContractEarlyWarningRegister: register({
        calendar_published: false,
        clocks: { initial: clock('INITIAL_ISSUE', { state: 'NOT_STARTED', started_on: null, due_on: null, days_left: null }), meeting: clock('MEETING', { state: 'CALENDAR_UNAVAILABLE', due_on: null, days_left: null, basis: 'WORKING_DAYS' }), reissue: null },
      }),
    });
    expect(await screen.findByTestId('calendar-notice')).toBeTruthy();
    expect(within(screen.getByTestId('clock-initial_issue')).getByText(text('ctrWarn.clock.notStarted.text'))).toBeTruthy();
    expect(within(screen.getByTestId('clock-initial_issue')).getByTestId('due').textContent).toBe('–');
    expect(within(screen.getByTestId('clock-meeting')).getByText(text('ctrWarn.clock.calendar.text'))).toBeTruthy();
    expect(within(screen.getByTestId('clock-meeting')).getByTestId('due').textContent).toBe('–');
  });

  it('shows the meetings with what each concluded and whether the register was issued again, and the issues with their counts and hash', async () => {
    open({
      getContractEarlyWarningRegister: register({
        meetings: [{ id: uuid(80), ordinal: 1, held_on: '2026-11-05', attendees: 'Owner and contractor', notes: null, minutes_document_version_id: null, recorded_by_name: 'A', reissued_on: null, reviews: [{ warning_id: WARNING, warning_code: 'EW-001', outcome: 'ACTION_AGREED', note: null, status_at_meeting: 'ASSESSED' }] }],
        issues: [{ id: uuid(81), ordinal: 1, kind: 'INITIAL', issued_on: '2026-11-02', meeting_id: null, warning_count: 2, open_count: 2, content_hash: 'abcdef0123456789abcdef', issued_by_name: 'A' }],
      }),
    });
    const meetings = await screen.findByTestId('meetings');
    expect(meetings.textContent).toContain(text('ctrWarn.meetings.notReissued.text'));
    expect(meetings.textContent).toContain(`EW-001: ${text('ctrWarn.review.actionAgreed.label')}`);
    const issues = screen.getByTestId('issues');
    expect(issues.textContent).toContain(text('ctrWarn.issues.counts.text', { open: 2, total: 2 }));
    expect(issues.textContent).toContain('abcdef012345');
    cleanup();
    open();
    expect(await screen.findByTestId('no-meetings')).toBeTruthy();
    expect(screen.getByTestId('no-issues')).toBeTruthy();
  });

  it('asks for a contract before it shows a rhythm, and reads the warnings of all contracts meanwhile', async () => {
    const { h } = open({}, WARNER, '/');
    expect(await screen.findByTestId('pick-contract-note')).toBeTruthy();
    expect(screen.queryByTestId('clock-meeting')).toBeNull();
    expect(readsOf(h, 'getContractEarlyWarningRegister')).toHaveLength(0);
    await within(screen.getByTestId('filter-contract')).findByRole('option', { name: 'HD-001' });
    fireEvent.change(screen.getByTestId('filter-contract'), { target: { value: CONTRACT } });
    await waitFor(() => expect(readsOf(h, 'getContractEarlyWarningRegister')[0]?.path).toEqual({ id: CONTRACT }));
    expect(readsOf(h, 'listContractEarlyWarnings').at(-1)?.query).toMatchObject({ contract_id: CONTRACT });
  });

  it('says that the totals are a lower bound when the list was cut, and shows a skeleton while it reads', async () => {
    open({ listContractEarlyWarnings: page({ truncated: true }) });
    expect(await screen.findByTestId('truncated-notice')).toBeTruthy();
    cleanup();
    const waiting = client({ listContractEarlyWarnings: () => new Promise(() => undefined) });
    mount(<EarlyWarningRegisterScreen route={route} />, waiting, WARNER, '/');
    expect(screen.getByRole('status', { name: text('states.loading.label') })).toBeTruthy();
  });

  it('tells a register with no warning from a filter that matches none, and shows an error with a retry and a refusal as denied', async () => {
    const h = client({ listContractEarlyWarnings: page({ items: [] }) });
    mount(<EarlyWarningRegisterScreen route={route} />, h, WARNER, '/');
    expect(await screen.findByText(text('ui.dataTable.emptyNone'))).toBeTruthy();
    fireEvent.change(screen.getByTestId('filter-category'), { target: { value: 'COST' } });
    expect(await screen.findByText(text('ui.dataTable.emptyFiltered'))).toBeTruthy();
    cleanup();
    const broken = client({ listContractEarlyWarnings: new Error('boom') });
    mount(<EarlyWarningRegisterScreen route={route} />, broken, WARNER, '/');
    expect(await screen.findByRole('button', { name: text('states.retry.action') })).toBeTruthy();
    cleanup();
    const denied = client({ listContractEarlyWarnings: failure('SCOPE_DENIED', 403) });
    mount(<EarlyWarningRegisterScreen route={route} />, denied, WARNER, '/');
    expect(await screen.findByText(text('states.denied.title'))).toBeTruthy();
  });

  it('keeps the commands from a reader', async () => {
    open({}, WARNING_READER);
    await screen.findByTestId('clock-meeting');
    expect(screen.queryByTestId('raise-button')).toBeNull();
    expect(screen.queryByTestId('meeting-button')).toBeNull();
    expect(screen.queryByTestId('issue-button')).toBeNull();
  });

  it('raises a warning on behalf of any party, refusing an incomplete form first', async () => {
    const { h } = open();
    fireEvent.click(await screen.findByTestId('raise-button'));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: text('ctrWarn.raiseDialog.confirm.action') }));
    expect(await within(dialog).findAllByText(text('ctrReg.form.required.error'))).not.toHaveLength(0);
    expect(commandsOf(h, 'raiseContractEarlyWarning')).toHaveLength(0);
    fireEvent.change(within(dialog).getByLabelText(text('ctrWarn.raiseDialog.warnTitle.label')), { target: { value: 'The crane may arrive late' } });
    fireEvent.change(within(dialog).getByLabelText(text('ctrWarn.raiseDialog.description.label')), { target: { value: 'The supplier says it arrives after the pour.' } });
    fireEvent.change(within(dialog).getByLabelText(text('ctrWarn.raiseDialog.party.label')), { target: { value: 'SUPERVISOR' } });
    fireEvent.click(within(dialog).getByRole('button', { name: text('ctrWarn.raiseDialog.confirm.action') }));
    await waitFor(() => expect(commandsOf(h, 'raiseContractEarlyWarning')).toHaveLength(1));
    expect(commandsOf(h, 'raiseContractEarlyWarning')[0]).toMatchObject({ path: { id: CONTRACT }, body: { title: 'The crane may arrive late', category: 'TIME', raised_by_party: 'SUPERVISOR' } });
    expect(await screen.findByTestId('receipt')).toBeTruthy();
  });

  it('records a meeting only when it reviewed every open warning: the one that was skipped is named and nothing is sent', async () => {
    const { h } = open();
    fireEvent.click(await screen.findByTestId('meeting-button'));
    const dialog = await screen.findByRole('dialog');
    const reviews = await within(dialog).findByTestId('reviews');
    fireEvent.change(within(dialog).getByLabelText(text('ctrWarn.meetingDialog.attendees.label')), { target: { value: 'Owner, contractor, supervisor' } });
    const selects = within(reviews).getAllByRole('combobox');
    expect(selects).toHaveLength(2);
    fireEvent.change(selects[0] as HTMLElement, { target: { value: 'ACTION_AGREED' } });
    fireEvent.click(within(dialog).getByRole('button', { name: text('ctrWarn.meetingDialog.confirm.action') }));
    expect((await within(dialog).findByTestId('missing-reviews')).textContent).toBe(text('ctrWarn.meetingDialog.missing.error', { count: 1 }));
    expect(commandsOf(h, 'recordContractEarlyWarningMeeting')).toHaveLength(0);
    fireEvent.change(selects[1] as HTMLElement, { target: { value: 'NO_CHANGE' } });
    fireEvent.click(within(dialog).getByRole('button', { name: text('ctrWarn.meetingDialog.confirm.action') }));
    await waitFor(() => expect(commandsOf(h, 'recordContractEarlyWarningMeeting')).toHaveLength(1));
    const body = commandsOf(h, 'recordContractEarlyWarningMeeting')[0]?.body as { reviews: Array<{ warning_id: string; outcome: string }>; attendees: string };
    expect(body.attendees).toBe('Owner, contractor, supervisor');
    expect(body.reviews).toEqual([
      { warning_id: WARNING, outcome: 'ACTION_AGREED' },
      { warning_id: uuid(41), outcome: 'NO_CHANGE' },
    ]);
  });

  it('issues the register after the meeting that waits for it', async () => {
    const waiting = { id: uuid(80), ordinal: 2, held_on: '2026-11-05', attendees: 'Owner', notes: null, minutes_document_version_id: null, recorded_by_name: 'A', reissued_on: null, reviews: [] };
    const { h } = open({ getContractEarlyWarningRegister: register({ meetings: [waiting] }) });
    fireEvent.click(await screen.findByTestId('issue-button'));
    const dialog = await screen.findByRole('dialog');
    expect((within(dialog).getByLabelText(text('ctrWarn.issueDialog.meeting.label')) as HTMLSelectElement).value).toBe(uuid(80));
    fireEvent.click(within(dialog).getByRole('button', { name: text('ctrWarn.issueDialog.confirm.action') }));
    await waitFor(() => expect(commandsOf(h, 'issueContractEarlyWarningRegister')).toHaveLength(1));
    expect(commandsOf(h, 'issueContractEarlyWarningRegister')[0]?.body).toMatchObject({ meeting_id: uuid(80) });
  });

  it('says in the dialog why a meeting was refused', async () => {
    open({}, WARNER, `/?contract=${CONTRACT}`, () => failure('EARLY_WARNING_STATE_INVALID'));
    fireEvent.click(await screen.findByTestId('meeting-button'));
    const dialog = await screen.findByRole('dialog');
    const reviews = await within(dialog).findByTestId('reviews');
    fireEvent.change(within(dialog).getByLabelText(text('ctrWarn.meetingDialog.attendees.label')), { target: { value: 'Owner, contractor' } });
    for (const select of within(reviews).getAllByRole('combobox')) fireEvent.change(select, { target: { value: 'NO_CHANGE' } });
    fireEvent.click(within(dialog).getByRole('button', { name: text('ctrWarn.meetingDialog.confirm.action') }));
    expect(await within(dialog).findByText(text('ctrReg.problem.warningState.error'))).toBeTruthy();
  });
});
