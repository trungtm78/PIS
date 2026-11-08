import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { t as word, translator } from '../../i18n';
import AttentionScreen from './AttentionScreen';
import { HEAD, READER, attention, attentionList, decision, feed, harness, meeting, mount, never, problem, routeOf, uuid, world } from './test/support';

const route = routeOf('BAN-02', 'FR-BAN-02');
const fill = (key: string, params: Record<string, string | number>): string => word(key, params);

afterEach(() => {
  cleanup();
  translator.setLocale('vi');
  vi.restoreAllMocks();
});

function open(overrides: Record<string, unknown> = {}, permissions: readonly string[] | undefined = HEAD, command?: (operation: string, input: unknown) => unknown, path = '/') {
  const h = harness(world(overrides), command);
  mount(<AttentionScreen route={route} />, h, { permissions, path });
  return h;
}

const P1 = uuid(101);
const P2 = uuid(102);
const inDialog = (name: string): HTMLElement => within(screen.getByRole('dialog')).getByRole('button', { name });
const typeNote = async (text: string): Promise<void> => {
  fireEvent.change(await screen.findByLabelText(new RegExp(word('ban.att.dialog.note.label'))), { target: { value: text } });
};

describe('BAN-02, the projects that need the head', () => {
  it('UI-BAN-02: ranks the projects with their reasons in words and shapes, the exposure, the score and the decision of each', async () => {
    open();
    const first = (await screen.findByText('DA-1')).closest('tr') as HTMLElement;
    expect(within(first).getByText(word('ban.reason.delayed.label'))).toBeTruthy();
    expect(first.querySelector('[data-reason="DELAYED"]')?.textContent).toContain('◷');
    expect(first.querySelector('[data-reason="DISBURSEMENT_FAR_BELOW_PLAN"]')?.textContent).toContain('▼');
    expect(first.textContent).toContain(word('ban.reason.days.text', { value: '75', threshold: 60 }));
    expect(first.textContent).toContain(word('ban.reason.percent.text', { value: '30,00', threshold: 50 }));
    expect(within(first).getByText('123.456.789.012')).toBeTruthy();
    expect(within(first).getByText('72,50')).toBeTruthy();
    expect(within(first).getByText(word('ban.att.state.none'))).toBeTruthy();
    const second = screen.getByText('DA-2').closest('tr') as HTMLElement;
    const state = within(second).getByTestId(`decision-${P2}`);
    expect(state.getAttribute('data-decision')).toBe('deferred');
    expect(state.textContent).toContain(word('ban.att.state.until', { day: '01/12/2026' }));
    expect(state.textContent).toContain('Chờ nghiệm thu');
    expect(state.textContent).toContain('Nguyễn Văn An');
  });

  it('keeps every digit of the plan and says no data for an amount that is not known, never 0', async () => {
    open();
    const first = (await screen.findByText('DA-1')).closest('tr') as HTMLElement;
    expect(within(first).getByText('9.223.372.036.854.775.809')).toBeTruthy();
    expect(within(first).getAllByText(word('ban.common.noData.text')).length).toBeGreaterThanOrEqual(1);
    expect(first.textContent).toContain(word('ban.att.rate.text', { rate: word('ban.common.noData.text'), expected: '64,00%' }));
  });

  it('offers a reader nothing to decide, and a head without the right to direct no directive', async () => {
    open({}, READER);
    await screen.findByText('DA-1');
    expect(screen.queryByTestId(`acknowledged-${P1}`)).toBeNull();
    expect(screen.getAllByText(word('ban.att.actions.noRight')).length).toBe(2);
    cleanup();
    open({}, ['committee.read', 'committee.attention.decide']);
    await screen.findByText('DA-1');
    expect(screen.getByTestId(`acknowledged-${P1}`)).toBeTruthy();
    expect(screen.queryByTestId(`direct-${P1}`)).toBeNull();
  });

  it('acknowledges with a note: the button waits for the note, and the note is what is sent', async () => {
    const h = open({}, HEAD, () => ({ operation_id: 'op', status: 'OK', resource_version: 1, resource_id: uuid(700) }));
    fireEvent.click(await screen.findByTestId(`acknowledged-${P1}`));
    await screen.findByRole('dialog');
    expect((inDialog(word('ban.att.action.acknowledge')) as HTMLButtonElement).disabled).toBe(true);
    await typeNote('  Đã xem, theo dõi  ');
    fireEvent.click(inDialog(word('ban.att.action.acknowledge')));
    expect((await screen.findByTestId('receipt')).textContent).toContain(fill('ban.att.receipt.acknowledged', { code: 'DA-1' }));
    expect(h.command).toHaveBeenCalledWith('recordAttentionDecision', expect.objectContaining({ body: { project_id: P1, decision: 'ACKNOWLEDGED', note: 'Đã xem, theo dõi' } }));
  });

  it('defers to a day after today with a note, and refuses a day that is not after today before it asks the server', async () => {
    const h = open({}, HEAD, () => ({ operation_id: 'op', status: 'OK', resource_version: 1, resource_id: uuid(700) }));
    fireEvent.click(await screen.findByTestId(`deferred-${P1}`));
    await typeNote('Chờ nghiệm thu');
    fireEvent.change(await screen.findByTestId('defer-until'), { target: { value: '2000-01-01' } });
    fireEvent.click(inDialog(word('ban.att.action.defer')));
    expect((await screen.findByRole('alert')).textContent).toContain(word('ban.att.dialog.deferUntil.error'));
    expect(h.command).not.toHaveBeenCalled();
    fireEvent.change(screen.getByTestId('defer-until'), { target: { value: '2099-01-01' } });
    fireEvent.click(inDialog(word('ban.att.action.defer')));
    expect((await screen.findByTestId('receipt')).textContent).toContain(fill('ban.att.receipt.deferred', { code: 'DA-1', day: '01/01/2099' }));
    expect(h.command).toHaveBeenCalledWith('recordAttentionDecision', expect.objectContaining({ body: { project_id: P1, decision: 'DEFERRED', note: 'Chờ nghiệm thu', defer_until: '2099-01-01' } }));
  });

  it('reopens a deferred project and says what the server refuses inside the dialog', async () => {
    const h = open({}, HEAD, () => problem('COMMITTEE_STATE_INVALID', 409, 'already_ended'));
    fireEvent.click(await screen.findByTestId(`reopened-${P2}`));
    await typeNote('Đưa lại');
    fireEvent.click(inDialog(word('ban.att.action.reopen')));
    expect((await screen.findByRole('alert')).textContent).toContain(word('ban.common.error.alreadyEnded.text'));
    expect(h.command).toHaveBeenCalledWith('recordAttentionDecision', expect.objectContaining({ body: { project_id: P2, decision: 'REOPENED', note: 'Đưa lại' } }));
  });

  it('asks the server for one reason, and for the deferred ones when it is asked to', async () => {
    const h = open();
    await screen.findByText('DA-1');
    fireEvent.change(screen.getByRole('combobox', { name: word('ban.att.filter.reason') }), { target: { value: 'DELAYED' } });
    await waitFor(() => expect(h.read).toHaveBeenLastCalledWith('listCommitteeAttention', { query: { reason: 'DELAYED', include_deferred: false, limit: 50 } }));
    fireEvent.click(screen.getByRole('checkbox', { name: word('ban.att.filter.deferred') }));
    await waitFor(() => expect(h.read).toHaveBeenLastCalledWith('listCommitteeAttention', { query: { reason: 'DELAYED', include_deferred: true, limit: 50 } }));
  });

  describe('issuing a directive from a project row', () => {
    const commands = (log: Array<{ operation: string; input: Record<string, unknown> }>, failing?: { operation: string; times: number }) => (operation: string, input: unknown) => {
      log.push({ operation, input: input as Record<string, unknown> });
      if (failing !== undefined && operation === failing.operation && failing.times > 0) {
        failing.times -= 1;
        return problem('INTERNAL_ERROR', 500);
      }
      if (operation === 'createSteeringMeeting') return { operation_id: 'o1', status: 'OK', resource_version: 1, resource_id: uuid(1300), code: 'GB-2026-009' };
      if (operation === 'addDirective') return { operation_id: 'o2', status: 'OK', resource_version: 1, resource_id: uuid(1400) };
      return { operation_id: 'o3', status: 'OK', resource_version: 1, resource_id: uuid(700) };
    };

    it('gives the directive in a meeting that exists, to the investor of the project, then records the decision with the directive id', async () => {
      const log: Array<{ operation: string; input: Record<string, unknown> }> = [];
      open({ listSteeringMeetings: { items: [meeting(1)], next_cursor: null } }, HEAD, commands(log));
      fireEvent.click(await screen.findByTestId(`direct-${P1}`));
      const select = (await screen.findByTestId('directive-meeting')) as HTMLSelectElement;
      await waitFor(() => expect(select.value).toBe(uuid(1201)));
      fireEvent.change(screen.getByTestId('directive-text'), { target: { value: '  Đẩy nhanh giải ngân  ' } });
      fireEvent.change(screen.getByTestId('directive-due'), { target: { value: '2099-01-01' } });
      fireEvent.click(inDialog(word('ban.att.directive.confirm')));
      const receipt = await screen.findByTestId('receipt');
      expect(receipt.textContent).toContain(fill('ban.att.receipt.directed', { code: 'DA-1' }));
      expect(within(receipt).getByRole('link').getAttribute('href')).toBe(`/dir/dir-04?directive=${uuid(1400)}`);
      expect(log.map((entry) => entry.operation)).toEqual(['addDirective', 'recordAttentionDecision']);
      expect(log[0]?.input).toMatchObject({ path: { id: uuid(1201) }, body: { scope_kind: 'PROJECT', project_id: P1, text: 'Đẩy nhanh giải ngân', assignee_unit_id: uuid(201), due_on: '2099-01-01' } });
      expect(log[1]?.input).toMatchObject({ body: { project_id: P1, decision: 'DIRECTED', directive_id: uuid(1400) } });
    });

    it('opens a new meeting of the committee first when there is none, and gives the directive in it', async () => {
      const log: Array<{ operation: string; input: Record<string, unknown> }> = [];
      open({}, HEAD, commands(log));
      fireEvent.click(await screen.findByTestId(`direct-${P1}`));
      const title = (await screen.findByTestId('directive-title')) as HTMLInputElement;
      expect(title.value).toContain('Họp Ban chỉ đạo');
      fireEvent.change(screen.getByTestId('directive-text'), { target: { value: 'Báo cáo vướng mắc' } });
      fireEvent.change(screen.getByTestId('directive-due'), { target: { value: '2099-01-01' } });
      fireEvent.click(inDialog(word('ban.att.directive.confirm')));
      await screen.findByTestId('receipt');
      expect(log.map((entry) => entry.operation)).toEqual(['createSteeringMeeting', 'addDirective', 'recordAttentionDecision']);
      expect(log[0]?.input).toMatchObject({ body: { meeting_type: 'EXTRAORDINARY', unit_id: uuid(201), title: title.value.trim() } });
      expect(log[1]?.input).toMatchObject({ path: { id: uuid(1300) } });
    });

    it('refuses an incomplete directive without asking the server, with the reason of each field', async () => {
      const log: Array<{ operation: string; input: Record<string, unknown> }> = [];
      open({}, HEAD, commands(log));
      fireEvent.click(await screen.findByTestId(`direct-${P1}`));
      await screen.findByTestId('directive-form');
      fireEvent.click(inDialog(word('ban.att.directive.confirm')));
      expect((await screen.findByRole('alert')).textContent).toContain(word('ban.att.directive.invalid.text'));
      expect(screen.getByText(word('ban.att.directive.text.error'))).toBeTruthy();
      expect(screen.getByText(word('ban.att.directive.due.error'))).toBeTruthy();
      expect(log).toEqual([]);
    });

    it('after a failure at the last step says that the directive was given, and a second send answers the steps done with the same idempotency attempts', async () => {
      const log: Array<{ operation: string; input: Record<string, unknown> }> = [];
      open({ listSteeringMeetings: { items: [meeting(1)], next_cursor: null } }, HEAD, commands(log, { operation: 'recordAttentionDecision', times: 1 }));
      fireEvent.click(await screen.findByTestId(`direct-${P1}`));
      await waitFor(() => expect((screen.getByTestId('directive-meeting') as HTMLSelectElement).value).toBe(uuid(1201)));
      fireEvent.change(screen.getByTestId('directive-text'), { target: { value: 'Đẩy nhanh' } });
      fireEvent.change(screen.getByTestId('directive-due'), { target: { value: '2099-01-01' } });
      fireEvent.click(inDialog(word('ban.att.directive.confirm')));
      const alert = await screen.findByRole('alert');
      expect(alert.textContent).toContain(word('ban.att.directive.error.decisionHint'));
      expect(alert.textContent).toContain(word('ban.att.directive.step.decision'));
      fireEvent.click(inDialog(word('ban.att.directive.confirm')));
      await screen.findByTestId('receipt');
      expect(log.map((entry) => entry.operation)).toEqual(['addDirective', 'recordAttentionDecision', 'addDirective', 'recordAttentionDecision']);
      // The directive of the first send is answered again, not made twice: the same attempt is sent.
      expect(log[2]?.input.attempt).toBe(log[0]?.input.attempt);
    });
  });

  describe('the states of the list', () => {
    it('shows loading, a service error that retries in place, and permission denied by the server and by a missing right', async () => {
      open({ listCommitteeAttention: never() });
      expect(await screen.findByRole('status', { name: word('states.loading.label') })).toBeTruthy();
      cleanup();
      let failing = true;
      const h = harness((operation) => (failing ? problem('INTERNAL_ERROR', 500) : world()(operation)));
      mount(<AttentionScreen route={route} />, h, { permissions: HEAD });
      expect(await screen.findByText(word('states.error.title'))).toBeTruthy();
      failing = false;
      fireEvent.click(screen.getByRole('button', { name: word('states.retry.action') }));
      expect(await screen.findByText('DA-1')).toBeTruthy();
      cleanup();
      open({ listCommitteeAttention: problem('SCOPE_DENIED', 403) });
      expect(await screen.findByText(word('states.denied.title'))).toBeTruthy();
      cleanup();
      const without = open({}, ['directive.read']);
      expect(await screen.findByText(word('states.denied.title'))).toBeTruthy();
      expect(without.read).not.toHaveBeenCalled();
    });

    it('gives an empty list its own reason: no data, nothing needs the head, or the filter found nothing', async () => {
      open({ listCommitteeAttention: attentionList({ items: [], total: 0, shown: 0, feed: feed({ empty: true }) }) });
      expect((await screen.findByTestId('attention-empty')).textContent).toBe(word('ban.att.empty.noData.text'));
      cleanup();
      open({ listCommitteeAttention: attentionList({ items: [], total: 0, shown: 0 }) });
      expect((await screen.findByTestId('attention-empty')).textContent).toBe(word('ban.att.empty.none.text'));
      cleanup();
      open({ listCommitteeAttention: attentionList({ items: [], total: 0, shown: 0 }) }, HEAD, undefined, '/?reason=DELAYED');
      expect((await screen.findByTestId('attention-empty')).textContent).toContain(word('ban.att.empty.filtered.text'));
    });

    it('shows a directed project with the way to its directive', async () => {
      open({ listCommitteeAttention: attentionList({ items: [attention(1, { decision: decision('DIRECTED', { directive_id: uuid(1400), note: null }) })], total: 1, shown: 1 }) });
      const state = await screen.findByTestId(`decision-${P1}`);
      expect(within(state).getByRole('link').getAttribute('href')).toBe(`/dir/dir-04?directive=${uuid(1400)}`);
      expect(screen.queryByTestId(`direct-${P1}`)).toBeNull();
      expect(screen.getByTestId(`reopened-${P1}`)).toBeTruthy();
    });
  });
});
