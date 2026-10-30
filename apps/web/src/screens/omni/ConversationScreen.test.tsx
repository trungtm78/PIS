import { ApiError, NETWORK_ERROR_CODE } from '@machvon/api-client';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../i18n/vi.json';
import { harness, mount, routeOf } from '../not/delivery/test-support';
import ConversationScreen from './ConversationScreen';
import { THREAD_REFRESH_MS } from './thread/hooks';
import {
  countdownOf,
  describeProblem,
  emptyDraft,
  mayNote,
  mayReopen,
  mayReply,
  mayResolve,
  reasonProblem,
  revokesAccess,
  sendBody,
  shownError,
  textProblem,
  toMessage,
  toMessageText,
  toMessages,
} from './thread/model';

const AGENT = ['conversation.read', 'channel_message.read', 'omni.conversation.reply'];
const READER = ['conversation.read', 'channel_message.read'];
const NOBODY = ['notification.self'];
const reason = 'The question of the person was answered in full.';
const problem = (code: string, status = 422) => new ApiError({ status, code, correlationId: 'c' });

const conversation = (overrides: Record<string, unknown> = {}) => ({
  id: 'conversation-1',
  channel_account_id: 'account-1',
  channel: 'WHATSAPP',
  account_name: 'WhatsApp hỗ trợ',
  contact_id: 'contact-1',
  contact_name: 'Trần Văn Nam',
  status: 'InProgress',
  priority: 'NORMAL',
  assignee_membership_id: 'member-1',
  assignee_name: 'An',
  queue_unit_id: null,
  queue_unit_name: null,
  last_inbound_at: '2026-10-30T03:00:00Z',
  window_expires_at: null,
  sla_first_response_due_at: null,
  sla_resolution_due_at: null,
  message_count: 3,
  assigned_at: null,
  created_at: '2026-10-30T03:00:00Z',
  version: 4,
  ...overrides,
});
const message = (overrides: Record<string, unknown> = {}) => ({ id: 'message-1', conversation_id: 'conversation-1', direction: 'INBOUND', kind: 'TEXT', delivery_status: null, author_membership_id: null, classification: 'PERSONAL', text: null, created_at: '2026-10-30T03:00:00Z', ...overrides });
const messages = () => [
  message(),
  message({ id: 'message-2', direction: 'OUTBOUND', delivery_status: 'Delivered', author_membership_id: 'member-1', created_at: '2026-10-30T03:05:00Z' }),
  message({ id: 'message-3', direction: 'INTERNAL_NOTE', author_membership_id: 'member-1', created_at: '2026-10-30T03:06:00Z' }),
  message({ id: 'message-4', direction: 'OUTBOUND', delivery_status: 'Failed', author_membership_id: 'member-1', created_at: '2026-10-30T03:07:00Z' }),
];

afterEach(cleanup);

interface Answers {
  conversation?: () => unknown;
  messages?: () => unknown;
  text?: (id: string) => unknown;
  command?: (operation: string, input: unknown) => unknown;
  mode?: 'READ_ONLY';
  entry?: string;
}

function open(permissions: readonly string[] | undefined, answers: Answers = {}) {
  const respond = (value: unknown) => (value instanceof Error ? Promise.reject(value) : Promise.resolve(value));
  const h = harness((operation, input) => {
    if (operation === 'get_resources_conversation_id') return (answers.conversation ?? (() => conversation()))();
    if (operation === 'get_resources_channel_message_id') return (answers.text ?? ((id: string) => message({ id, text: `Nội dung của ${id}` })))((input as { path: { id: string } }).path.id);
    return new Error(`unexpected read ${operation}`);
  }, answers.command ?? (() => ({})));
  (h.client as unknown as { readAll: unknown }).readAll = vi.fn((operation: string) => (operation === 'get_resources_channel_message' ? respond((answers.messages ?? messages)()) : respond(new Error(`unexpected readAll ${operation}`))));
  return { h, ...mount(<ConversationScreen route={routeOf('OMNI-02', 'FR-OMNI-02')} />, h, { permissions, ...(answers.mode === undefined ? {} : { mode: answers.mode }), entry: answers.entry ?? '/omni/omni-02?id=conversation-1' }) };
}
const row = async (id: string): Promise<HTMLElement> =>
  (await waitFor(() => {
    const found = document.querySelector(`[data-message-id="${id}"]`) as HTMLElement | null;
    if (found === null) throw new Error('not yet');
    return found;
  })) as HTMLElement;
const composer = async (): Promise<HTMLElement> =>
  (await waitFor(() => {
    const found = document.querySelector('[data-composer]') as HTMLElement | null;
    if (found === null) throw new Error('not yet');
    return found;
  })) as HTMLElement;

describe('OMNI-02 the conversation (UI-OMNI-02)', () => {
  it('shows the contact, the channel, the state, the assignee and the messages oldest first with where each stands, and the text only when asked', async () => {
    const { h } = open(AGENT);
    expect(await screen.findByRole('heading', { level: 2, name: 'Trần Văn Nam' })).toBeTruthy();
    const header = document.querySelector('[data-conversation-header]') as HTMLElement;
    expect(header.textContent).toContain(vi_['omni.inbox.channel.whatsapp']);
    expect(header.textContent).toContain('WhatsApp hỗ trợ');
    expect(header.querySelector('[data-conversation-status]')?.textContent).toBe(vi_['omni.inbox.status.inProgress']);
    expect(header.querySelector('[data-assignee]')?.textContent).toContain('An');
    const list = await screen.findByRole('list', { name: vi_['omni.thread.messages.aria'] });
    expect([...list.querySelectorAll('li')].map((item) => item.getAttribute('data-message-id'))).toEqual(['message-1', 'message-2', 'message-3', 'message-4']);
    expect((await row('message-2')).querySelector('[data-delivery]')?.textContent).toBe(vi_['omni.thread.delivery.delivered']);
    expect((await row('message-4')).querySelector('[data-delivery]')?.textContent).toBe(vi_['omni.thread.delivery.failed']);
    expect((await row('message-3')).textContent).toContain(vi_['omni.thread.direction.note']);
    // The list carries no text, and none is read until it is asked for.
    expect(document.querySelector('[data-text]')).toBeNull();
    expect(h.read.mock.calls.some((call) => call[0] === 'get_resources_channel_message_id')).toBe(false);
    fireEvent.click(within(await row('message-1')).getByRole('button', { name: vi_['omni.thread.text.show.action'] }));
    expect(await screen.findByText('Nội dung của message-1')).toBeTruthy();
    expect(h.read.mock.calls.find((call) => call[0] === 'get_resources_channel_message_id')).toEqual(['get_resources_channel_message_id', { path: { id: 'message-1' } }]);
    expect((h.client.readAll as unknown as ReturnType<typeof vi.fn>).mock.calls[0]).toEqual(['get_resources_channel_message', { query: { conversation_id: 'conversation-1' } }]);
    expect(h.read.mock.calls.find((call) => call[0] === 'get_resources_conversation_id')).toEqual(['get_resources_conversation_id', { path: { id: 'conversation-1' } }]);
  });

  it('tells in words when the text of a message could not be loaded', async () => {
    open(AGENT, { text: () => problem('INTERNAL_ERROR', 500) });
    fireEvent.click(within(await row('message-1')).getByRole('button', { name: vi_['omni.thread.text.show.action'] }));
    expect(await screen.findByText(vi_['omni.thread.text.failed'])).toBeTruthy();
  });

  it('AC-ST-OMNI-005-6 UI-OMNI-02: shows the countdown of the window, and says when it is closed, and the notice about the citizen\'s petitions', async () => {
    const soon = new Date(Date.now() + (3 * 60 + 25) * 60_000 + 30_000).toISOString();
    open(AGENT, { conversation: () => conversation({ window_expires_at: soon }) });
    const header = (await screen.findByRole('heading', { level: 2, name: 'Trần Văn Nam' })).parentElement as HTMLElement;
    expect(header.querySelector('[data-window]')?.textContent).toContain(vi_['omni.thread.window.left'].replace('{hours}', '3').replace('{minutes}', '25'));
    expect(document.querySelector('[data-petition-notice]')?.textContent).toBe(vi_['omni.thread.petition.notice']);
    cleanup();
    open(AGENT, { conversation: () => conversation({ window_expires_at: '2020-01-01T00:00:00Z' }) });
    expect((await screen.findByText(vi_['omni.thread.window.closed']))?.closest('[data-window]')?.className).toContain('closed');
    cleanup();
    open(AGENT);
    expect((await screen.findByText(vi_['omni.inbox.window.none']))?.closest('[data-window]')).not.toBeNull();
  });

  it('AC-ST-OMNI-005-6 UI-OMNI-02: the switch of the internal note changes how the form looks and what it says, and what it sends has no purpose', async () => {
    const { h } = open(AGENT, { command: () => ({ operation_id: 'o', status: 'RECORDED', resource_version: 4, resource_id: 'message-9' }) });
    let form = await composer();
    expect(form.getAttribute('data-mode')).toBe('message');
    expect(form.className).not.toContain('note-mode');
    expect(within(form).getByText(vi_['omni.thread.composer.send.hint'].replace('{channel}', vi_['omni.inbox.channel.whatsapp']))).toBeTruthy();
    const toggle = within(form).getByRole('switch', { name: vi_['omni.thread.composer.note.switch'] }) as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    fireEvent.click(toggle);
    form = await composer();
    expect(form.getAttribute('data-mode')).toBe('note');
    expect(form.className).toContain('note-mode');
    expect(within(form).getByText(vi_['omni.thread.composer.note.hint'])).toBeTruthy();
    expect(within(form).queryByLabelText(vi_['omni.thread.composer.purpose.label'])).toBeNull();
    expect(screen.getByRole('form', { name: vi_['omni.thread.composer.note.aria'] })).toBeTruthy();
    fireEvent.change(within(form).getByLabelText(vi_['omni.thread.composer.text.label']), { target: { value: '  Gọi lại sau 3 giờ  ' } });
    fireEvent.click(within(form).getByRole('button', { name: vi_['omni.thread.composer.note.action'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(h.command.mock.calls[0]).toEqual(['sendConversationMessage', expect.objectContaining({ path: { conversationId: 'conversation-1' }, body: { kind: 'INTERNAL_NOTE', channel_account_id: 'account-1', text: 'Gọi lại sau 3 giờ' }, ifMatchVersion: 4 })]);
    expect(await screen.findByText(vi_['omni.thread.note.done'])).toBeTruthy();
    expect((within(await composer()).getByLabelText(vi_['omni.thread.composer.text.label']) as HTMLTextAreaElement).value).toBe('');
  });

  it('sends a message to the person with the purpose chosen, at the version read, asking for a text before anything is sent', async () => {
    const { h } = open(AGENT, { command: () => ({ operation_id: 'o', status: 'QUEUED', resource_version: 4, resource_id: 'message-9' }) });
    const form = await composer();
    fireEvent.click(within(form).getByRole('button', { name: vi_['omni.thread.composer.send.action'] }));
    expect(within(form).getByText(vi_['omni.thread.composer.text.invalid'].replace('{max}', '4000'))).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
    fireEvent.change(within(form).getByLabelText(vi_['omni.thread.composer.purpose.label']), { target: { value: 'REMINDER' } });
    fireEvent.change(within(form).getByLabelText(vi_['omni.thread.composer.text.label']), { target: { value: 'Nhắc: hạn bổ sung hồ sơ là ngày 5.' } });
    fireEvent.click(within(form).getByRole('button', { name: vi_['omni.thread.composer.send.action'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(h.command.mock.calls[0]).toEqual(['sendConversationMessage', expect.objectContaining({ body: { kind: 'EXTERNAL', channel_account_id: 'account-1', purpose: 'REMINDER', text: 'Nhắc: hạn bổ sung hồ sơ là ngày 5.' }, ifMatchVersion: 4 })]);
    expect(await screen.findByText(vi_['omni.thread.send.done'])).toBeTruthy();
  });

  it('says in words why the server refused the message: consent, opt-in, window, account, account state, confidential file, template, state, contact, conflict, denied', async () => {
    for (const [code, key] of [
      ['CONSENT_DENIED', 'omni.thread.problem.consent'],
      ['OPT_IN_REQUIRED', 'omni.thread.problem.optIn'],
      ['CHANNEL_WINDOW_CLOSED', 'omni.thread.problem.window'],
      ['CHANNEL_ACCOUNT_MISMATCH', 'omni.thread.problem.account'],
      ['CHANNEL_UNVERIFIED', 'omni.thread.problem.unverified'],
      ['CONTENT_CLASSIFICATION_BLOCKED', 'omni.thread.problem.content'],
      ['TEMPLATE_INVALID', 'omni.thread.problem.template'],
      ['CONVERSATION_STATE_INVALID', 'omni.thread.problem.state'],
      ['CONTACT_STATE_INVALID', 'omni.thread.problem.contact'],
      ['VERSION_CONFLICT', 'omni.thread.problem.conflict'],
      ['SCOPE_DENIED', 'omni.thread.problem.denied'],
      ['RESOURCE_NOT_FOUND', 'omni.thread.problem.notFound'],
      ['SESSION_EXPIRED', 'omni.thread.problem.session'],
      ['VALIDATION_FAILED', 'omni.thread.problem.invalid'],
      ['INTERNAL_ERROR', 'omni.thread.problem.general'],
    ] as const) {
      open(AGENT, { command: () => problem(code) });
      const form = await composer();
      fireEvent.change(within(form).getByLabelText(vi_['omni.thread.composer.text.label']), { target: { value: 'Xin chào' } });
      fireEvent.click(within(form).getByRole('button', { name: vi_['omni.thread.composer.send.action'] }));
      expect(await screen.findByText(vi_[key])).toBeTruthy();
      // What was typed stays for another try.
      expect((within(await composer()).getByLabelText(vi_['omni.thread.composer.text.label']) as HTMLTextAreaElement).value).toBe('Xin chào');
      cleanup();
    }
  });

  it('keeps what the agent began to write while the message was going, and clears only the words that were sent', async () => {
    let finish: (value: unknown) => void = () => undefined;
    const pending = new Promise((resolve) => {
      finish = resolve;
    });
    const { h } = open(AGENT, { command: () => pending });
    const form = await composer();
    const text = () => within(document.querySelector('[data-composer]') as HTMLElement).getByLabelText(vi_['omni.thread.composer.text.label']) as HTMLTextAreaElement;
    fireEvent.change(text(), { target: { value: 'Tin thứ nhất' } });
    fireEvent.click(within(form).getByRole('button', { name: vi_['omni.thread.composer.send.action'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    fireEvent.change(text(), { target: { value: 'Tin thứ hai, viết dở' } });
    finish({ operation_id: 'o', status: 'QUEUED', resource_version: 4, resource_id: 'message-9' });
    expect(await screen.findByText(vi_['omni.thread.send.done'])).toBeTruthy();
    expect(text().value).toBe('Tin thứ hai, viết dở');
  });

  it('keeps the composer and what was typed when a refresh of the thread fails, and shows the error only when there is nothing to show', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      let reads = 0;
      open(AGENT, { conversation: () => (++reads === 1 ? conversation() : new ApiError({ status: 0, code: NETWORK_ERROR_CODE, correlationId: 'c' })) });
      const form = await composer();
      fireEvent.change(within(form).getByLabelText(vi_['omni.thread.composer.text.label']), { target: { value: 'Tin đang viết' } });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(THREAD_REFRESH_MS + 100);
      });
      expect(reads).toBeGreaterThan(1);
      expect(document.querySelector('[data-composer]')).toBe(form);
      expect((within(form).getByLabelText(vi_['omni.thread.composer.text.label']) as HTMLTextAreaElement).value).toBe('Tin đang viết');
      expect(screen.queryByText(vi_['states.offline.title'])).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('takes the thread away when the thread is read again and the conversation is out of the scope of the agent now: a refusal is not a break in the network', async () => {
    let reads = 0;
    open(AGENT, {
      conversation: () => (++reads === 1 ? conversation() : new ApiError({ status: 404, code: 'RESOURCE_NOT_FOUND', correlationId: 'c' })),
      command: () => problem('INTERNAL_ERROR', 500),
    });
    const form = await composer();
    fireEvent.change(within(form).getByLabelText(vi_['omni.thread.composer.text.label']), { target: { value: 'Xin chào' } });
    fireEvent.click(within(form).getByRole('button', { name: vi_['omni.thread.composer.send.action'] }));
    // The command failed and the thread was read again: the conversation is gone from the scope, so what was loaded is not shown any more.
    expect(await screen.findByText(vi_['states.error.title'])).toBeTruthy();
    expect(document.querySelector('[data-composer]')).toBeNull();
    expect(document.querySelector('[data-conversation-header]')).toBeNull();
  });

  it('reads the thread again by itself, so what is sent, delivered or answered after the command shows without a click', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      let reads = 0;
      const { h } = open(AGENT, { conversation: () => conversation({ message_count: ++reads }) });
      await screen.findByRole('heading', { level: 2, name: 'Trần Văn Nam' });
      const readAll = h.client.readAll as unknown as ReturnType<typeof vi.fn>;
      const before = readAll.mock.calls.length;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(THREAD_REFRESH_MS + 100);
      });
      expect(readAll.mock.calls.length).toBeGreaterThan(before);
      expect(reads).toBeGreaterThan(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries a message whose answer was lost with the same key and the version it was first sent at, though the thread was read again at a newer one', async () => {
    let reads = 0;
    let calls = 0;
    const { h } = open(AGENT, {
      conversation: () => conversation({ status: 'Assigned', version: ++reads === 1 ? 4 : 5 }),
      command: () => {
        calls += 1;
        return calls === 1 ? new ApiError({ status: 0, code: NETWORK_ERROR_CODE, correlationId: 'c' }) : { operation_id: 'o', status: 'QUEUED', resource_version: 5, resource_id: 'message-9' };
      },
    });
    const form = await composer();
    fireEvent.change(within(form).getByLabelText(vi_['omni.thread.composer.text.label']), { target: { value: 'Xin chào' } });
    fireEvent.click(within(form).getByRole('button', { name: vi_['omni.thread.composer.send.action'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    // The answer was lost; the thread is read again and the conversation is now at version 5.
    await waitFor(() => expect(reads).toBeGreaterThan(1));
    fireEvent.click(within(await composer()).getByRole('button', { name: vi_['omni.thread.composer.send.action'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(2));
    const [first, second] = h.command.mock.calls.map((call) => call[1] as { ifMatchVersion: number; attempt: { key: string } });
    expect(first?.ifMatchVersion).toBe(4);
    expect(second?.ifMatchVersion).toBe(4);
    expect(second?.attempt.key).toBe(first?.attempt.key);
    // Once it is done, another message is a new intention at the version of the moment.
    expect(await screen.findByText(vi_['omni.thread.send.done'])).toBeTruthy();
    fireEvent.change(within(await composer()).getByLabelText(vi_['omni.thread.composer.text.label']), { target: { value: 'Một tin khác' } });
    fireEvent.click(within(await composer()).getByRole('button', { name: vi_['omni.thread.composer.send.action'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(3));
    const third = h.command.mock.calls[2]?.[1] as { ifMatchVersion: number; attempt: { key: string } };
    expect(third.ifMatchVersion).toBe(5);
    expect(third.attempt.key).not.toBe(first?.attempt.key);
  });

  it('starts a new intention after a final refusal, at the version of the moment', async () => {
    let reads = 0;
    let calls = 0;
    const { h } = open(AGENT, {
      conversation: () => conversation({ status: 'Assigned', version: ++reads === 1 ? 4 : 6 }),
      command: () => ((calls += 1) === 1 ? problem('VERSION_CONFLICT', 409) : { operation_id: 'o', status: 'QUEUED', resource_version: 7, resource_id: 'message-9' }),
    });
    const form = await composer();
    fireEvent.change(within(form).getByLabelText(vi_['omni.thread.composer.text.label']), { target: { value: 'Xin chào' } });
    fireEvent.click(within(form).getByRole('button', { name: vi_['omni.thread.composer.send.action'] }));
    expect(await screen.findByText(vi_['omni.thread.problem.conflict'])).toBeTruthy();
    await waitFor(() => expect(reads).toBeGreaterThan(1));
    fireEvent.click(within(await composer()).getByRole('button', { name: vi_['omni.thread.composer.send.action'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(2));
    const [first, second] = h.command.mock.calls.map((call) => call[1] as { ifMatchVersion: number; attempt: { key: string } });
    expect(second?.ifMatchVersion).toBe(6);
    expect(second?.attempt.key).not.toBe(first?.attempt.key);
  });

  it('takes notes only while nobody has taken the conversation up or it is resolved, and nothing once it is closed', async () => {
    for (const status of ['New', 'Resolved']) {
      open(AGENT, { conversation: () => conversation({ status }) });
      const form = await composer();
      expect(form.getAttribute('data-mode')).toBe('note');
      expect((within(form).getByRole('switch') as HTMLInputElement).disabled).toBe(true);
      cleanup();
    }
    open(AGENT, { conversation: () => conversation({ status: 'Closed' }) });
    expect(await screen.findByText(vi_['omni.thread.composer.closed'])).toBeTruthy();
    expect(document.querySelector('[data-composer]')).toBeNull();
  });

  it('resolves a conversation that is under way with a reason, at the version read, and asks for the reason before it sends anything', async () => {
    const { h } = open(AGENT, { command: () => ({ operation_id: 'o', status: 'RESOLVED', resource_version: 5, resource_id: 'conversation-1' }) });
    fireEvent.click(await screen.findByRole('button', { name: vi_['omni.thread.resolve.action'] }));
    const form = (await screen.findByRole('form', { name: vi_['omni.thread.move.form.aria'].replace('{action}', vi_['omni.thread.resolve.action']) })) as HTMLElement;
    fireEvent.click(within(form).getByRole('button', { name: vi_['omni.thread.move.confirm.action'].replace('{action}', vi_['omni.thread.resolve.action']) }));
    expect(within(form).getByText(vi_['omni.thread.move.reason.invalid'])).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
    fireEvent.change(within(form).getByLabelText(vi_['omni.thread.move.reason.label']), { target: { value: `  ${reason}  ` } });
    fireEvent.click(within(form).getByRole('button', { name: vi_['omni.thread.move.confirm.action'].replace('{action}', vi_['omni.thread.resolve.action']) }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(h.command.mock.calls[0]).toEqual(['resolveConversation', expect.objectContaining({ path: { conversationId: 'conversation-1' }, body: { reason }, ifMatchVersion: 4 })]);
    expect(await screen.findByText(vi_['omni.thread.resolve.done'])).toBeTruthy();
  });

  it('closes the form of the action when a refresh changes what can be done, so the reason typed for a resolve is never confirmed as a reopening', async () => {
    let reads = 0;
    const { h } = open(AGENT, {
      conversation: () => conversation({ status: ++reads === 1 ? 'InProgress' : 'Resolved', version: reads === 1 ? 4 : 5 }),
      command: () => new ApiError({ status: 0, code: NETWORK_ERROR_CODE, correlationId: 'c' }),
    });
    fireEvent.click(await screen.findByRole('button', { name: vi_['omni.thread.resolve.action'] }));
    const form = (await screen.findByRole('form', { name: vi_['omni.thread.move.form.aria'].replace('{action}', vi_['omni.thread.resolve.action']) })) as HTMLElement;
    fireEvent.change(within(form).getByLabelText(vi_['omni.thread.move.reason.label']), { target: { value: reason } });
    fireEvent.click(within(form).getByRole('button', { name: vi_['omni.thread.move.confirm.action'].replace('{action}', vi_['omni.thread.resolve.action']) }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    // The answer was lost, the thread was read again and the conversation is resolved: what can be done now is to reopen it, and nothing is pending for that.
    expect(await screen.findByRole('button', { name: vi_['omni.thread.reopen.action'] })).toBeTruthy();
    expect(document.querySelector('[data-move-form]')).toBeNull();
    expect(h.command).toHaveBeenCalledTimes(1);
  });

  it('reopens a resolved conversation, and says in words that it changed meanwhile', async () => {
    const { h } = open(AGENT, { conversation: () => conversation({ status: 'Resolved' }), command: () => problem('VERSION_CONFLICT', 409) });
    expect(screen.queryByRole('button', { name: vi_['omni.thread.resolve.action'] })).toBeNull();
    fireEvent.click(await screen.findByRole('button', { name: vi_['omni.thread.reopen.action'] }));
    const form = (await screen.findByRole('form', { name: vi_['omni.thread.move.form.aria'].replace('{action}', vi_['omni.thread.reopen.action']) })) as HTMLElement;
    fireEvent.change(within(form).getByLabelText(vi_['omni.thread.move.reason.label']), { target: { value: reason } });
    fireEvent.click(within(form).getByRole('button', { name: vi_['omni.thread.move.confirm.action'].replace('{action}', vi_['omni.thread.reopen.action']) }));
    expect(await screen.findByText(vi_['omni.thread.problem.conflict'])).toBeTruthy();
    expect(h.command.mock.calls[0]?.[0]).toBe('reopenConversation');
  });

  it('offers nothing to resolve or reopen on a conversation nobody took up or that is closed', async () => {
    for (const status of ['New', 'Assigned', 'Closed']) {
      open(AGENT, { conversation: () => conversation({ status }) });
      await screen.findByRole('heading', { level: 2, name: 'Trần Văn Nam' });
      expect(document.querySelector('[data-actions]')).toBeNull();
      cleanup();
    }
  });

  it('retries the thread, the conversation and the messages both, when the messages could not be read', async () => {
    let calls = 0;
    const { h } = open(AGENT, { messages: () => ((calls += 1) === 1 ? new ApiError({ status: 500, code: 'INTERNAL_ERROR', correlationId: 'c' }) : messages()) });
    expect(await screen.findByText(vi_['states.error.title'])).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Thử lại/ }));
    await row('message-1');
    expect((h.client.readAll as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('shows the seven states: loading, denied, signed out, offline, error, empty (no conversation named) and not found', async () => {
    const loading = open(AGENT);
    expect(loading.container.querySelector('[role="status"]')).not.toBeNull();
    cleanup();
    for (const [error, title] of [
      [new ApiError({ status: 403, code: 'SCOPE_DENIED', correlationId: 'c' }), vi_['states.denied.title']],
      [new ApiError({ status: 401, code: 'SESSION_EXPIRED', correlationId: 'c' }), vi_['states.signedOut.title']],
      [new ApiError({ status: 0, code: NETWORK_ERROR_CODE, correlationId: 'c' }), vi_['states.offline.title']],
      [new ApiError({ status: 500, code: 'INTERNAL_ERROR', correlationId: 'c' }), vi_['states.error.title']],
    ] as const) {
      open(AGENT, { conversation: () => error });
      expect(await screen.findByText(title)).toBeTruthy();
      cleanup();
    }
    const { h } = open(NOBODY);
    expect(await screen.findByText(vi_['states.denied.title'])).toBeTruthy();
    expect(h.read).not.toHaveBeenCalled();
    cleanup();
    const none = open(AGENT, { entry: '/omni/omni-02' });
    expect(await screen.findByText(vi_['states.empty.title'])).toBeTruthy();
    expect(none.h.read).not.toHaveBeenCalled();
    cleanup();
    open(AGENT, { conversation: () => ({ id: 3 }) });
    expect(await screen.findByText(vi_['states.empty.title'])).toBeTruthy();
  });

  it('offers a reader the thread and nothing to write, and a suspended tenant too', async () => {
    open(READER);
    await row('message-1');
    expect(document.querySelector('[data-composer]')).toBeNull();
    expect(document.querySelector('[data-actions]')).toBeNull();
    cleanup();
    open(AGENT, { mode: 'READ_ONLY' });
    await row('message-1');
    expect(document.querySelector('[data-composer]')).toBeNull();
    expect(document.querySelector('[data-actions]')).toBeNull();
  });

  it('says when the conversation has no message yet, and links back to the inbox', async () => {
    open(AGENT, { messages: () => [] });
    expect(await screen.findByText(vi_['omni.thread.messages.none'])).toBeTruthy();
    expect((screen.getByRole('link', { name: vi_['omni.thread.back.action'] }) as HTMLAnchorElement).getAttribute('href')).toBe('/omni/omni-01');
  });

  describe('the rules of the model', () => {
    it('reads a message, its text and a list, and nothing from a record that is not one', () => {
      expect(toMessage(message({ direction: 'OUTBOUND', delivery_status: 'Read', author_membership_id: 'member-1' }))).toEqual({ id: 'message-1', direction: 'OUTBOUND', deliveryStatus: 'Read', authorId: 'member-1', createdAt: '2026-10-30T03:00:00Z' });
      expect(toMessage(message({ delivery_status: 'Weird' }))).toMatchObject({ deliveryStatus: undefined });
      expect(toMessage(null)).toBeUndefined();
      expect(toMessage({ id: 3 })).toBeUndefined();
      expect(toMessage({ id: 'x', direction: 'SIDEWAYS' })).toBeUndefined();
      expect(toMessage({ id: 'x', direction: 'INBOUND' })).toMatchObject({ createdAt: '' });
      expect(toMessages([message(), { id: 'bad' }])).toHaveLength(1);
      expect(toMessageText({ text: 'Xin chào' })).toBe('Xin chào');
      expect(toMessageText({ text: null })).toBe('');
      expect(toMessageText(null)).toBe('');
    });

    it('says what may be done in each state: answer, note, resolve, reopen', () => {
      const states = ['New', 'Assigned', 'InProgress', 'PendingCustomer', 'Resolved', 'Closed'] as const;
      expect(states.map((status) => mayReply({ status }))).toEqual([false, true, true, true, false, false]);
      expect(states.map((status) => mayNote({ status }))).toEqual([true, true, true, true, true, false]);
      expect(states.map((status) => mayResolve({ status }))).toEqual([false, false, true, true, false, false]);
      expect(states.map((status) => mayReopen({ status }))).toEqual([false, false, false, false, true, false]);
    });

    it('counts the window in whole hours and minutes, closed at the instant it ends and for a date that is not one', () => {
      const now = new Date('2026-10-30T10:00:00Z');
      expect(countdownOf({ windowExpiresAt: undefined }, now)).toBeUndefined();
      expect(countdownOf({ windowExpiresAt: '2026-10-30T13:25:59Z' }, now)).toEqual({ closed: false, hours: 3, minutes: 25 });
      expect(countdownOf({ windowExpiresAt: '2026-10-30T10:00:30Z' }, now)).toEqual({ closed: false, hours: 0, minutes: 0 });
      expect(countdownOf({ windowExpiresAt: '2026-10-30T10:00:00Z' }, now)).toEqual({ closed: true, hours: 0, minutes: 0 });
      expect(countdownOf({ windowExpiresAt: 'not a date' }, now)).toEqual({ closed: true, hours: 0, minutes: 0 });
    });

    it('builds the body of a send, judges the text and the reason, and maps the refusals', () => {
      expect(sendBody({ ...emptyDraft(), text: ' Xin chào ' }, 'account-1')).toEqual({ kind: 'EXTERNAL', channel_account_id: 'account-1', purpose: 'SUPPORT_CONVERSATION', text: 'Xin chào' });
      expect(sendBody({ ...emptyDraft(), note: true, text: ' Ghi chú ' }, 'account-1')).toEqual({ kind: 'INTERNAL_NOTE', channel_account_id: 'account-1', text: 'Ghi chú' });
      expect(textProblem({ text: '   ' })).toBe(true);
      expect(textProblem({ text: 'x'.repeat(4001) })).toBe(true);
      expect(textProblem({ text: 'x'.repeat(4000) })).toBe(false);
      expect(reasonProblem('short')).toBe(true);
      expect(reasonProblem('r'.repeat(2001))).toBe(true);
      expect(reasonProblem(reason)).toBe(false);
      expect(describeProblem(problem('OPT_IN_REQUIRED'))).toEqual({ reason: 'optIn' });
      expect(describeProblem(new Error('x'))).toEqual({ reason: 'general' });
      expect(describeProblem(problem('SOMETHING_NEW'))).toEqual({ reason: 'general' });
    });

    it('keeps what is loaded through a break in the network or a failure of the server, and drops it for a refusal; with nothing loaded any error is shown', () => {
      const refusals = [401, 403, 404].map((status) => new ApiError({ status, code: 'X', correlationId: 'c' }));
      const transient = [new ApiError({ status: 0, code: NETWORK_ERROR_CODE, correlationId: 'c' }), new ApiError({ status: 500, code: 'INTERNAL_ERROR', correlationId: 'c' }), new Error('x')];
      for (const error of refusals) expect([shownError(error, true), revokesAccess(error)]).toEqual([error, true]);
      for (const error of transient) expect([shownError(error, true), shownError(error, false), revokesAccess(error)]).toEqual([undefined, error, false]);
      expect([shownError(null, true), shownError(undefined, false)]).toEqual([undefined, undefined]);
    });
  });
});
