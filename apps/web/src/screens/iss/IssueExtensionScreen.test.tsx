import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../i18n/vi.json';
import IssueExtensionScreen from './IssueExtensionScreen';
import { ESCALATOR, EXTENDER, HANDLER, READER, client, detail, event, mountIssue, person, routeOf, unit, world } from './test-support';
import type { World } from './test-support';

const ROUTE = routeOf('ISS-04', 'FR-ISS-04');
const problem = (code: string, status = 409) => new ApiError({ status, code, correlationId: 'c', extensions: {} });
const DONE = { operation_id: 'o', status: 'IN_PROGRESS', resource_version: 5, resource_id: 'x' };

afterEach(cleanup);

const open = (issue: Record<string, unknown>, permissions: readonly string[] | undefined, overrides: Partial<World> = {}, mode?: 'FULL' | 'READ_ONLY') => {
  const h = client(world({ details: [issue], ...overrides }), () => DONE);
  mountIssue(<IssueExtensionScreen route={ROUTE} />, h, { permissions, path: `/iss/iss-04?id=${String(issue.id)}`, ...(mode === undefined ? {} : { mode }) });
  return h;
};
const ready = () => screen.findByTestId('action-summary');
const working = (extra: Record<string, unknown> = {}) => detail(1, { status: 'IN_PROGRESS', assignee: person(2), version: 3, due_at: '2999-01-01T10:00:00.000Z', ...extra });

describe('IssueExtensionScreen (ISS-04): the extension of the deadline', () => {
  it('UI-ISS-04: shows how many extensions were used and sends the new deadline as the moment it is in Vietnam, with the version that was read', async () => {
    const h = open(working({ extensions: { used: 1, limit: 2 } }), EXTENDER);
    await ready();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['iss.extension.page.title']);
    expect(screen.getByTestId('extension-count').textContent).toBe(vi_['iss.extension.extend.count.text'].replace('{used}', '1').replace('{limit}', '2'));
    fireEvent.change(screen.getByLabelText(vi_['iss.extension.extend.dueAt.label']), { target: { value: '2999-01-03T09:30' } });
    fireEvent.change(screen.getByLabelText(vi_['iss.extension.extend.reason.label']), { target: { value: ' Hộ dân xin thêm thời gian ' } });
    fireEvent.click(screen.getByRole('button', { name: vi_['iss.extension.extend.action'] }));
    expect((await screen.findByTestId('done')).textContent).toBe(vi_['iss.extension.extend.done']);
    expect(h.command).toHaveBeenCalledWith(
      'extendIssueDeadline',
      expect.objectContaining({ path: { id: working().id }, body: { new_due_at: '2999-01-03T02:30:00.000Z', reason: 'Hộ dân xin thêm thời gian' }, ifMatchVersion: 3 }),
    );
  });

  it('AC-ST-ISS-003-2: judges the new deadline before it sends anything', async () => {
    const h = open(working(), EXTENDER);
    await ready();
    fireEvent.click(screen.getByRole('button', { name: vi_['iss.extension.extend.action'] }));
    expect(screen.getAllByRole('alert').map((alert) => alert.textContent)).toEqual(expect.arrayContaining([vi_['iss.field.required.error']]));
    fireEvent.change(screen.getByLabelText(vi_['iss.extension.extend.dueAt.label']), { target: { value: '2998-12-31T09:30' } });
    fireEvent.change(screen.getByLabelText(vi_['iss.extension.extend.reason.label']), { target: { value: 'x'.repeat(2001) } });
    fireEvent.click(screen.getByRole('button', { name: vi_['iss.extension.extend.action'] }));
    const alerts = screen.getAllByRole('alert').map((alert) => alert.textContent);
    expect(alerts).toContain(vi_['iss.extension.dueAtNotLater.error']);
    expect(alerts).toContain(vi_['iss.field.tooLong.error']);
    cleanup();
    open(working({ due_at: '2020-01-01T10:00:00.000Z' }), EXTENDER);
    await ready();
    fireEvent.change(screen.getByLabelText(vi_['iss.extension.extend.dueAt.label']), { target: { value: '2020-01-02T09:30' } });
    fireEvent.change(screen.getByLabelText(vi_['iss.extension.extend.reason.label']), { target: { value: 'Lý do' } });
    fireEvent.click(screen.getByRole('button', { name: vi_['iss.extension.extend.action'] }));
    expect(screen.getAllByRole('alert').map((alert) => alert.textContent)).toContain(vi_['iss.extension.dueAtInThePast.error']);
    expect(h.command).not.toHaveBeenCalled();
  });

  it('AC-ST-ISS-003-2: says why the server refused the extension: the limit, the handler approving their own, the longest extension', async () => {
    const h = open(working(), EXTENDER);
    h.command.mockRejectedValueOnce(problem('EXTENSION_LIMIT_REACHED', 422)).mockRejectedValueOnce(problem('SELF_APPROVAL_DENIED', 403)).mockRejectedValueOnce(problem('VALIDATION_FAILED', 422));
    await ready();
    fireEvent.change(screen.getByLabelText(vi_['iss.extension.extend.dueAt.label']), { target: { value: '2999-01-03T09:30' } });
    fireEvent.change(screen.getByLabelText(vi_['iss.extension.extend.reason.label']), { target: { value: 'Lý do' } });
    const send = () => fireEvent.click(screen.getByRole('button', { name: vi_['iss.extension.extend.action'] }));
    send();
    await waitFor(() => expect(screen.getByTestId('problem').textContent).toBe(vi_['iss.issueProblem.extensionLimit.error']));
    send();
    await waitFor(() => expect(screen.getByTestId('problem').textContent).toBe(vi_['iss.issueProblem.selfApproval.error']));
    send();
    await waitFor(() => expect(screen.getByTestId('problem').textContent).toBe(vi_['iss.issueProblem.validation.error']));
  });

  it('AC-ST-ISS-003-2: offers no extension once the limit is used, and says so', async () => {
    const h = open(working({ extensions: { used: 2, limit: 2 } }), EXTENDER);
    await ready();
    expect(screen.getByTestId('extension-exhausted').textContent).toBe(vi_['iss.extension.extend.exhausted.notice']);
    expect((screen.getByRole('button', { name: vi_['iss.extension.extend.action'] }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText(vi_['iss.extension.extend.dueAt.label']) as HTMLInputElement).disabled).toBe(true);
    fireEvent.submit(screen.getByRole('form', { name: vi_['iss.extension.extend.title'] }));
    expect(h.command).not.toHaveBeenCalled();
  });

  it('AC-ST-ISS-003-2: does not offer the extension to the handler of the issue, and says why', async () => {
    open(working({ assignee: person(1) }), HANDLER);
    await ready();
    expect(screen.getByTestId('extension-unavailable').textContent).toBe(vi_['iss.extension.extend.handler.notice']);
    expect(screen.queryByRole('button', { name: vi_['iss.extension.extend.action'] })).toBeNull();
  });

  it('lists the extensions that were granted, who granted them and why', async () => {
    open(
      working({
        events: [
          event(1, 'CREATED'),
          event(2, 'EXTENDED', { actor: person(3), note: 'Hộ dân xin thêm thời gian', payload: { previous_due_at: '2026-10-21T10:00:00.000Z', new_due_at: '2026-10-23T10:00:00.000Z', extension_number: 1 } }),
        ],
      }),
      READER,
    );
    await ready();
    const list = within(screen.getByTestId('extensions'));
    expect(list.getAllByRole('listitem')).toHaveLength(1);
    expect(list.getByText('Hộ dân xin thêm thời gian')).toBeTruthy();
    expect(list.getByText(/Nguyễn Văn C/)).toBeTruthy();
  });

  it('says that the deadline has not been extended, and why nothing is offered to a reader, in a finished state and while read-only', async () => {
    open(working(), READER);
    await ready();
    expect(screen.getByTestId('no-extensions').textContent).toBe(vi_['iss.extension.history.none.text']);
    expect(screen.getByTestId('extension-unavailable').textContent).toBe(vi_['iss.workspace.actions.denied.notice']);
    cleanup();
    open(working({ status: 'PENDING_VERIFICATION' }), EXTENDER);
    await ready();
    expect(screen.getByTestId('extension-unavailable').textContent).toBe(vi_['iss.extension.extend.state.notice']);
    cleanup();
    open(working(), EXTENDER, {}, 'READ_ONLY');
    await ready();
    expect(screen.getByTestId('extension-unavailable').textContent).toBe(vi_['iss.workspace.actions.frozen.notice']);
  });
});

describe('IssueExtensionScreen (ISS-04): the escalation of an issue', () => {
  const FORCE = { id: '00000000-0000-4000-8000-0000000000f9', code: 'TF-A-01', name: 'Tổ công tác A' };
  const escalatable = (extra: Record<string, unknown> = {}) => working({ assignee: person(2), active_task_force: FORCE, ...extra });
  const openWith = (issue: Record<string, unknown>, permissions: readonly string[]) => open(issue, permissions, { units: [unit(1), unit(2)] });

  it('UI-ISS-04: raises the issue to a unit chosen on the list, with the reason and the version that was read', async () => {
    const h = openWith(escalatable({ owner_unit_id: unit(1).id, owner_unit_name: 'Ủy ban nhân dân 1' }), ESCALATOR);
    await ready();
    expect(within(screen.getByLabelText(vi_['iss.extension.escalate.level.label'])).getAllByRole('option').map((option) => option.textContent)).toEqual([
      vi_['iss.create.choose.option'],
      vi_['iss.escalation.level1.option'],
      vi_['iss.escalation.level2.option'],
      vi_['iss.escalation.level3.option'],
    ]);
    fireEvent.click(screen.getByRole('button', { name: vi_['iss.extension.escalate.action'] }));
    expect(screen.getAllByRole('alert').map((alert) => alert.textContent)).toContain(vi_['iss.field.required.error']);
    expect(h.command).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText(vi_['iss.extension.escalate.level.label']), { target: { value: '1' } });
    await waitFor(() => expect(within(screen.getByLabelText(vi_['iss.extension.escalate.unit.label'])).getAllByRole('option').length).toBe(2));
    fireEvent.change(screen.getByLabelText(vi_['iss.extension.escalate.unit.label']), { target: { value: unit(2).id } });
    fireEvent.change(screen.getByLabelText(vi_['iss.extension.escalate.reason.label']), { target: { value: ' Chủ đầu tư chưa trả lời ' } });
    fireEvent.click(screen.getByRole('button', { name: vi_['iss.extension.escalate.action'] }));
    expect((await screen.findByTestId('done')).textContent).toBe(vi_['iss.extension.escalate.done']);
    expect(h.command).toHaveBeenCalledWith('escalateIssue', expect.objectContaining({ path: { id: working().id }, body: { level: 1, reason: 'Chủ đầu tư chưa trả lời', target_unit_id: unit(2).id }, ifMatchVersion: 3 }));
  });

  it('AC-ST-ISS-004-1: raises the issue to the task force that answers for it, without choosing a unit', async () => {
    const h = openWith(escalatable(), ESCALATOR);
    await ready();
    fireEvent.change(screen.getByLabelText(vi_['iss.extension.escalate.level.label']), { target: { value: '3' } });
    expect(screen.getByTestId('task-force').textContent).toBe(vi_['iss.extension.escalate.taskForce.text'].replace('{code}', 'TF-A-01').replace('{name}', 'Tổ công tác A'));
    expect(screen.queryByLabelText(vi_['iss.extension.escalate.unit.label'])).toBeNull();
    fireEvent.change(screen.getByLabelText(vi_['iss.extension.escalate.reason.label']), { target: { value: 'Quá hạn nhiều ngày' } });
    fireEvent.click(screen.getByRole('button', { name: vi_['iss.extension.escalate.action'] }));
    await screen.findByTestId('done');
    expect(h.command).toHaveBeenCalledWith('escalateIssue', expect.objectContaining({ body: { level: 3, reason: 'Quá hạn nhiều ngày', task_force_id: FORCE.id } }));
  });

  it('AC-ST-ISS-004-1: offers no task force when none answers for the issue, only the levels above the one reached, and says so', async () => {
    openWith(escalatable({ active_task_force: null, escalation_level: 1 }), ESCALATOR);
    await ready();
    expect(screen.getByTestId('no-task-force').textContent).toBe(vi_['iss.extension.escalate.noTaskForce.text']);
    expect(within(screen.getByLabelText(vi_['iss.extension.escalate.level.label'])).getAllByRole('option').map((option) => option.textContent)).toEqual([vi_['iss.create.choose.option'], vi_['iss.escalation.level2.option']]);
    cleanup();
    openWith(escalatable({ active_task_force: null, escalation_level: 2 }), ESCALATOR);
    await ready();
    expect(screen.getByTestId('escalate-none').textContent).toBe(vi_['iss.extension.escalate.none.notice']);
  });

  it('says why the server refused the escalation: the task force that is no longer active, the level, the length of the reason', async () => {
    const h = openWith(escalatable(), ESCALATOR);
    h.command.mockRejectedValueOnce(problem('TASK_FORCE_NOT_ACTIVE', 422)).mockRejectedValueOnce(problem('ESCALATION_LEVEL_INVALID', 422));
    await ready();
    fireEvent.change(screen.getByLabelText(vi_['iss.extension.escalate.level.label']), { target: { value: '3' } });
    fireEvent.change(screen.getByLabelText(vi_['iss.extension.escalate.reason.label']), { target: { value: 'x'.repeat(2001) } });
    fireEvent.click(screen.getByRole('button', { name: vi_['iss.extension.escalate.action'] }));
    expect(screen.getAllByRole('alert').map((alert) => alert.textContent)).toContain(vi_['iss.field.tooLong.error']);
    fireEvent.change(screen.getByLabelText(vi_['iss.extension.escalate.reason.label']), { target: { value: 'Lý do' } });
    fireEvent.click(screen.getByRole('button', { name: vi_['iss.extension.escalate.action'] }));
    await waitFor(() => expect(screen.getByTestId('problem').textContent).toBe(vi_['iss.issueProblem.taskForceNotActive.error']));
    fireEvent.click(screen.getByRole('button', { name: vi_['iss.extension.escalate.action'] }));
    await waitFor(() => expect(screen.getByTestId('problem').textContent).toBe(vi_['iss.issueProblem.escalationLevel.error']));
  });

  it('lists the escalations of the issue, who they went to, and whether they were accepted', async () => {
    openWith(
      escalatable({
        escalation_level: 3,
        escalations: [
          { id: 'e3', level: 3, trigger: 'SLA_AUTO', status: 'ACCEPTED', target_unit: null, task_force: FORCE, reason: 'SLA_L3_THRESHOLD_REACHED', accept_due_at: '2026-10-22T02:00:00.000Z', accepted_by: { membership_id: 'm' }, accepted_at: '2026-10-21T02:00:00.000Z', created_at: '2026-10-21T01:00:00.000Z' },
          { id: 'e2', level: 2, trigger: 'MANUAL', status: 'OPEN', target_unit: { id: 'u1', name: 'Ủy ban nhân dân 1' }, task_force: null, reason: 'Chủ đầu tư chưa trả lời', accept_due_at: '2026-10-21T02:00:00.000Z', accepted_by: null, accepted_at: null, created_at: '2026-10-20T01:00:00.000Z' },
        ],
      }),
      READER,
    );
    await ready();
    const list = within(screen.getByTestId('escalations'));
    expect(list.getAllByRole('listitem')).toHaveLength(2);
    expect(list.getByText('TF-A-01 · Tổ công tác A', { exact: false })).toBeTruthy();
    expect(list.getByText('Chủ đầu tư chưa trả lời')).toBeTruthy();
    expect(list.queryByText('SLA_L3_THRESHOLD_REACHED')).toBeNull();
    expect(screen.queryByRole('button', { name: vi_['iss.extension.escalate.action'] })).toBeNull();
  });

  it('says that the issue has not been escalated, and offers no escalation on an issue nobody has taken up', async () => {
    openWith(working({ status: 'OPEN', assignee: null }), ESCALATOR);
    await ready();
    expect(screen.getByTestId('no-escalations').textContent).toBe(vi_['iss.extension.escalations.none.text']);
    expect(screen.queryByRole('button', { name: vi_['iss.extension.escalate.action'] })).toBeNull();
    expect(screen.getByTestId('extension-unavailable')).toBeTruthy();
  });
});
