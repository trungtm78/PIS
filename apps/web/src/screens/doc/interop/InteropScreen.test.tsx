import { ApiError, NETWORK_ERROR_CODE } from '@machvon/api-client';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../../i18n/vi.json';
import { SECOND_TENANT, TENANT } from '../test-support';
import InteropScreen from './InteropScreen';
import { MANAGER, OUTSIDER, WATCHER, acked, client, dead, failed, messageId, mountInSession, outgoingId, incomingId, received, routeOf, world } from './test-support';
import type { World } from './test-support';

const ROUTE = routeOf('DOC-20', 'FR-DOC-20');
const OK = { operation_id: '00000000-0000-4000-8000-000000000999', status: 'QUEUED', resource_version: 5, resource_id: messageId(1) };
const problem = (code: string, status = 422) => new ApiError({ status, code, correlationId: 'c', extensions: {} });
const text = (key: string, params: Record<string, string | number> = {}): string =>
  Object.entries(params).reduce((message, [name, value]) => message.replace(`{${name}}`, String(value)), (vi_ as Record<string, string>)[key] ?? key);

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

interface Options {
  permissions?: readonly string[] | undefined;
  mode?: 'FULL' | 'READ_ONLY';
  command?: (operation: string, input: unknown) => unknown;
}

function open(state: World, options: Options = {}) {
  const h = client(state, options.command ?? (() => OK));
  const view = mountInSession(<InteropScreen route={ROUTE} />, h, { permissions: 'permissions' in options ? options.permissions : MANAGER, ...(options.mode === undefined ? {} : { mode: options.mode }) });
  return { h, ...view };
}

const row = (n: number): HTMLElement => document.querySelector(`[data-message-id="${messageId(n)}"]`) as HTMLElement;
const retryOf = (n: number): HTMLElement => within(row(n)).getByRole('button', { name: text('doc.interop.retry.label', { id: messageId(n) }) });

describe('InteropScreen (DOC-20): the monitor of the interoperability through the LGSP', () => {
  describe('UI-DOC-20: the seven states', () => {
    it('shows the loading state while the messages are read, and the messages once they are', async () => {
      open(world([failed(1)]));
      expect(screen.getByRole('status', { name: vi_['states.loading.label'] })).toBeTruthy();
      await screen.findByTestId('messages');
      expect(screen.getByRole('heading', { level: 1, name: vi_['doc.interop.page.title'] })).toBeTruthy();
      expect(screen.getByText(text('doc.interop.footer.reference', { id: 'DOC-20', req: 'FR-DOC-20' }))).toBeTruthy();
    });

    it('shows the empty state when the tenant has no message at all', async () => {
      open(world());
      expect(await screen.findByText(vi_['states.empty.title'])).toBeTruthy();
      expect(screen.queryByTestId('messages')).toBeNull();
    });

    it('shows the error state with a retry that reads again', async () => {
      const state = world([failed(1)], new Map([['listInteropMessages', new Error('boom')]]));
      const { h } = open(state);
      expect(await screen.findByText(vi_['states.error.title'])).toBeTruthy();
      state.failing.clear();
      fireEvent.click(screen.getByRole('button', { name: vi_['states.retry.action'] }));
      await screen.findByTestId('messages');
      expect(h.read.mock.calls.length).toBeGreaterThan(1);
    });

    it('shows the offline, signed-out and denied states for what the server says', async () => {
      open(world([], new Map([['listInteropMessages', problem(NETWORK_ERROR_CODE, 0)]])));
      expect(await screen.findByText(vi_['states.offline.title'])).toBeTruthy();
      cleanup();
      open(world([], new Map([['listInteropMessages', problem('SESSION_EXPIRED', 401)]])));
      expect(await screen.findByText(vi_['states.signedOut.title'])).toBeTruthy();
      cleanup();
      open(world([], new Map([['listInteropMessages', problem('SCOPE_DENIED', 403)]])));
      expect(await screen.findByText(vi_['states.denied.title'])).toBeTruthy();
    });

    it('is denied without the right to read, and reads nothing', () => {
      const { h } = open(world([failed(1)]), { permissions: OUTSIDER });
      expect(screen.getByText(vi_['states.denied.title'])).toBeTruthy();
      expect(h.read).not.toHaveBeenCalled();
      expect((screen.getByRole('button', { name: vi_['doc.interop.refresh'] }) as HTMLButtonElement).disabled).toBe(true);
    });
  });

  describe('the messages', () => {
    it('shows a message that left and waits as a row: the direction, the parties, the status, when it is tried again, the attempts, the error, the adapter and the way to its distribution', async () => {
      open(world([failed(1)]));
      await screen.findByTestId('messages');
      const first = row(1);
      expect(first.getAttribute('data-status')).toBe('FAILED');
      expect(first.getAttribute('data-direction')).toBe('OUTBOUND');
      expect(first.textContent).toContain(vi_['doc.interop.direction.outbound']);
      expect(within(first).getByTestId('external-id').textContent).toBe(vi_['doc.interop.message.none']);
      expect(within(first).getByTestId('parties').textContent).toBe(text('doc.interop.parties.to', { code: 'G08.SKHDT' }));
      expect(within(first).getByTestId('status').textContent).toBe(vi_['doc.interop.status.failed']);
      expect(within(first).getByTestId('status').className).toBe('pill warn');
      expect(within(first).getByTestId('next-attempt').textContent).toBe(text('doc.interop.next.text', { at: '03:03 3/11/26' }));
      expect(within(first).getByTestId('attempts').textContent).toBe('2/20');
      expect(within(first).getByTestId('error').textContent).toBe('PROVIDER_UNAVAILABLE');
      expect(within(first).getByTestId('adapter').textContent).toBe(vi_['doc.interop.adapter.mock']);
      expect(within(first).getByTestId('adapter').className).toContain('pill red');
      expect(within(first).getByRole('link', { name: vi_['doc.interop.link.outgoing'] }).getAttribute('href')).toBe(`/doc/doc-08?doc=${outgoingId(1)}`);
    });

    it('shows a message that arrived with its sender, the id the sender gave and the way to the letter it made, and no attempts', async () => {
      open(world([received(2)]));
      await screen.findByTestId('messages');
      const arrived = row(2);
      expect(arrived.getAttribute('data-direction')).toBe('INBOUND');
      expect(within(arrived).getByTestId('parties').textContent).toBe(text('doc.interop.parties.from', { code: 'G08.BTC' }));
      expect(within(arrived).getByTestId('external-id').textContent).toBe('E-IN-2');
      expect(within(arrived).getByTestId('status').textContent).toBe(vi_['doc.interop.status.processed']);
      expect(within(arrived).getByTestId('status').className).toBe('pill');
      expect(within(arrived).getByTestId('attempts').textContent).toBe('');
      expect(within(arrived).getByRole('link', { name: vi_['doc.interop.link.incoming'] }).getAttribute('href')).toBe(`/doc/doc-13?id=${incomingId(2)}`);
      expect(within(arrived).queryByTestId('next-attempt')).toBeNull();
    });

    it('shows a message that was acknowledged, with the id the gateway gave it and nothing to do', async () => {
      open(world([acked(3)]));
      await screen.findByTestId('messages');
      expect(within(row(3)).getByTestId('external-id').textContent).toBe('LGSP-3');
      expect(within(row(3)).getByTestId('status').textContent).toBe(vi_['doc.interop.status.acked']);
      expect(within(row(3)).queryByRole('button')).toBeNull();
    });

    it('says how many messages are dead, and that none of them reached the receiving agency', async () => {
      open(world([dead(1), failed(2), dead(3)]));
      expect((await screen.findByTestId('dead-note')).textContent).toBe(text('doc.interop.dead.note', { count: 2 }));
      expect(within(row(1)).getByTestId('status').className).toBe('pill red');
      cleanup();
      open(world([failed(2)]));
      await screen.findByTestId('messages');
      expect(screen.queryByTestId('dead-note')).toBeNull();
    });

    it('says that no adapter is verified while none is, and says nothing once one is', async () => {
      open(world([failed(1), received(2, { adapter_status: 'PROPOSED' })]));
      expect((await screen.findByTestId('adapter-note')).textContent).toBe(vi_['doc.interop.adapter.note']);
      cleanup();
      open(world([failed(1), received(2)]));
      await screen.findByTestId('messages');
      expect(screen.queryByTestId('adapter-note')).toBeNull();
    });

    it('names the moment the messages were read, and reads them again on request', async () => {
      const { h } = open(world([failed(1)]));
      await screen.findByTestId('messages');
      expect(screen.getByTestId('as-of').textContent).toBe(text('doc.interop.asOf', { time: '10:10 3/11/26' }));
      const before = h.read.mock.calls.length;
      fireEvent.click(screen.getByRole('button', { name: vi_['doc.interop.refresh'] }));
      await waitFor(() => expect(h.read.mock.calls.length).toBeGreaterThan(before));
    });

    it('never shows the envelope, which carries the letter itself', async () => {
      open(world([failed(1, { envelope_object_key: 'tenants/x/interop-envelope/secret', envelope_sha256: 'a'.repeat(64) })]));
      await screen.findByTestId('messages');
      expect(document.body.textContent).not.toContain('secret');
      expect(document.body.textContent).not.toContain('a'.repeat(64));
    });
  });

  describe('the filter and the pages', () => {
    it('narrows by direction and by status with a read of its own, and keeps the filter in view when nothing matches', async () => {
      const { h } = open(world([failed(1), received(2), dead(3), acked(4)]));
      await screen.findByTestId('messages');
      fireEvent.change(screen.getByLabelText(vi_['doc.interop.filter.direction']), { target: { value: 'INBOUND' } });
      await waitFor(() => expect(document.querySelectorAll('[data-message-id]')).toHaveLength(1));
      expect(row(2)).toBeTruthy();
      expect(h.read.mock.calls.at(-1)?.[1]).toMatchObject({ query: { limit: 50, direction: 'INBOUND' } });
      fireEvent.change(screen.getByLabelText(vi_['doc.interop.filter.direction']), { target: { value: '' } });
      fireEvent.change(screen.getByLabelText(vi_['doc.interop.filter.status']), { target: { value: 'DEAD' } });
      // The table of the earlier filter stays until the answer for this one comes.
      await waitFor(() => expect(row(3)).toBeTruthy());
      expect(document.querySelectorAll('[data-message-id]')).toHaveLength(1);
      expect(h.read.mock.calls.at(-1)?.[1]).toMatchObject({ query: { limit: 50, status: 'DEAD' } });
      // Nothing matches: the filter stays, and the screen is not "empty".
      fireEvent.change(screen.getByLabelText(vi_['doc.interop.filter.direction']), { target: { value: 'INBOUND' } });
      expect((await screen.findByTestId('no-match')).textContent).toBe(vi_['doc.interop.filter.empty']);
      expect(screen.queryByText(vi_['states.empty.title'])).toBeNull();
      expect(screen.getByLabelText(vi_['doc.interop.filter.status'])).toBeTruthy();
    });

    it('offers more messages when there are more, and adds them to the table', async () => {
      const many = Array.from({ length: 60 }, (_, index) => failed(index + 1, { status: 'ACKED', actions: { retry: false } }));
      const { h } = open(world(many));
      await screen.findByTestId('messages');
      expect(document.querySelectorAll('[data-message-id]')).toHaveLength(50);
      fireEvent.click(screen.getByRole('button', { name: vi_['doc.interop.more'] }));
      await waitFor(() => expect(document.querySelectorAll('[data-message-id]')).toHaveLength(60));
      expect(h.read.mock.calls.at(-1)?.[1]).toMatchObject({ query: { limit: 50, cursor: '50' } });
      expect(screen.queryByRole('button', { name: vi_['doc.interop.more'] })).toBeNull();
    });

    it('starts over when the tenant is switched: the filter and the refusals belong to one membership', async () => {
      const state = world([failed(1), received(2)]);
      const view = open(state);
      await screen.findByTestId('messages');
      fireEvent.change(screen.getByLabelText(vi_['doc.interop.filter.direction']), { target: { value: 'INBOUND' } });
      await waitFor(() => expect(document.querySelectorAll('[data-message-id]')).toHaveLength(1));
      view.rerenderWith({ permissions: MANAGER, tenant: SECOND_TENANT });
      await waitFor(() => expect(document.querySelectorAll('[data-message-id]')).toHaveLength(2));
      expect((screen.getByLabelText(vi_['doc.interop.filter.direction']) as HTMLSelectElement).value).toBe('');
    });
  });

  describe('a switch of membership', () => {
    it('starts over for another membership of the same tenant: what one may read is not what the other may', async () => {
      const view = open(world([failed(1), received(2)]));
      await screen.findByTestId('messages');
      fireEvent.change(screen.getByLabelText(vi_['doc.interop.filter.direction']), { target: { value: 'INBOUND' } });
      await waitFor(() => expect(document.querySelectorAll('[data-message-id]')).toHaveLength(1));
      view.rerenderWith({ permissions: MANAGER, tenant: { ...TENANT, membershipId: '00000000-0000-4000-8000-000000000002' } });
      await waitFor(() => expect(document.querySelectorAll('[data-message-id]')).toHaveLength(2));
      expect((screen.getByLabelText(vi_['doc.interop.filter.direction']) as HTMLSelectElement).value).toBe('');
    });
  });

  describe('sending a message again', () => {
    it('AC-ST-DOC-021-1, UAT-AC425: sends a failed or dead message again with the version the person saw and an idempotency attempt, then reads the messages again', async () => {
      const { h } = open(world([failed(1), dead(2), acked(3)]));
      await screen.findByTestId('messages');
      expect(within(row(3)).queryByRole('button')).toBeNull();
      fireEvent.click(retryOf(2));
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
      expect(h.command.mock.calls[0]?.[0]).toBe('retryInteropMessage');
      expect(h.command.mock.calls[0]?.[1]).toMatchObject({ path: { id: messageId(2) }, ifMatchVersion: 22, attempt: expect.anything() });
      await waitFor(() => expect(h.read.mock.calls.length).toBeGreaterThan(1));
      fireEvent.click(retryOf(1));
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(2));
      expect(h.command.mock.calls[1]?.[1]).toMatchObject({ path: { id: messageId(1) }, ifMatchVersion: 4 });
    });

    it('is readOnly while the answer is pending: one message goes at a time and the others wait', async () => {
      let release: (value: unknown) => void = () => undefined;
      const pending = new Promise((resolve) => (release = resolve));
      const { h } = open(world([failed(1), failed(2)]), { command: () => pending });
      await screen.findByTestId('messages');
      fireEvent.click(retryOf(1));
      await waitFor(() => expect(within(row(1)).getByRole('button', { name: text('doc.interop.retry.label', { id: messageId(1) }) }).textContent).toBe(vi_['doc.interop.retry.pending']));
      expect((retryOf(1) as HTMLButtonElement).disabled).toBe(true);
      expect((retryOf(2) as HTMLButtonElement).disabled).toBe(true);
      fireEvent.click(retryOf(2));
      expect(h.command).toHaveBeenCalledTimes(1);
      await act(async () => release(OK));
      await waitFor(() => expect((retryOf(2) as HTMLButtonElement).disabled).toBe(false));
    });

    it('keeps the idempotency key when the answer is lost, and takes a new one after a refusal', async () => {
      let calls = 0;
      const { h } = open(world([failed(1)]), {
        command: () => {
          calls += 1;
          return calls === 1 ? problem('INTERNAL_ERROR', 500) : calls === 2 ? problem('VERSION_CONFLICT', 409) : OK;
        },
      });
      await screen.findByTestId('messages');
      fireEvent.click(retryOf(1));
      await screen.findByTestId('refusal');
      fireEvent.click(retryOf(1));
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(screen.getByTestId('refusal').textContent).toBe(vi_['doc.interop.error.versionConflict']));
      fireEvent.click(retryOf(1));
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(3));
      const keys = h.command.mock.calls.map((call) => (call[1] as { attempt: { key: string } }).attempt.key);
      expect(keys[0]).toBe(keys[1]);
      expect(keys[2]).not.toBe(keys[1]);
      await waitFor(() => expect(screen.queryByTestId('refusal')).toBeNull());
    });

    it('takes a new idempotency key for the same message at another version: it is another request', async () => {
      const state = world([failed(1)]);
      let calls = 0;
      const { h } = open(state, {
        command: () => {
          calls += 1;
          return calls === 1 ? problem('INTERNAL_ERROR', 500) : OK;
        },
      });
      await screen.findByTestId('messages');
      fireEvent.click(retryOf(1));
      await screen.findByTestId('refusal');
      // The job took the message meanwhile and it failed once more: the list read again has the version after that.
      state.messages = [failed(1, { version: 5, attempts: 3 })];
      fireEvent.click(screen.getByRole('button', { name: vi_['doc.interop.refresh'] }));
      await waitFor(() => expect(within(row(1)).getByTestId('attempts').textContent).toBe('3/20'));
      fireEvent.click(retryOf(1));
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(2));
      expect(h.command.mock.calls[1]?.[1]).toMatchObject({ ifMatchVersion: 5 });
      const keys = h.command.mock.calls.map((call) => (call[1] as { attempt: { key: string } }).attempt.key);
      expect(keys[1]).not.toBe(keys[0]);
    });

    it.each([
      ['INTEROP_STATE_INVALID', 409, 'doc.interop.error.stateInvalid'],
      ['RESOURCE_NOT_FOUND', 404, 'doc.interop.error.notFound'],
      ['SCOPE_DENIED', 403, 'doc.interop.error.denied'],
      ['SESSION_EXPIRED', 401, 'doc.interop.error.session'],
      ['INTERNAL_ERROR', 500, 'doc.interop.error.general'],
    ])('says what a refusal %s means, outside the row, which may have changed', async (code, status, key) => {
      open(world([failed(1)]), { command: () => problem(code, status) });
      await screen.findByTestId('messages');
      fireEvent.click(retryOf(1));
      expect((await screen.findByTestId('refusal')).textContent).toBe((vi_ as Record<string, string>)[key]);
      expect(within(row(1)).queryByTestId('refusal')).toBeNull();
    });

    it('offers it only where the right is held, the server says so and the session is not read-only', async () => {
      open(world([failed(1), failed(2, { actions: { retry: false } })]), { permissions: MANAGER });
      await screen.findByTestId('messages');
      expect(retryOf(1)).toBeTruthy();
      expect(within(row(2)).queryByRole('button')).toBeNull();
      cleanup();
      open(world([failed(1)]), { permissions: WATCHER });
      await screen.findByTestId('messages');
      expect(within(row(1)).queryByRole('button')).toBeNull();
      cleanup();
      open(world([failed(1)]), { mode: 'READ_ONLY' });
      await screen.findByTestId('messages');
      expect(within(row(1)).queryByRole('button')).toBeNull();
    });
  });

  describe('accessibility', () => {
    it('names the screen, the filter, every column and every action', async () => {
      open(world([failed(1)]));
      await screen.findByTestId('messages');
      expect(screen.getByRole('search', { name: vi_['doc.interop.filter.label'] })).toBeTruthy();
      const headers = within(screen.getByTestId('messages')).getAllByRole('columnheader');
      expect(headers).toHaveLength(9);
      expect(headers.map((header) => header.textContent)).toContain(vi_['doc.interop.col.attempts']);
      expect(retryOf(1).getAttribute('aria-label')).toBe(text('doc.interop.retry.label', { id: messageId(1) }));
      expect(screen.getByLabelText(vi_['doc.interop.filter.status'])).toBeTruthy();
      expect(screen.getByLabelText(vi_['doc.interop.filter.direction'])).toBeTruthy();
    });
  });
});
