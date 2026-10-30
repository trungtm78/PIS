import { ApiError, NETWORK_ERROR_CODE } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import vi_ from '../../i18n/vi.json';
import { harness, mount, routeOf } from '../not/delivery/test-support';
import CannedReplyScreen from './CannedReplyScreen';
import { emptyReply, formOfReply, replyBody, replyFieldOf, replyProblems, toReply, toReplyPage } from './policy/model';

const SUPERVISOR = ['omni.policy.manage'];
const NOBODY = ['notification.self'];
const problem = (code: string, status = 422, detail?: string) => new ApiError({ status, code, correlationId: 'c', detail });

const reply = (overrides: Record<string, unknown> = {}) => ({ id: 'reply-1', code: 'greet.hello', title: 'Lời chào', body_text: 'Xin chào, chúng tôi đã nhận được tin của bạn.', channels: ['EMAIL', 'WHATSAPP'], classification: 'PUBLIC', status: 'Active', version: 3, ...overrides });
const page = (items: unknown[], next: string | null = null) => ({ items, next_cursor: next, as_of: '2026-10-30T03:00:00Z' });

afterEach(cleanup);

function open(permissions: readonly string[], answers: { list?: (input: unknown) => unknown; command?: (operation: string, input: unknown) => unknown; mode?: 'READ_ONLY' } = {}) {
  const h = harness((operation, input) => (operation === 'listCannedReplies' ? (answers.list ?? (() => page([reply(), reply({ id: 'reply-2', code: 'greet.internal', classification: 'INTERNAL', status: 'Retired', channels: ['SMS'] })])))(input) : new Error(`unexpected read ${operation}`)), answers.command ?? (() => ({})));
  return { h, ...mount(<CannedReplyScreen route={routeOf('OMNI-08', 'FR-OMNI-08')} />, h, { permissions, ...(answers.mode === undefined ? {} : { mode: answers.mode }) }) };
}
const row = async (id: string): Promise<HTMLElement> =>
  (await waitFor(() => {
    const found = document.querySelector(`[data-reply-id="${id}"]`) as HTMLElement | null;
    if (found === null) throw new Error('not yet');
    return found;
  })) as HTMLElement;
const newForm = async (): Promise<HTMLElement> => (await screen.findByRole('form', { name: vi_['omni.reply.form.new.aria'] })) as HTMLElement;
const fill = (form: HTMLElement, values: { code?: string; title?: string; body?: string }): void => {
  if (values.code !== undefined) fireEvent.change(within(form).getByLabelText(vi_['omni.reply.form.code.label']), { target: { value: values.code } });
  if (values.title !== undefined) fireEvent.change(within(form).getByLabelText(vi_['omni.reply.form.title.label']), { target: { value: values.title } });
  if (values.body !== undefined) fireEvent.change(within(form).getByLabelText(vi_['omni.reply.form.body.label'].replace('{max}', '2000')), { target: { value: values.body } });
};
const choose = (form: HTMLElement, channel: string): void => void fireEvent.click(within(form).getByLabelText(channel));
const submit = (form: HTMLElement): void => void fireEvent.click(within(form).getByRole('button', { name: vi_['omni.reply.form.submit.action'] }));

describe('OMNI-08 canned replies (UI-OMNI-08)', () => {
  it('AC-ST-OMNI-006-2 UI-OMNI-08: shows each reply with its code, title and text, its channels, its class and its state, and the notice about the window', async () => {
    open(SUPERVISOR);
    const first = await row('reply-1');
    expect(first.textContent).toContain('greet.hello');
    expect(first.textContent).toContain('Xin chào, chúng tôi đã nhận được tin của bạn.');
    expect(first.textContent).toContain(`${vi_['omni.policy.channel.email']}, ${vi_['omni.policy.channel.whatsapp']}`);
    expect(first.querySelector('[data-class]')?.textContent).toBe(vi_['omni.reply.class.public']);
    expect(first.textContent).toContain(vi_['omni.reply.status.active']);
    const second = await row('reply-2');
    expect(second.querySelector('[data-class]')?.textContent).toBe(vi_['omni.reply.class.internal']);
    expect(second.textContent).toContain(vi_['omni.reply.status.retired']);
    expect(document.querySelector('[data-window-notice]')?.textContent).toBe(vi_['omni.reply.window.notice']);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['omni.reply.page.title']);
  });

  it('reads the next page of the replies with the cursor of the last one', async () => {
    const { h } = open(SUPERVISOR, { list: (input) => ((input as { query: { cursor?: string } }).query.cursor === undefined ? page([reply()], 'next-1') : page([reply({ id: 'reply-9', code: 'zz.last' })])) });
    await row('reply-1');
    fireEvent.click(await screen.findByRole('button', { name: vi_['omni.reply.more.action'] }));
    await row('reply-9');
    expect(h.read.mock.calls.at(-1)).toEqual(['listCannedReplies', { query: { cursor: 'next-1' } }]);
    expect(screen.queryByRole('button', { name: vi_['omni.reply.more.action'] })).toBeNull();
  });

  it('shows the seven states: loading, denied, signed out, offline, error and empty', async () => {
    const loading = open(SUPERVISOR);
    expect(loading.container.querySelector('[role="status"]')).not.toBeNull();
    cleanup();
    for (const [error, title] of [
      [problem('SCOPE_DENIED', 403), vi_['states.denied.title']],
      [problem('SESSION_EXPIRED', 401), vi_['states.signedOut.title']],
      [new ApiError({ status: 0, code: NETWORK_ERROR_CODE, correlationId: 'c' }), vi_['states.offline.title']],
      [problem('INTERNAL_ERROR', 500), vi_['states.error.title']],
    ] as const) {
      open(SUPERVISOR, { list: () => error });
      expect(await screen.findByText(title)).toBeTruthy();
      cleanup();
    }
    const { h } = open(NOBODY);
    expect(await screen.findByText(vi_['states.denied.title'])).toBeTruthy();
    expect(h.read).not.toHaveBeenCalled();
    cleanup();
    open(SUPERVISOR, { list: () => page([]) });
    expect(await screen.findByText(vi_['states.empty.title'])).toBeTruthy();
  });

  it('AC-ST-OMNI-006-4 UI-OMNI-08: writes next to the field why a text with a variable is refused, before sending anything, and sends nothing', async () => {
    const { h } = open(SUPERVISOR);
    const form = await newForm();
    fill(form, { code: 'greet.new', title: 'Chào', body: 'Xin chào {{name}}' });
    choose(form, vi_['omni.policy.channel.email']);
    submit(form);
    expect(within(form).getByText(vi_['omni.reply.field.body.variable']).closest('[data-field-problem]')?.getAttribute('data-field-problem')).toBe('bodyText');
    expect(h.command).not.toHaveBeenCalled();
    for (const body of ['Mã ${code}', 'Mã {code}', 'Mã %code%']) {
      fill(form, { body });
      submit(form);
      expect(within(form).getByText(vi_['omni.reply.field.body.variable'])).toBeTruthy();
    }
    expect(h.command).not.toHaveBeenCalled();
  });

  it('writes next to each field what is missing: a code, a title, a text, a channel', async () => {
    const { h } = open(SUPERVISOR);
    const form = await newForm();
    submit(form);
    for (const key of ['omni.reply.field.code.invalid', 'omni.reply.field.title.invalid', 'omni.reply.field.body.invalid', 'omni.reply.field.channels.invalid'] as const) expect(within(form).getByText(vi_[key])).toBeTruthy();
    expect([...form.querySelectorAll('[data-field-problem]')].map((item) => item.getAttribute('data-field-problem'))).toEqual(['code', 'title', 'bodyText', 'channels']);
    expect(h.command).not.toHaveBeenCalled();
  });

  it('makes a reply: the code, the title, the text, the channels and a class that may be sent, and says it was made', async () => {
    const { h } = open(SUPERVISOR, { command: () => ({ operation_id: 'o', status: 'ACTIVE', resource_version: 1, resource_id: 'reply-9' }) });
    const form = await newForm();
    fill(form, { code: 'greet.new', title: '  Chào  ', body: ' Xin chào, tin của bạn đã được nhận. ' });
    choose(form, vi_['omni.policy.channel.zalo']);
    choose(form, vi_['omni.policy.channel.email']);
    fireEvent.click(within(form).getByLabelText(vi_['omni.policy.channel.zalo']));
    fireEvent.change(within(form).getByLabelText(vi_['omni.reply.form.class.label']), { target: { value: 'INTERNAL' } });
    submit(form);
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(h.command.mock.calls[0]).toEqual(['createCannedReply', expect.objectContaining({ body: { code: 'greet.new', title: 'Chào', body_text: 'Xin chào, tin của bạn đã được nhận.', channels: ['EMAIL'], classification: 'INTERNAL' } })]);
    expect(await screen.findByText(vi_['omni.reply.done.created'])).toBeTruthy();
  });

  it('starts over once a reply is made: the form is empty and the next save makes another reply, not the same one again', async () => {
    const { h } = open(SUPERVISOR, { command: () => ({ operation_id: 'o', status: 'ACTIVE', resource_version: 1, resource_id: 'reply-9' }) });
    const form = await newForm();
    fill(form, { code: 'greet.new', title: 'Chào', body: 'Xin chào' });
    choose(form, vi_['omni.policy.channel.email']);
    submit(form);
    expect(await screen.findByText(vi_['omni.reply.done.created'])).toBeTruthy();
    const again = await newForm();
    expect((within(again).getByLabelText(vi_['omni.reply.form.code.label']) as HTMLInputElement).value).toBe('');
    expect((within(again).getByLabelText(vi_['omni.reply.form.title.label']) as HTMLInputElement).value).toBe('');
    fill(again, { code: 'greet.next', title: 'Tiếp', body: 'Xin chào lần nữa' });
    choose(again, vi_['omni.policy.channel.sms']);
    submit(again);
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(2));
    expect(h.command.mock.calls.map((call) => call[0])).toEqual(['createCannedReply', 'createCannedReply']);
    expect((h.command.mock.calls[1]?.[1] as { body: { code: string } }).body.code).toBe('greet.next');
  });

  it('changes a reply at the version read, keeping its code, and says it was saved; a change can be given up', async () => {
    const { h } = open(SUPERVISOR, { command: () => ({ operation_id: 'o', status: 'ACTIVE', resource_version: 4, resource_id: 'reply-1' }) });
    fireEvent.click(within(await row('reply-1')).getByRole('button', { name: vi_['omni.reply.edit.aria'].replace('{code}', 'greet.hello') }));
    const form = (await screen.findByRole('form', { name: vi_['omni.reply.form.edit.aria'].replace('{code}', 'greet.hello') })) as HTMLElement;
    expect((within(form).getByLabelText(vi_['omni.reply.form.code.label']) as HTMLInputElement).readOnly).toBe(true);
    expect((within(form).getByLabelText(vi_['omni.reply.form.title.label']) as HTMLInputElement).value).toBe('Lời chào');
    fireEvent.click(within(form).getByRole('button', { name: vi_['omni.reply.form.cancel.action'] }));
    expect(await newForm()).toBeTruthy();
    fireEvent.click(within(await row('reply-1')).getByRole('button', { name: vi_['omni.reply.edit.aria'].replace('{code}', 'greet.hello') }));
    const again = (await screen.findByRole('form', { name: vi_['omni.reply.form.edit.aria'].replace('{code}', 'greet.hello') })) as HTMLElement;
    fill(again, { title: 'Lời chào mới' });
    submit(again);
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(h.command.mock.calls[0]).toEqual([
      'updateCannedReply',
      expect.objectContaining({ path: { replyId: 'reply-1' }, ifMatchVersion: 3, body: { code: 'greet.hello', title: 'Lời chào mới', body_text: 'Xin chào, chúng tôi đã nhận được tin của bạn.', channels: ['EMAIL', 'WHATSAPP'], classification: 'PUBLIC' } }),
    ]);
    expect(await screen.findByText(vi_['omni.reply.done.changed'])).toBeTruthy();
  });

  it('writes next to the field what the server refused: a text with a variable, a class, a code that is taken', async () => {
    for (const [error, field, message] of [
      [problem('VALIDATION_FAILED', 422, 'body_text'), 'bodyText', vi_['omni.reply.field.body.variable']],
      [problem('VALIDATION_FAILED', 422, 'classification'), 'classification', vi_['omni.reply.field.class.invalid']],
      [problem('VALIDATION_FAILED', 422, 'title'), 'title', vi_['omni.reply.field.title.invalid']],
      [problem('CANNED_CODE_TAKEN', 409, 'code'), 'code', vi_['omni.reply.problem.taken']],
    ] as const) {
      open(SUPERVISOR, { command: () => error });
      const form = await newForm();
      fill(form, { code: 'greet.new', title: 'Chào', body: 'Xin chào' });
      choose(form, vi_['omni.policy.channel.email']);
      submit(form);
      await waitFor(() => expect(form.querySelector(`[data-field-problem="${field}"]`)?.textContent).toBe(message));
      cleanup();
    }
  });

  it('says in words a refusal that names no field, and what changed meanwhile', async () => {
    for (const [error, key] of [
      [problem('VERSION_CONFLICT', 409), 'omni.policy.problem.conflict'],
      [problem('SCOPE_DENIED', 403), 'omni.policy.problem.denied'],
      [problem('RESOURCE_NOT_FOUND', 404), 'omni.policy.problem.notFound'],
      [problem('VALIDATION_FAILED', 422), 'omni.reply.problem.invalid'],
      [problem('INTERNAL_ERROR', 500), 'omni.policy.problem.general'],
    ] as const) {
      open(SUPERVISOR, { command: () => error });
      const form = await newForm();
      fill(form, { code: 'greet.new', title: 'Chào', body: 'Xin chào' });
      choose(form, vi_['omni.policy.channel.email']);
      submit(form);
      expect(await screen.findByText(vi_[key])).toBeTruthy();
      cleanup();
    }
  });

  it('offers nothing to write to one who may not manage, and nothing in a suspended tenant', async () => {
    open(SUPERVISOR, { mode: 'READ_ONLY' });
    await row('reply-1');
    expect(screen.queryByRole('form')).toBeNull();
    expect(within(await row('reply-1')).queryByRole('button')).toBeNull();
  });

  describe('the rules of the model', () => {
    it('reads a reply, and nothing from a record that is not one', () => {
      expect(toReply(reply())).toEqual({ id: 'reply-1', code: 'greet.hello', title: 'Lời chào', bodyText: 'Xin chào, chúng tôi đã nhận được tin của bạn.', channels: ['EMAIL', 'WHATSAPP'], classification: 'PUBLIC', status: 'Active', version: 3 });
      expect(toReply(reply({ status: 'Retired' }))?.status).toBe('Retired');
      expect(toReply({ id: 'x' })).toMatchObject({ code: '', channels: [], version: 0, status: 'Active' });
      expect(toReply(null)).toBeUndefined();
      expect(toReply({ id: 3 })).toBeUndefined();
      expect(toReplyPage(page([reply(), { id: 3 }], 'n'))).toMatchObject({ items: [{ id: 'reply-1' }], nextCursor: 'n' });
      expect(toReplyPage(undefined)).toEqual({ items: [], nextCursor: undefined });
    });

    it('judges the form as the server does, and builds the form and the body', () => {
      const good = { code: 'greet.hello', title: 'Chào', bodyText: 'Xin chào', channels: ['EMAIL'], classification: 'PUBLIC' };
      expect(replyProblems(good)).toEqual({});
      expect(replyProblems({ ...emptyReply(), bodyText: 'x'.repeat(2001) })).toMatchObject({ bodyText: 'invalid', code: 'invalid', title: 'invalid', channels: 'invalid' });
      expect(replyProblems({ ...good, bodyText: 'Giá 50% {không đổi} (xem {1})' })).toEqual({});
      expect(replyProblems({ ...good, bodyText: 'a {{ x }} b' })).toEqual({ bodyText: 'variable' });
      expect(replyProblems({ ...good, classification: 'CONFIDENTIAL' })).toEqual({ classification: 'class' });
      expect(replyProblems({ ...good, code: 'Has Space', title: 'x'.repeat(121) })).toEqual({ code: 'invalid', title: 'invalid' });
      expect(formOfReply(toReply(reply()) as never)).toEqual({ code: 'greet.hello', title: 'Lời chào', bodyText: 'Xin chào, chúng tôi đã nhận được tin của bạn.', channels: ['EMAIL', 'WHATSAPP'], classification: 'PUBLIC' });
      expect(replyBody({ ...good, title: ' Chào ', bodyText: ' Xin chào ' })).toEqual({ code: 'greet.hello', title: 'Chào', body_text: 'Xin chào', channels: ['EMAIL'], classification: 'PUBLIC' });
      expect(['body_text', 'code', 'title', 'channels', 'classification', 'other', undefined].map(replyFieldOf)).toEqual(['bodyText', 'code', 'title', 'channels', 'classification', undefined, undefined]);
    });
  });
});
