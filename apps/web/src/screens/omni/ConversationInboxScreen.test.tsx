import { ApiError, NETWORK_ERROR_CODE } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../i18n/vi.json';
import { harness, mount, routeOf } from '../not/delivery/test-support';
import ConversationInboxScreen from './ConversationInboxScreen';
import { describeProblem, mayAssign, queryOf, reasonProblem, toAssignees, toConversation, toConversationPage, windowClosed } from './conversation/model';

const SUPERVISOR = ['conversation.read', 'omni.conversation.assign'];
const AGENT = ['conversation.read'];
const NOBODY = ['notification.self'];
const problem = (code: string, status = 409) => new ApiError({ status, code, correlationId: 'c' });

const conversation = (overrides: Record<string, unknown> = {}) => ({
  id: 'conversation-1',
  channel_account_id: 'account-1',
  channel: 'WHATSAPP',
  account_name: 'WhatsApp hỗ trợ',
  contact_id: 'contact-1',
  contact_name: 'Trần Văn Nam',
  status: 'New',
  priority: 'NORMAL',
  assignee_membership_id: null,
  assignee_name: null,
  queue_unit_id: null,
  queue_unit_name: null,
  last_inbound_at: '2026-10-30T03:00:00Z',
  window_expires_at: '2099-10-31T03:00:00Z',
  sla_first_response_due_at: null,
  sla_resolution_due_at: null,
  message_count: 2,
  assigned_at: null,
  created_at: '2026-10-30T03:00:00Z',
  version: 2,
  ...overrides,
});
const page = (items: unknown[], next: string | null = null) => ({ items, next_cursor: next, as_of: '2026-10-30T03:00:00Z' });
const assignees = (...names: string[]) => ({ items: names.map((name, index) => ({ membership_id: `member-${index + 1}`, display_name: name })), as_of: '2026-10-30T03:00:00Z' });

afterEach(cleanup);

interface Answers {
  list?: (input: unknown) => unknown;
  assignees?: () => unknown;
  command?: (operation: string, input: unknown) => unknown;
  mode?: 'FULL' | 'READ_ONLY';
}

function open(permissions: readonly string[] | undefined, answers: Answers = {}) {
  const h = harness(
    (operation, input) => {
      if (operation === 'get_resources_conversation') return (answers.list ?? (() => page([conversation()])))(input);
      if (operation === 'listConversationAssignees') return (answers.assignees ?? (() => assignees('An', 'Bình')))();
      return new Error(`unexpected read ${operation}`);
    },
    answers.command ?? (() => ({})),
  );
  return { h, ...mount(<ConversationInboxScreen route={routeOf('OMNI-01', 'FR-OMNI-01')} />, h, { permissions, ...(answers.mode === undefined ? {} : { mode: answers.mode }) }) };
}
const row = async (id = 'conversation-1'): Promise<HTMLElement> =>
  (await waitFor(() => {
    const found = document.querySelector(`[data-conversation-id="${id}"]`) as HTMLElement | null;
    if (found === null) throw new Error('not yet');
    return found.closest('tr') as HTMLElement;
  })) as HTMLElement;

describe('OMNI-01 the unified inbox (UI-OMNI-01)', () => {
  it('UI-OMNI-01: shows each conversation with its channel, contact, state, assignee, queue, deadline and window', async () => {
    open(SUPERVISOR, {
      list: () =>
        page([
          conversation(),
          conversation({ id: 'conversation-2', channel: 'EMAIL', account_name: 'Hộp thư', status: 'InProgress', assignee_name: 'An', assignee_membership_id: 'member-1', queue_unit_name: 'Phòng tiếp dân', sla_first_response_due_at: '2026-10-30T09:00:00Z', window_expires_at: null }),
          conversation({ id: 'conversation-3', status: 'Resolved', window_expires_at: '2020-01-01T00:00:00Z' }),
        ]),
    });
    const first = await row();
    expect(first.textContent).toContain('Trần Văn Nam');
    expect(first.textContent).toContain(vi_['omni.inbox.channel.whatsapp']);
    expect(first.querySelector('[data-conversation-status]')?.textContent).toBe(vi_['omni.inbox.status.new']);
    expect(first.querySelector('[data-assignee]')?.textContent).toBe(vi_['omni.inbox.assignee.none']);
    expect(first.querySelector('[data-sla]')?.textContent).toBe(vi_['omni.inbox.sla.none']);
    expect(first.textContent).toContain(vi_['omni.inbox.messages.count'].replace('{count}', '2'));
    // The conversation opens on its own screen, named in the address.
    expect((within(first).getByRole('link', { name: vi_['omni.inbox.open.aria'].replace('{name}', 'Trần Văn Nam') }) as HTMLAnchorElement).getAttribute('href')).toBe('/omni/omni-02?id=conversation-1');
    const second = await row('conversation-2');
    expect(second.querySelector('[data-assignee]')?.textContent).toContain('An');
    expect(second.querySelector('[data-assignee]')?.textContent).toContain('Phòng tiếp dân');
    expect(second.querySelector('[data-window]')?.textContent).toBe(vi_['omni.inbox.window.none']);
    expect(second.querySelector('[data-sla]')?.textContent).not.toBe(vi_['omni.inbox.sla.none']);
    const third = await row('conversation-3');
    expect(third.querySelector('[data-window]')?.textContent).toBe(vi_['omni.inbox.window.closed']);
    // A resolved conversation is not given to anyone any more.
    expect(within(third).queryByRole('button')).toBeNull();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['omni.inbox.page.title']);
  });

  it('shows a loading state, then the denied, signed-out, offline, error and empty states', async () => {
    for (const [error, title] of [
      [new ApiError({ status: 403, code: 'SCOPE_DENIED', correlationId: 'c' }), vi_['states.denied.title']],
      [new ApiError({ status: 401, code: 'SESSION_EXPIRED', correlationId: 'c' }), vi_['states.signedOut.title']],
      [new ApiError({ status: 0, code: NETWORK_ERROR_CODE, correlationId: 'c' }), vi_['states.offline.title']],
      [new ApiError({ status: 500, code: 'INTERNAL_ERROR', correlationId: 'c' }), vi_['states.error.title']],
    ] as const) {
      open(AGENT, { list: () => error });
      expect(await screen.findByText(title)).toBeTruthy();
      cleanup();
    }
    const loading = open(AGENT);
    expect(loading.container.querySelector('[role="status"]')).not.toBeNull();
    cleanup();
    const { h } = open(NOBODY);
    expect(await screen.findByText(vi_['states.denied.title'])).toBeTruthy();
    expect(h.read).not.toHaveBeenCalled();
    cleanup();
    open(AGENT, { list: () => page([]) });
    expect(await screen.findByText(vi_['states.empty.title'])).toBeTruthy();
  });

  it('reads again with the state or the "mine" filter chosen, and sends nothing for a filter that is off', async () => {
    const { h } = open(AGENT);
    await row();
    expect(h.read.mock.calls.at(-1)).toEqual(['get_resources_conversation', { query: {} }]);
    fireEvent.change(screen.getByLabelText(vi_['omni.inbox.filter.status.label']), { target: { value: 'Assigned' } });
    await waitFor(() => expect(h.read.mock.calls.at(-1)).toEqual(['get_resources_conversation', { query: { status: 'Assigned' } }]));
    fireEvent.click(screen.getByLabelText(vi_['omni.inbox.filter.mine.label']));
    await waitFor(() => expect(h.read.mock.calls.at(-1)).toEqual(['get_resources_conversation', { query: { status: 'Assigned', mine: true } }]));
    fireEvent.change(screen.getByLabelText(vi_['omni.inbox.filter.status.label']), { target: { value: '' } });
    await waitFor(() => expect(h.read.mock.calls.at(-1)).toEqual(['get_resources_conversation', { query: { mine: true } }]));
  });

  it('reads the next page with the cursor of the last one', async () => {
    const { h } = open(AGENT, { list: (input) => ((input as { query: { cursor?: string } }).query.cursor === undefined ? page([conversation()], 'next-1') : page([conversation({ id: 'conversation-9', contact_name: 'Hai' })])) });
    await row();
    fireEvent.click(await screen.findByRole('button', { name: vi_['omni.inbox.more.action'] }));
    await row('conversation-9');
    expect(h.read.mock.calls.at(-1)).toEqual(['get_resources_conversation', { query: { cursor: 'next-1' } }]);
    expect(screen.queryByRole('button', { name: vi_['omni.inbox.more.action'] })).toBeNull();
  });

  it('UI-OMNI-01: gives a conversation to a member of the list read for it, with the version it read and an optional reason, and says it was done', async () => {
    const { h } = open(SUPERVISOR, { command: () => ({ operation_id: 'o', status: 'ASSIGNED', resource_version: 3, resource_id: 'conversation-1' }) });
    const first = await row();
    fireEvent.click(within(first).getByRole('button', { name: vi_['omni.inbox.assign.aria'].replace('{name}', 'Trần Văn Nam') }));
    const form = (await screen.findByRole('form', { name: vi_['omni.inbox.assign.form.aria'].replace('{name}', 'Trần Văn Nam') })) as HTMLElement;
    await waitFor(() => expect((within(form).getByLabelText(vi_['omni.inbox.assign.member.label']) as HTMLSelectElement).options.length).toBe(3));
    expect(h.read.mock.calls.find((call) => call[0] === 'listConversationAssignees')).toEqual(['listConversationAssignees', { path: { conversationId: 'conversation-1' } }]);
    // Nothing is sent before a member is chosen.
    fireEvent.click(within(form).getByRole('button', { name: vi_['omni.inbox.assign.confirm.action'] }));
    expect(within(form).getByText(vi_['omni.inbox.assign.member.invalid'])).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
    fireEvent.change(within(form).getByLabelText(vi_['omni.inbox.assign.member.label']), { target: { value: 'member-2' } });
    fireEvent.change(within(form).getByLabelText(vi_['omni.inbox.assign.reason.label']), { target: { value: '  Cùng đơn vị  ' } });
    fireEvent.click(within(form).getByRole('button', { name: vi_['omni.inbox.assign.confirm.action'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(h.command.mock.calls[0]).toEqual(['assignConversation', expect.objectContaining({ path: { conversationId: 'conversation-1' }, body: { assignee_membership_id: 'member-2', reason: 'Cùng đơn vị' }, ifMatchVersion: 2 })]);
    expect(await screen.findByText(vi_['omni.inbox.assign.done'])).toBeTruthy();
    expect(document.querySelector('[data-assign-form]')).toBeNull();
  });

  it('sends no reason when none is typed, refuses one over 500 characters, and can be cancelled', async () => {
    const { h } = open(SUPERVISOR, { command: () => ({}) });
    const first = await row();
    fireEvent.click(within(first).getByRole('button', { name: new RegExp(vi_['omni.inbox.assign.action']) }));
    const form = (await screen.findByRole('form')) as HTMLElement;
    await waitFor(() => expect((within(form).getByLabelText(vi_['omni.inbox.assign.member.label']) as HTMLSelectElement).options.length).toBe(3));
    fireEvent.change(within(form).getByLabelText(vi_['omni.inbox.assign.member.label']), { target: { value: 'member-1' } });
    fireEvent.change(within(form).getByLabelText(vi_['omni.inbox.assign.reason.label']), { target: { value: 'r'.repeat(501) } });
    fireEvent.click(within(form).getByRole('button', { name: vi_['omni.inbox.assign.confirm.action'] }));
    expect(within(form).getByText(vi_['omni.inbox.assign.reason.invalid'].replace('{max}', '500'))).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
    fireEvent.change(within(form).getByLabelText(vi_['omni.inbox.assign.reason.label']), { target: { value: '' } });
    fireEvent.click(within(form).getByRole('button', { name: vi_['omni.inbox.assign.confirm.action'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(h.command.mock.calls[0]?.[1]).toMatchObject({ body: { assignee_membership_id: 'member-1' } });
    expect((h.command.mock.calls[0]?.[1] as { body: Record<string, unknown> }).body).not.toHaveProperty('reason');
    cleanup();
    open(SUPERVISOR);
    fireEvent.click(within(await row()).getByRole('button', { name: new RegExp(vi_['omni.inbox.assign.action']) }));
    fireEvent.click(await screen.findByRole('button', { name: vi_['omni.inbox.assign.cancel.action'] }));
    expect(document.querySelector('[data-assign-form]')).toBeNull();
  });

  it('says in words why the assignment was refused: not eligible, state, conflict, denied, gone', async () => {
    for (const [code, key] of [
      ['ASSIGNEE_NOT_ELIGIBLE', 'omni.inbox.problem.notEligible'],
      ['CONVERSATION_STATE_INVALID', 'omni.inbox.problem.state'],
      ['VERSION_CONFLICT', 'omni.inbox.problem.conflict'],
      ['SCOPE_DENIED', 'omni.inbox.problem.denied'],
      ['RESOURCE_NOT_FOUND', 'omni.inbox.problem.notFound'],
      ['SESSION_EXPIRED', 'omni.inbox.problem.session'],
      ['VALIDATION_FAILED', 'omni.inbox.problem.invalid'],
      ['INTERNAL_ERROR', 'omni.inbox.problem.general'],
    ] as const) {
      open(SUPERVISOR, { command: () => problem(code) });
      fireEvent.click(within(await row()).getByRole('button', { name: new RegExp(vi_['omni.inbox.assign.action']) }));
      const form = (await screen.findByRole('form')) as HTMLElement;
      await waitFor(() => expect((within(form).getByLabelText(vi_['omni.inbox.assign.member.label']) as HTMLSelectElement).options.length).toBe(3));
      fireEvent.change(within(form).getByLabelText(vi_['omni.inbox.assign.member.label']), { target: { value: 'member-1' } });
      fireEvent.click(within(form).getByRole('button', { name: vi_['omni.inbox.assign.confirm.action'] }));
      expect(await screen.findByText(vi_[key])).toBeTruthy();
      cleanup();
    }
  });

  it('keeps the form, its error and what was typed when the list is read again with a newer version, and sends the newer version on the next try', async () => {
    let reads = 0;
    const { h } = open(SUPERVISOR, { list: () => page([conversation({ version: ++reads === 1 ? 2 : 3 })]), command: () => problem('VERSION_CONFLICT') });
    fireEvent.click(within(await row()).getByRole('button', { name: new RegExp(vi_['omni.inbox.assign.action']) }));
    const form = (await screen.findByRole('form')) as HTMLElement;
    await waitFor(() => expect((within(form).getByLabelText(vi_['omni.inbox.assign.member.label']) as HTMLSelectElement).options.length).toBe(3));
    fireEvent.change(within(form).getByLabelText(vi_['omni.inbox.assign.member.label']), { target: { value: 'member-1' } });
    fireEvent.change(within(form).getByLabelText(vi_['omni.inbox.assign.reason.label']), { target: { value: 'Typed once' } });
    fireEvent.click(within(form).getByRole('button', { name: vi_['omni.inbox.assign.confirm.action'] }));
    expect(await screen.findByText(vi_['omni.inbox.problem.conflict'])).toBeTruthy();
    await waitFor(() => expect(reads).toBeGreaterThan(1));
    expect(document.querySelector('[data-assign-form]')).toBe(form);
    expect((within(form).getByLabelText(vi_['omni.inbox.assign.reason.label']) as HTMLTextAreaElement).value).toBe('Typed once');
    fireEvent.click(within(form).getByRole('button', { name: vi_['omni.inbox.assign.confirm.action'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(2));
    expect(h.command.mock.calls[1]?.[1]).toMatchObject({ ifMatchVersion: 3 });
  });

  it('tells when the list of members could not be read, or is empty', async () => {
    open(SUPERVISOR, { assignees: () => problem('INTERNAL_ERROR', 500) });
    fireEvent.click(within(await row()).getByRole('button', { name: new RegExp(vi_['omni.inbox.assign.action']) }));
    expect(await screen.findByText(vi_['omni.inbox.assign.assignees.failed'])).toBeTruthy();
    cleanup();
    open(SUPERVISOR, { assignees: () => assignees() });
    fireEvent.click(within(await row()).getByRole('button', { name: new RegExp(vi_['omni.inbox.assign.action']) }));
    expect(await screen.findByText(vi_['omni.inbox.assign.assignees.none'])).toBeTruthy();
  });

  it('offers no assignment to one who may not assign, and none in a suspended tenant', async () => {
    open(AGENT);
    expect(within(await row()).queryByRole('button')).toBeNull();
    cleanup();
    open(SUPERVISOR, { mode: 'READ_ONLY' });
    expect(within(await row()).queryByRole('button')).toBeNull();
  });

  describe('the rules of the model', () => {
    it('reads a conversation, and nothing from a record that is not one', () => {
      expect(toConversation(conversation({ assignee_name: 'An', assignee_membership_id: 'member-1', queue_unit_name: 'Phòng A', sla_first_response_due_at: '2026-10-30T09:00:00Z' }))).toEqual({
        id: 'conversation-1',
        channelAccountId: 'account-1',
        channel: 'WHATSAPP',
        accountName: 'WhatsApp hỗ trợ',
        contactName: 'Trần Văn Nam',
        status: 'New',
        assigneeName: 'An',
        assigneeId: 'member-1',
        queueUnitName: 'Phòng A',
        lastInboundAt: '2026-10-30T03:00:00Z',
        windowExpiresAt: '2099-10-31T03:00:00Z',
        firstResponseDueAt: '2026-10-30T09:00:00Z',
        messageCount: 2,
        version: 2,
      });
      expect(toConversation(null)).toBeUndefined();
      expect(toConversation({ id: 3 })).toBeUndefined();
      expect(toConversation({ id: 'x', status: 'Weird' })).toBeUndefined();
      expect(toConversation({ id: 'x', status: 'New' })).toMatchObject({ channel: '', channelAccountId: '', messageCount: 0, version: 0 });
      expect(toConversationPage(page([conversation(), { id: 'bad' }], 'n'))).toMatchObject({ items: [{ id: 'conversation-1' }], nextCursor: 'n' });
      expect(toConversationPage(undefined)).toEqual({ items: [], nextCursor: undefined });
      expect(toAssignees(assignees('An'))).toEqual([{ membershipId: 'member-1', displayName: 'An' }]);
      expect(toAssignees({ items: [{ membership_id: 5 }, null] })).toEqual([]);
      expect(toAssignees(null)).toEqual([]);
    });

    it('assigns while the conversation is open, tells a window that is over, builds the query and judges the reason', () => {
      expect(['New', 'Assigned', 'InProgress', 'PendingCustomer', 'Resolved', 'Closed'].map((status) => mayAssign({ status: status as never }))).toEqual([true, true, true, true, false, false]);
      const now = new Date('2026-10-30T10:00:00Z');
      expect(windowClosed({ windowExpiresAt: '2026-10-30T09:59:59Z' }, now)).toBe(true);
      expect(windowClosed({ windowExpiresAt: '2026-10-30T10:00:01Z' }, now)).toBe(false);
      expect(windowClosed({ windowExpiresAt: undefined }, now)).toBe(false);
      expect(queryOf({ status: '', mine: false }, undefined)).toEqual({});
      expect(queryOf({ status: 'New', mine: true }, 'c')).toEqual({ status: 'New', mine: true, cursor: 'c' });
      expect(reasonProblem('r'.repeat(500))).toBe(false);
      expect(reasonProblem(`  ${'r'.repeat(501)}  `)).toBe(true);
      expect(describeProblem(problem('ASSIGNEE_NOT_ELIGIBLE', 422))).toEqual({ reason: 'notEligible' });
      expect(describeProblem(new Error('x'))).toEqual({ reason: 'general' });
      expect(describeProblem(problem('SOMETHING_NEW'))).toEqual({ reason: 'general' });
    });
  });

  it('tells the state of a conversation on a pill with its words, counts the filters that apply on the filter panel and keeps the first column pinned', async () => {
    open(SUPERVISOR, { list: () => page([conversation(), conversation({ id: 'conversation-2', status: 'InProgress', assignee_name: 'An', assignee_membership_id: 'member-1' })]) });
    const first = await row();
    expect(within(first).getByText(vi_['omni.inbox.status.new']).closest('.ui-pill')?.className).toContain('ui-tone-info');
    expect(within(await row('conversation-2')).getByText(vi_['omni.inbox.status.inProgress']).closest('.ui-pill')?.className).toContain('ui-tone-success');
    expect(first.querySelector('td')?.className).toContain('ui-table__cell--pinned');
    expect(screen.getByRole('button', { name: vi_['ui.filterPanel.toggle'] })).toBeTruthy();
    fireEvent.change(document.getElementById('inbox-status') as HTMLElement, { target: { value: 'New' } });
    await waitFor(() => expect(screen.getByRole('button', { name: vi_['ui.filterPanel.toggleApplied'].replace('{count}', '1') })).toBeTruthy());
  });
});
