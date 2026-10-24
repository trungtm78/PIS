import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../i18n/vi.json';
import IssueWorkspaceScreen from './IssueWorkspaceScreen';
import { COORDINATOR, EXTENDER, READER, SELF_MEMBERSHIP, VERIFIER, WORKER, client, detail, event, member, mountIssue, person, routeOf, unit, world } from './test-support';
import type { World } from './test-support';

const ROUTE = routeOf('ISS-03', 'FR-ISS-03');
const problem = (code: string, status = 409) => new ApiError({ status, code, correlationId: 'c', extensions: {} });
const DONE = { operation_id: 'o', status: 'ASSIGNED', resource_version: 2, resource_id: 'x' };

afterEach(cleanup);

const open = (issue: Record<string, unknown>, permissions: readonly string[] | undefined = COORDINATOR, overrides: Partial<World> = {}, command: (operation: string, input: unknown) => unknown = () => DONE) => {
  const h = client(world({ details: [issue], units: [unit(1), unit(2)], members: [member(1), member(2)], ...overrides }), command);
  mountIssue(<IssueWorkspaceScreen route={ROUTE} />, h, { permissions, path: `/iss/iss-03?id=${String(issue.id)}` });
  return h;
};
const ready = () => screen.findByTestId('summary');
const timelineKinds = (): string[] => Array.from(screen.getByTestId('timeline').querySelectorAll('li')).map((item) => item.getAttribute('data-kind') ?? '');

describe('IssueWorkspaceScreen (ISS-03): the workspace of one issue', () => {
  it('shows the issue, the SLA it was opened under, where it stands against its deadline and the timeline (UI-ISS-03)', async () => {
    open(
      detail(1, {
        status: 'IN_PROGRESS',
        assignee: person(2),
        overdue_since: '2026-10-01T02:00:00.000Z',
        overdue_days: 3,
        escalation_level: 1,
        responded_at: '2026-10-20T04:00:00.000Z',
        events: [event(1, 'CREATED', { to_status: 'OPEN' }), event(2, 'ASSIGNED', { to_assignee: person(2), from_status: 'OPEN', to_status: 'ASSIGNED', note: 'Nhờ anh xử lý' }), event(3, 'STARTED', { from_status: 'ASSIGNED', to_status: 'IN_PROGRESS' })],
      }),
    );
    await ready();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('VM-2026-000001 · Chậm bàn giao mặt bằng số 1');
    expect(screen.getByTestId('status').textContent).toBe(vi_['iss.status.inProgress.text']);
    expect(screen.getByTestId('severity').textContent).toBe(vi_['iss.severity.high.text']);
    expect(screen.getByTestId('due-state').textContent).toBe(`${vi_['iss.due.overdue.badge']} · ${vi_['iss.due.overdueDays.text'].replace('{count}', '3')}`);
    const summary = within(screen.getByTestId('summary'));
    expect(summary.getByText('DA-2026-001 · Dự án số 1')).toBeTruthy();
    expect(summary.getByText('Nguyễn Văn B')).toBeTruthy();
    expect(summary.getByText(vi_['iss.escalation.level.text'].replace('{level}', '1'))).toBeTruthy();
    expect(summary.getByText(/Hộ dân chưa nhận tiền/)).toBeTruthy();
    const sla = screen.getByTestId('sla');
    expect(sla.textContent).toContain(vi_['iss.due.overdueDays.text'].replace('{count}', '3'));
    expect(screen.getByText(vi_['iss.workspace.sla.policy.text'].replace('{code}', 'SLA-GPMB-HIGH').replace('{revision}', '2'))).toBeTruthy();
    expect(screen.getByText(vi_['iss.workspace.sla.hours.text'].replace('{response}', '4').replace('{resolve}', '72').replace('{calendar}', 'WORKDAY_VN'))).toBeTruthy();
    expect(screen.getByText(vi_['iss.workspace.sla.evidence.text'], { exact: false })).toBeTruthy();
    expect(timelineKinds()).toEqual(['CREATED', 'ASSIGNED', 'STARTED']);
    expect(within(screen.getByTestId('timeline')).getByText('Nhờ anh xử lý')).toBeTruthy();
    expect(within(screen.getByTestId('timeline')).getByText(vi_['iss.event.assigned.text'].replace('{to}', 'Nguyễn Văn B'))).toBeTruthy();
  });

  it('keeps the days overdue on the issue when it has moved to another unit, and names both units in the timeline (AC-ST-ISS-002-1)', async () => {
    open(
      detail(1, {
        owner_unit_name: 'Ủy ban nhân dân 2',
        overdue_since: '2026-10-01T02:00:00.000Z',
        overdue_days: 3,
        events: [event(1, 'CREATED'), event(2, 'TRANSFERRED', { note: 'Công trình thuộc xã khác', payload: { from_unit_id: unit(1).id, to_unit_id: unit(2).id } })],
      }),
    );
    await ready();
    expect(screen.getByTestId('due-state').textContent).toContain(vi_['iss.due.overdueDays.text'].replace('{count}', '3'));
    await waitFor(() =>
      expect(within(screen.getByTestId('timeline')).getByText(vi_['iss.event.transferred.text'].replace('{from}', 'UBND-1 · Ủy ban nhân dân 1').replace('{to}', 'UBND-2 · Ủy ban nhân dân 2'))).toBeTruthy(),
    );
    expect(within(screen.getByTestId('timeline')).getByText('Công trình thuộc xã khác')).toBeTruthy();
  });

  it('says when the days overdue cannot be counted, and shows nothing about a deadline that is kept', async () => {
    open(detail(1, { overdue_since: '2026-10-01T02:00:00.000Z', overdue_days: null }));
    await ready();
    expect(screen.getByTestId('due-state').textContent).toContain(vi_['iss.due.overdueUnknown.text']);
  });

  it('shows the position with the warning for a low accuracy, and says when no position is stored (BR-ISS-06)', async () => {
    open(detail(1, { geo_consent: true, geo: { lat: '10.800000', lng: '106.700000', accuracy_m: '60.00', low_accuracy: true } }));
    await ready();
    expect(screen.getByTestId('geo').textContent).toContain('10.800000, 106.700000');
    expect(screen.getByTestId('geo').textContent).toContain(vi_['iss.workspace.geo.accuracy.text'].replace('{accuracy}', '60.00'));
    expect(screen.getByTestId('geo-low-accuracy').textContent).toBe(vi_['iss.workspace.geo.low.badge']);
    cleanup();
    open(detail(2, { geo_consent: false, geo: null }));
    await ready();
    expect(screen.getByTestId('geo-none').textContent).toBe(vi_['iss.workspace.geo.none.text']);
    cleanup();
    open(detail(3, { geo_consent: true, geo: null }));
    await ready();
    expect(screen.getByTestId('geo-none').textContent).toBe(vi_['iss.workspace.geo.consentOnly.text']);
    cleanup();
    open(detail(4, { geo: { lat: '10.8', lng: '106.7', accuracy_m: null, low_accuracy: false } }));
    await ready();
    expect(screen.queryByTestId('geo-low-accuracy')).toBeNull();
  });

  it('says that the text is not shown with the rights of the reader, and keeps the sequence of the timeline whole', async () => {
    open(detail(1, { description: null, events: [event(1, 'CREATED'), event(2, 'COMMENTED', { note: null })] }), READER);
    await ready();
    expect(screen.getByTestId('description-hidden').textContent).toBe(vi_['iss.workspace.description.hidden']);
    expect(timelineKinds()).toEqual(['CREATED', 'COMMENTED']);
  });

  it('reads the whole timeline when it runs over several pages', async () => {
    const page = { events: [event(3, 'COMMENTED', { note: 'Ý kiến ở trang hai' })], next_cursor: null };
    open(detail(1, { events: [event(1, 'CREATED'), event(2, 'ASSIGNED')], next_cursor: 'next-page' }), READER, { pages: new Map([['next-page', page]]) });
    await ready();
    await waitFor(() => expect(timelineKinds()).toEqual(['CREATED', 'ASSIGNED', 'COMMENTED']));
    expect(within(screen.getByTestId('timeline')).getByText('Ý kiến ở trang hai')).toBeTruthy();
  });

  it('says when no issue is named, when the issue is not in the scope (404), and when the read fails offers to try again', async () => {
    mountIssue(<IssueWorkspaceScreen route={ROUTE} />, client(world()), { permissions: READER, path: '/iss/iss-03' });
    expect((await screen.findByTestId('no-issue')).textContent).toBe(vi_['iss.workspace.noIssue.notice']);
    cleanup();
    mountIssue(<IssueWorkspaceScreen route={ROUTE} />, client(world({ details: [] })), { permissions: READER, path: '/iss/iss-03?id=00000000-0000-4000-8000-a20000000009' });
    expect(await screen.findByRole('alert')).toBeTruthy();
    cleanup();
    const state = world({ details: [detail(1)], failing: new Set(['get_resources_issue_id']) });
    mountIssue(<IssueWorkspaceScreen route={ROUTE} />, client(state), { permissions: READER, path: `/iss/iss-03?id=${String(detail(1).id)}` });
    expect(await screen.findByRole('alert')).toBeTruthy();
    state.failing = new Set();
    fireEvent.click(screen.getByRole('button', { name: vi_['states.retry.action'] }));
    await ready();
  });

  describe('assigning', () => {
    it('gives the issue to a person the server lists with the version that was read', async () => {
      const h = open(detail(1));
      await ready();
      await waitFor(() => expect(within(screen.getByLabelText(vi_['iss.workspace.assign.assignee.label'])).getAllByRole('option').map((option) => option.textContent)).toEqual([vi_['iss.create.choose.option'], 'Nguyễn Văn A', 'Nguyễn Văn B']));
      // The choice comes from the read scoped by the issue, never from the directory of members.
      expect(h.client.readAll).toHaveBeenCalledWith('listIssueAssignees', { path: { id: detail(1).id } });
      expect(h.client.readAll).not.toHaveBeenCalledWith('get_resources_membership');
      fireEvent.change(screen.getByLabelText(vi_['iss.workspace.assign.assignee.label']), { target: { value: member(2).membership_id } });
      fireEvent.change(screen.getByLabelText(vi_['iss.workspace.assign.note.label']), { target: { value: ' Nhờ anh xử lý ' } });
      fireEvent.click(screen.getByRole('button', { name: vi_['iss.workspace.assign.action'] }));
      expect((await screen.findByTestId('assigned')).textContent).toBe(vi_['iss.workspace.assign.done']);
      expect(h.command).toHaveBeenCalledWith('assignIssue', expect.objectContaining({ path: { id: detail(1).id }, body: { assignee_id: member(2).membership_id, note: 'Nhờ anh xử lý' }, ifMatchVersion: 1 }));
    });

    it('asks for the assignee before it sends anything, and says why the assignee was refused', async () => {
      const h = open(detail(1));
      h.command.mockRejectedValue(problem('ASSIGNEE_OUT_OF_SCOPE', 422));
      await ready();
      fireEvent.click(screen.getByRole('button', { name: vi_['iss.workspace.assign.action'] }));
      expect(screen.getAllByRole('alert').map((alert) => alert.textContent)).toContain(vi_['iss.field.required.error']);
      expect(h.command).not.toHaveBeenCalled();
      await waitFor(() => expect(within(screen.getByLabelText(vi_['iss.workspace.assign.assignee.label'])).getAllByRole('option').length).toBeGreaterThan(1));
      fireEvent.change(screen.getByLabelText(vi_['iss.workspace.assign.assignee.label']), { target: { value: member(1).membership_id } });
      fireEvent.click(screen.getByRole('button', { name: vi_['iss.workspace.assign.action'] }));
      await waitFor(() => expect(screen.getByTestId('problem').textContent).toBe(vi_['iss.issueProblem.assigneeOutOfScope.error']));
    });

    it('says that the people cannot be read when the list fails', async () => {
      open(detail(1), COORDINATOR, { failing: new Set(['listIssueAssignees']) });
      await ready();
      expect((await screen.findByTestId('members-unavailable')).textContent).toBe(vi_['iss.workspace.assign.members.error']);
    });

    it('offers to read the issue again after a conflict of versions, and shows what changed', async () => {
      const state = world({ details: [detail(1)], units: [unit(1)], members: [member(1)] });
      const h = client(state, () => DONE);
      h.command.mockRejectedValueOnce(problem('VERSION_CONFLICT'));
      mountIssue(<IssueWorkspaceScreen route={ROUTE} />, h, { permissions: COORDINATOR, path: `/iss/iss-03?id=${String(detail(1).id)}` });
      await ready();
      await waitFor(() => expect(within(screen.getByLabelText(vi_['iss.workspace.assign.assignee.label'])).getAllByRole('option').length).toBeGreaterThan(1));
      fireEvent.change(screen.getByLabelText(vi_['iss.workspace.assign.assignee.label']), { target: { value: member(1).membership_id } });
      fireEvent.click(screen.getByRole('button', { name: vi_['iss.workspace.assign.action'] }));
      await waitFor(() => expect(screen.getByTestId('problem').textContent).toBe(vi_['iss.issueProblem.versionConflict.error']));
      state.details = [detail(1, { version: 3, status: 'ASSIGNED', assignee: person(2) })];
      fireEvent.click(screen.getByRole('button', { name: vi_['iss.workspace.reload.action'] }));
      await waitFor(() => expect(screen.getByTestId('status').textContent).toBe(vi_['iss.status.assigned.text']));
      expect(screen.queryByTestId('problem')).toBeNull();
    });
  });

  describe('starting', () => {
    it('offers the start to the assignee alone, and sends it with the version that was read', async () => {
      const mine = detail(1, { status: 'ASSIGNED', assignee: person(1), version: 2 });
      const h = open(mine, WORKER);
      await ready();
      fireEvent.click(screen.getByRole('button', { name: vi_['iss.workspace.start.action'] }));
      await waitFor(() => expect(h.command).toHaveBeenCalledWith('startIssue', expect.objectContaining({ path: { id: mine.id }, body: {}, ifMatchVersion: 2 })));
      cleanup();
      open(detail(2, { status: 'ASSIGNED', assignee: person(2), version: 2 }), WORKER);
      await ready();
      expect(screen.queryByRole('button', { name: vi_['iss.workspace.start.action'] })).toBeNull();
      expect(SELF_MEMBERSHIP).toBe(person(1).membership_id);
    });

    it('says why the start was refused', async () => {
      const h = open(detail(1, { status: 'ASSIGNED', assignee: person(1) }), WORKER);
      h.command.mockRejectedValue(problem('ISSUE_STATE_INVALID'));
      await ready();
      fireEvent.click(screen.getByRole('button', { name: vi_['iss.workspace.start.action'] }));
      await waitFor(() => expect(screen.getByTestId('problem').textContent).toBe(vi_['iss.issueProblem.stateInvalid.error']));
    });
  });

  describe('commenting', () => {
    it('adds the opinion to the timeline, and clears the form', async () => {
      const h = open(detail(1), WORKER);
      await ready();
      fireEvent.click(screen.getByRole('button', { name: vi_['iss.workspace.comment.action'] }));
      expect(screen.getAllByRole('alert').map((alert) => alert.textContent)).toContain(vi_['iss.field.required.error']);
      expect(h.command).not.toHaveBeenCalled();
      fireEvent.change(screen.getByLabelText(vi_['iss.workspace.comment.note.label']), { target: { value: 'x'.repeat(2001) } });
      fireEvent.click(screen.getByRole('button', { name: vi_['iss.workspace.comment.action'] }));
      expect(screen.getAllByRole('alert').map((alert) => alert.textContent)).toContain(vi_['iss.field.tooLong.error']);
      fireEvent.change(screen.getByLabelText(vi_['iss.workspace.comment.note.label']), { target: { value: ' Đã gặp hộ dân ' } });
      fireEvent.click(screen.getByRole('button', { name: vi_['iss.workspace.comment.action'] }));
      expect((await screen.findByTestId('commented')).textContent).toBe(vi_['iss.workspace.comment.done']);
      expect(h.command).toHaveBeenCalledWith('commentIssue', expect.objectContaining({ path: { id: detail(1).id }, body: { note: 'Đã gặp hộ dân' } }));
      expect((screen.getByLabelText(vi_['iss.workspace.comment.note.label']) as HTMLTextAreaElement).value).toBe('');
    });
  });

  describe('transferring', () => {
    it('moves the issue to another unit with a reason, saying that the deadline and the days overdue stay', async () => {
      const h = open(detail(1, { version: 4 }));
      await ready();
      expect(screen.getByText(vi_['iss.workspace.transfer.keep.text'])).toBeTruthy();
      // The unit that already answers for the issue is not offered.
      await waitFor(() => expect(within(screen.getByLabelText(vi_['iss.workspace.transfer.unit.label'])).getAllByRole('option').map((option) => option.textContent)).toEqual([vi_['iss.create.choose.option'], 'UBND-2 · Ủy ban nhân dân 2']));
      fireEvent.click(screen.getByRole('button', { name: vi_['iss.workspace.transfer.action'] }));
      expect(screen.getAllByRole('alert').map((alert) => alert.textContent)).toContain(vi_['iss.field.required.error']);
      expect(h.command).not.toHaveBeenCalled();
      fireEvent.change(screen.getByLabelText(vi_['iss.workspace.transfer.unit.label']), { target: { value: unit(2).id } });
      fireEvent.change(screen.getByLabelText(vi_['iss.workspace.transfer.reason.label']), { target: { value: ' Công trình thuộc xã khác ' } });
      fireEvent.click(screen.getByRole('button', { name: vi_['iss.workspace.transfer.action'] }));
      expect((await screen.findByTestId('transferred')).textContent).toBe(vi_['iss.workspace.transfer.done']);
      expect(h.command).toHaveBeenCalledWith('transferIssueUnit', expect.objectContaining({ path: { id: detail(1).id }, body: { target_unit_id: unit(2).id, reason: 'Công trình thuộc xã khác' }, ifMatchVersion: 4 }));
    });

    it('says why the transfer was refused', async () => {
      const h = open(detail(1));
      h.command.mockRejectedValue(problem('SCOPE_DENIED', 403));
      await ready();
      await waitFor(() => expect(within(screen.getByLabelText(vi_['iss.workspace.transfer.unit.label'])).getAllByRole('option').length).toBeGreaterThan(1));
      fireEvent.change(screen.getByLabelText(vi_['iss.workspace.transfer.unit.label']), { target: { value: unit(2).id } });
      fireEvent.change(screen.getByLabelText(vi_['iss.workspace.transfer.reason.label']), { target: { value: 'Lý do' } });
      fireEvent.click(screen.getByRole('button', { name: vi_['iss.workspace.transfer.action'] }));
      await waitFor(() => expect(screen.getByTestId('problem').textContent).toBe(vi_['iss.issueProblem.denied.error']));
    });
  });

  describe('what is offered', () => {
    it('offers no command to someone who only reads, and says so', async () => {
      open(detail(1), READER);
      await ready();
      expect(screen.getByTestId('read-only').textContent).toBe(vi_['iss.workspace.actions.denied.notice']);
      for (const name of [vi_['iss.workspace.assign.action'], vi_['iss.workspace.comment.action'], vi_['iss.workspace.transfer.action'], vi_['iss.workspace.start.action']]) {
        expect(screen.queryByRole('button', { name })).toBeNull();
      }
    });

    it('offers no command on a closed issue, and none while the system is read-only', async () => {
      open(detail(1, { status: 'CLOSED', closed_at: '2026-10-22T02:00:00.000Z' }));
      await ready();
      expect(screen.getByTestId('read-only').textContent).toBe(vi_['iss.workspace.actions.closed.notice']);
      expect(screen.getByTestId('due-state').textContent).toBe(vi_['iss.due.closed.badge']);
      cleanup();
      mountIssue(<IssueWorkspaceScreen route={ROUTE} />, client(world({ details: [detail(2)] })), { permissions: COORDINATOR, mode: 'READ_ONLY', path: `/iss/iss-03?id=${String(detail(2).id)}` });
      await ready();
      expect(screen.getByTestId('read-only').textContent).toBe(vi_['iss.workspace.actions.frozen.notice']);
    });
  });
  describe('the next steps (ISS-04 and ISS-07)', () => {
    const links = (): string[] => within(screen.getByTestId('more-actions')).getAllByRole('link').map((link) => link.getAttribute('href') ?? '');

    it('leads the handler of a working issue to the report of the result, and the coordinator who extends to the extension', async () => {
      open(detail(1, { status: 'IN_PROGRESS', assignee: person(1) }), ['issue.read', 'issue.work', 'issue.extend']);
      await ready();
      expect(links()).toEqual([`/iss/iss-07?id=${String(detail(1).id)}`, `/iss/iss-04?id=${String(detail(1).id)}`]);
    });

    it('leads the verifier of an issue that waits for its confirmation to the closing, and the one who may reopen to the reopening, and nobody to the extension of those', async () => {
      open(detail(1, { status: 'PENDING_VERIFICATION', assignee: person(2) }), VERIFIER);
      await ready();
      expect(links()).toEqual([`/iss/iss-07?id=${String(detail(1).id)}`]);
      cleanup();
      open(detail(2, { status: 'CLOSED', assignee: person(2) }), VERIFIER);
      await ready();
      expect(links()).toEqual([`/iss/iss-07?id=${String(detail(2).id)}`]);
      expect(screen.queryByTestId('read-only')).toBeNull();
    });

    it('leads a reader of an escalated issue to the board of escalations, and the one who may only escalate to ISS-04 while the issue can be raised', async () => {
      const escalation = { id: 'e1', level: 2, trigger: 'SLA_AUTO', status: 'OPEN', target_unit: { id: 'u1', name: 'Unit 1' }, task_force: null, reason: 'SLA_L2_THRESHOLD_REACHED', accept_due_at: '2999-01-01T00:00:00.000Z', accepted_by: null, accepted_at: null, created_at: '2026-10-20T00:00:00.000Z' };
      open(detail(1, { status: 'ESCALATED', assignee: person(2), escalations: [escalation] }), READER);
      await ready();
      expect(links()).toEqual(['/iss/iss-10']);
      expect(screen.queryByTestId('read-only')).toBeNull();
      cleanup();
      open(detail(2, { status: 'IN_PROGRESS', assignee: person(2) }), ['issue.read', 'issue.escalate']);
      await ready();
      expect(links()).toEqual([`/iss/iss-04?id=${String(detail(2).id)}`]);
      cleanup();
      open(detail(3, { status: 'OPEN' }), ['issue.read', 'issue.escalate']);
      await ready();
      expect(screen.queryByTestId('more-actions')).toBeNull();
    });

    it('leads the one who extends deadlines to the extension of an open issue, and offers nothing to a reader', async () => {
      open(detail(1), EXTENDER);
      await ready();
      expect(links()).toEqual([`/iss/iss-04?id=${String(detail(1).id)}`]);
      cleanup();
      open(detail(2), READER);
      await ready();
      expect(screen.queryByTestId('more-actions')).toBeNull();
    });
  });
});
