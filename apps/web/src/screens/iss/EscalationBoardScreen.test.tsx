import { ApiError } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { t } from '../../i18n';
import vi_ from '../../i18n/vi.json';
import EscalationBoardScreen from './EscalationBoardScreen';
import { READER, breach, client, mountIssue, routeOf, world } from './test-support';
import type { World } from './test-support';

const ROUTE = routeOf('ISS-10', 'FR-ISS-10');
const problem = (code: string, status = 409) => new ApiError({ status, code, correlationId: 'c', extensions: {} });
const DONE = { operation_id: 'o', status: 'IN_PROGRESS', resource_version: 6, resource_id: 'x' };

afterEach(cleanup);

const open = (overrides: Partial<World>, mode?: 'FULL' | 'READ_ONLY') => {
  const h = client(world(overrides), () => DONE);
  mountIssue(<EscalationBoardScreen route={ROUTE} />, h, { permissions: READER, path: '/iss/iss-10', ...(mode === undefined ? {} : { mode }) });
  return h;
};
const ready = () => screen.findByTestId('board');
const cards = (): string[] => Array.from(screen.getByTestId('board').querySelectorAll('article')).map((card) => card.getAttribute('data-escalation-id') ?? '');
const TASK_FORCE = { id: '00000000-0000-4000-8000-0000000000f9', code: 'TF-A-01', name: 'Tổ công tác A' };

describe('EscalationBoardScreen (ISS-10): the escalations that wait for their receiver', () => {
  it('UI-ISS-10: shows a column for each level with the cards in it, and on each card who it is addressed to, by when it is due and since when the issue is overdue', async () => {
    open({
      breaches: [
        breach(1, { level: 2 }),
        breach(2, { level: 3, target_unit: null, task_force: TASK_FORCE, accept_due_at: '2020-01-01T00:00:00.000Z', overdue_since: null, overdue_days: null }),
        breach(3, { level: 2, status: 'ACCEPTED', accepted_at: '2026-10-21T02:00:00.000Z', overdue_days: null }),
      ],
    });
    await ready();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['iss.board.page.title']);
    expect(screen.getByTestId('count').textContent).toBe(vi_['iss.board.count.text'].replace('{count}', '3'));
    const columns = Array.from(screen.getByTestId('board').querySelectorAll('section[data-level]')).map((section) => section.getAttribute('data-level'));
    expect(columns).toEqual(['1', '2', '3']);
    expect(within(screen.getByTestId('board').querySelector('section[data-level="1"]') as HTMLElement).getByText(vi_['iss.board.column.empty'])).toBeTruthy();
    const second = screen.getByTestId('board').querySelector(`article[data-escalation-id="${String(breach(1).escalation_id)}"]`) as HTMLElement;
    expect(within(second).getByRole('link', { name: 'VM-2026-000001' }).getAttribute('href')).toBe(`/iss/iss-03?id=${String(breach(1).issue_id)}`);
    expect(within(second).getByText(vi_['iss.board.target.text'].replace('{target}', 'Ủy ban nhân dân 1'))).toBeTruthy();
    expect(within(second).getByTestId('accept-state').getAttribute('data-state')).toBe('waiting');
    expect(second.textContent).toContain(vi_['iss.board.overdue.text'].split('{date}')[0]);
    const force = screen.getByTestId('board').querySelector(`article[data-escalation-id="${String(breach(2).escalation_id)}"]`) as HTMLElement;
    expect(within(force).getByText(vi_['iss.board.target.text'].replace('{target}', 'TF-A-01 · Tổ công tác A'))).toBeTruthy();
    expect(within(force).getByTestId('accept-state').getAttribute('data-state')).toBe('late');
    expect(within(force).getByText(vi_['iss.board.notOverdue.text'])).toBeTruthy();
    const accepted = screen.getByTestId('board').querySelector(`article[data-escalation-id="${String(breach(3).escalation_id)}"]`) as HTMLElement;
    expect(within(accepted).getByTestId('accept-state').getAttribute('data-state')).toBe('accepted');
    expect(within(accepted).getByText(new RegExp(vi_['iss.board.overdueUnknown.text'].split('{date}')[0] as string))).toBeTruthy();
  });

  it('marks the card of an escalation that waits for its receiver with a stripe (level 3 urgent, level 1-2 needs action), and not an accepted one', async () => {
    open({
      breaches: [
        breach(1, { level: 2 }),
        breach(2, { level: 3, target_unit: null, task_force: TASK_FORCE, accept_due_at: '2020-01-01T00:00:00.000Z' }),
        breach(3, { level: 2, status: 'ACCEPTED', accepted_at: '2026-10-21T02:00:00.000Z' }),
      ],
    });
    await ready();
    const stripeOf = (n: number): string | null => (screen.getByTestId('board').querySelector(`article[data-escalation-id="${String(breach(n).escalation_id)}"]`) as HTMLElement).getAttribute('data-stripe');
    expect(stripeOf(1)).toBe('ACTION');
    expect(stripeOf(2)).toBe('URGENT');
    expect(stripeOf(3)).toBeNull();
    const kpi = within(screen.getByRole('group', { name: t('w2iss.board.kpi.label') }));
    expect(kpi.getByText(vi_['iss.escalation.level3.option']).closest('div')?.textContent).toContain('1');
  });

  it('narrows the board to one level and keeps the counts of the others', async () => {
    open({ breaches: [breach(1, { level: 2 }), breach(2, { level: 3, target_unit: null, task_force: TASK_FORCE }), breach(3, { level: 2 })] });
    await ready();
    const levelSelect = screen.getByLabelText(vi_['iss.board.level.label']) as HTMLSelectElement;
    expect(Array.from(levelSelect.options).map((option) => option.textContent)).toEqual([
      vi_['iss.board.level.all'],
      `${vi_['iss.escalation.level1.option']} (0)`,
      `${vi_['iss.escalation.level2.option']} (2)`,
      `${vi_['iss.escalation.level3.option']} (1)`,
    ]);
    fireEvent.change(levelSelect, { target: { value: '3' } });
    expect(cards()).toEqual([String(breach(2).escalation_id)]);
    expect(screen.getByTestId('count').textContent).toBe(vi_['iss.board.count.text'].replace('{count}', '1'));
  });

  it('AC-ST-ISS-004-2: offers the acceptance only on a line the person may accept, sends it with the note and tells what happened', async () => {
    const h = open({ breaches: [breach(1, { acceptable: true }), breach(2, { acceptable: false })] });
    await ready();
    expect(screen.getAllByRole('button', { name: vi_['iss.board.accept.action'] })).toHaveLength(1);
    fireEvent.change(screen.getByLabelText(vi_['iss.board.accept.note.label']), { target: { value: ' Đã nhận ' } });
    fireEvent.click(screen.getByRole('button', { name: vi_['iss.board.accept.action'] }));
    expect((await screen.findByTestId('done')).textContent).toBe(vi_['iss.board.accept.done']);
    expect(h.command).toHaveBeenCalledWith('acceptIssueEscalation', expect.objectContaining({ path: { id: breach(1).escalation_id }, body: { note: 'Đã nhận' } }));
  });

  it('AC-ST-ISS-004-2: says why the server refused the acceptance, and refuses a note that is too long before it sends anything', async () => {
    const h = open({ breaches: [breach(1, { acceptable: true })] });
    h.command.mockRejectedValueOnce(problem('SCOPE_DENIED', 403)).mockRejectedValueOnce(problem('ESCALATION_STATE_INVALID'));
    await ready();
    fireEvent.change(screen.getByLabelText(vi_['iss.board.accept.note.label']), { target: { value: 'x'.repeat(2001) } });
    fireEvent.click(screen.getByRole('button', { name: vi_['iss.board.accept.action'] }));
    expect(screen.getAllByRole('alert').map((alert) => alert.textContent)).toContain(vi_['iss.field.tooLong.error']);
    expect(h.command).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText(vi_['iss.board.accept.note.label']), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: vi_['iss.board.accept.action'] }));
    await waitFor(() => expect(screen.getByTestId('problem').textContent).toBe(vi_['iss.issueProblem.denied.error']));
    fireEvent.click(screen.getByRole('button', { name: vi_['iss.board.accept.action'] }));
    await waitFor(() => expect(screen.getByTestId('problem').textContent).toBe(vi_['iss.issueProblem.escalationState.error']));
    expect(h.command).toHaveBeenLastCalledWith('acceptIssueEscalation', expect.objectContaining({ body: {} }));
  });

  it('offers no acceptance while the system is read-only, and hides the title of an issue from a guest', async () => {
    open({ breaches: [breach(1, { acceptable: true, issue_title: null })] }, 'READ_ONLY');
    await ready();
    expect(screen.queryByRole('button', { name: vi_['iss.board.accept.action'] })).toBeNull();
    expect(screen.queryByText(/Chậm bàn giao/)).toBeNull();
  });

  it('says when there is no escalation, and when the board cannot be read offers to try again', async () => {
    open({ breaches: [] });
    expect((await screen.findByTestId('empty-board')).textContent).toBe(vi_['iss.board.empty.text']);
    cleanup();
    const state = world({ breaches: [breach(1)], failing: new Set(['listIssueSlaBreaches']) });
    mountIssue(<EscalationBoardScreen route={ROUTE} />, client(state), { permissions: READER, path: '/iss/iss-10' });
    expect(await screen.findByRole('alert')).toBeTruthy();
    state.failing = new Set();
    fireEvent.click(screen.getByRole('button', { name: vi_['states.retry.action'] }));
    await ready();
  });
});
