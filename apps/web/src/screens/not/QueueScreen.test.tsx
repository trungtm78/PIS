import { NETWORK_ERROR_CODE } from '@machvon/api-client';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../i18n/vi.json';
import { OPERATOR, READER, failure, harness, mount, rawAttempt, routeOf } from './delivery/test-support';
import QueueScreen from './QueueScreen';

vi.setConfig({ testTimeout: 30_000 });

const ROUTE = routeOf('NOT-11', 'FR-NOT-11');
const NOTIFICATION = '11111111-aaaa-4aaa-8aaa-111111111111';

const WAITING = rawAttempt({ id: 'a-queued', status: 'Queued', attempt_no: 2, next_retry_at: '2026-10-24T03:00:30.000Z', notification_version: 7 });
const FAILED = rawAttempt({
  id: 'a-failed',
  notification_id: '22222222-bbbb-4bbb-8bbb-222222222222',
  status: 'Failed',
  notification_status: 'Failed',
  attempt_no: 5,
  channel: 'SMS',
  fallback_channel: null,
  failure_class: 'PERMANENT',
  error_code: 'HTTP_550',
});

afterEach(cleanup);

function reads(items: unknown[], next: string | null = null) {
  return harness((operation, input) => {
    if (operation !== 'get_resources_delivery_attempt') return new Error(`unexpected read ${operation}`);
    void input;
    return { items, next_cursor: next };
  });
}

describe('NOT-11 send queue (UI-NOT-11, AC-ST-NOT-002-8)', () => {
  it('shows one row per send with its channel, status, attempt out of five, fallback channel and expiry', async () => {
    mount(<QueueScreen route={ROUTE} />, reads([WAITING, FAILED]));
    const row = await waitFor(() => {
      const found = document.querySelector('[data-attempt-id="a-queued"]');
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    expect(within(row).getByText('E-mail')).toBeTruthy();
    expect(within(row).getByText(vi_['not.delivery.status.queued'])).toBeTruthy();
    expect(within(row).getByText('2/5')).toBeTruthy();
    expect(within(row).getByText('SMS')).toBeTruthy();
    expect(within(row).getByText(/Lần tới:/)).toBeTruthy();
    const second = document.querySelector('[data-attempt-id="a-failed"]') as HTMLElement;
    expect(within(second).getByText(vi_['not.queue.row.fallback.none'])).toBeTruthy();
    expect(within(second).getByText(vi_['not.delivery.status.failed'])).toBeTruthy();
    expect(screen.getByText(/Tối đa 5 lần gửi mỗi kênh/)).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1, name: vi_['not.queue.page.title'] })).toBeTruthy();
    expect(document.querySelector('[data-screen-id="NOT-11"]')).not.toBeNull();
  });

  it('links each row to the journey of the send', async () => {
    mount(<QueueScreen route={ROUTE} />, reads([WAITING]));
    const link = await screen.findByRole('link', { name: NOTIFICATION.slice(0, 8) });
    expect(link.getAttribute('href')).toBe('/not/not-12?id=a-queued');
  });

  it('shows the loading state while the page is read', () => {
    mount(<QueueScreen route={ROUTE} />, harness(() => new Promise(() => undefined)));
    expect(screen.getByRole('status', { name: vi_['states.loading.label'] })).toBeTruthy();
  });

  it('shows the empty state when the tenant has no send', async () => {
    mount(<QueueScreen route={ROUTE} />, reads([]));
    expect(await screen.findByText(vi_['states.empty.title'])).toBeTruthy();
  });

  it('is denied without reading anything when the session lacks delivery_attempt.read', () => {
    const h = reads([WAITING]);
    mount(<QueueScreen route={ROUTE} />, h, { permissions: ['notification.operate'] });
    expect(screen.getByText(vi_['states.denied.title'])).toBeTruthy();
    expect(h.read).not.toHaveBeenCalled();
  });

  it.each([
    ['denied', failure(403, 'SCOPE_DENIED'), 'states.denied.title'],
    ['signedOut', failure(401, 'SESSION_EXPIRED'), 'states.signedOut.title'],
    ['offline', failure(0, NETWORK_ERROR_CODE), 'states.offline.title'],
    ['error', failure(500, 'INTERNAL_ERROR'), 'states.error.title'],
  ] as const)('shows the %s state when the queue cannot be read', async (_state, error, key) => {
    mount(<QueueScreen route={ROUTE} />, harness(() => error));
    expect(await screen.findByText(vi_[key])).toBeTruthy();
  });

  it('asks the server for one status when the operator picks it, and for all of them again', async () => {
    const user = userEvent.setup();
    const h = reads([WAITING]);
    mount(<QueueScreen route={ROUTE} />, h);
    await screen.findByRole('link', { name: NOTIFICATION.slice(0, 8) });
    await user.selectOptions(screen.getByLabelText(vi_['not.queue.filter.status.label']), 'Failed');
    await waitFor(() => expect(h.read).toHaveBeenLastCalledWith('get_resources_delivery_attempt', { query: { limit: 25, status: 'Failed' } }));
    await user.selectOptions(screen.getByLabelText(vi_['not.queue.filter.status.label']), '');
    await waitFor(() => expect(h.read).toHaveBeenLastCalledWith('get_resources_delivery_attempt', { query: { limit: 25 } }));
  });

  it('pages with the cursor of the server and says when a page cannot be loaded', async () => {
    const user = userEvent.setup();
    let failNext = true;
    const h = harness((_operation, input) => {
      const cursor = (input as { query: { cursor?: string } }).query.cursor;
      if (cursor === undefined) return { items: [WAITING], next_cursor: 'next-1' };
      if (failNext) {
        failNext = false;
        return failure(500, 'INTERNAL_ERROR');
      }
      return { items: [FAILED], next_cursor: null };
    });
    mount(<QueueScreen route={ROUTE} />, h);
    await screen.findByText(vi_['not.queue.footer.more.action']);
    await user.click(screen.getByRole('button', { name: vi_['not.queue.footer.more.action'] }));
    expect(await screen.findByText(vi_['not.queue.footer.pageError'])).toBeTruthy();
    await user.click(screen.getByRole('button', { name: vi_['not.queue.footer.more.action'] }));
    await waitFor(() => expect(document.querySelector('[data-attempt-id="a-failed"]')).not.toBeNull());
    expect(screen.getByText('Đã tải 2 lần gửi')).toBeTruthy();
    expect(screen.queryByRole('button', { name: vi_['not.queue.footer.more.action'] })).toBeNull();
  });

  describe('cancel', () => {
    it('offers a cancel for a send that is waiting only, not for the others, nor in read-only mode, nor without the permission', async () => {
      const { unmount } = mount(<QueueScreen route={ROUTE} />, reads([WAITING, FAILED]));
      await screen.findByRole('link', { name: NOTIFICATION.slice(0, 8) });
      expect(screen.getAllByRole('button', { name: vi_['not.queue.cancel.action'] })).toHaveLength(1);
      unmount();
      mount(<QueueScreen route={ROUTE} />, reads([WAITING]), { mode: 'READ_ONLY' });
      await screen.findByRole('link', { name: NOTIFICATION.slice(0, 8) });
      expect(screen.queryByRole('button', { name: vi_['not.queue.cancel.action'] })).toBeNull();
      cleanup();
      mount(<QueueScreen route={ROUTE} />, reads([WAITING]), { permissions: READER });
      await screen.findByRole('link', { name: NOTIFICATION.slice(0, 8) });
      expect(screen.queryByRole('button', { name: vi_['not.queue.cancel.action'] })).toBeNull();
    });

    it('asks for a reason of 10 to 2000 characters, then cancels with the version of the notification', async () => {
      const user = userEvent.setup();
      const h = harness(() => ({ items: [WAITING], next_cursor: null }), () => ({ status: 'CANCELLED', resource_version: 8 }));
      mount(<QueueScreen route={ROUTE} />, h, { permissions: OPERATOR });
      await user.click(await screen.findByRole('button', { name: vi_['not.queue.cancel.action'] }));
      const panel = screen.getByTestId('cancel-panel');
      await user.type(within(panel).getByLabelText(vi_['not.queue.cancel.reason.label']), 'short');
      await user.click(within(panel).getByRole('button', { name: vi_['not.queue.cancel.confirm.action'] }));
      expect(await within(panel).findByText(vi_['not.queue.cancel.reason.error'])).toBeTruthy();
      expect(h.command).not.toHaveBeenCalled();
      await user.clear(within(panel).getByLabelText(vi_['not.queue.cancel.reason.label']));
      await user.type(within(panel).getByLabelText(vi_['not.queue.cancel.reason.label']), '  The report was withdrawn  ');
      await user.click(within(panel).getByRole('button', { name: vi_['not.queue.cancel.confirm.action'] }));
      await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
      expect(h.command.mock.calls[0]?.[0]).toBe('cancelNotification');
      expect(h.command.mock.calls[0]?.[1]).toMatchObject({ path: { notificationId: NOTIFICATION }, body: { reason: 'The report was withdrawn' }, ifMatchVersion: 7 });
      await waitFor(() => expect(screen.queryByTestId('cancel-panel')).toBeNull());
    });

    it.each([
      ['VERSION_CONFLICT', 'not.delivery.problem.conflict'],
      ['NOTIFICATION_STATE_INVALID', 'not.delivery.problem.stateInvalid'],
      ['SCOPE_DENIED', 'not.delivery.problem.denied'],
      ['SOMETHING_ELSE', 'not.delivery.problem.general'],
    ] as const)('says what the server refused with (%s) and leaves the panel open', async (code, key) => {
      const user = userEvent.setup();
      const h = harness(() => ({ items: [WAITING], next_cursor: null }), () => failure(409, code));
      mount(<QueueScreen route={ROUTE} />, h);
      await user.click(await screen.findByRole('button', { name: vi_['not.queue.cancel.action'] }));
      await user.type(screen.getByLabelText(vi_['not.queue.cancel.reason.label']), 'The report was withdrawn');
      await user.click(screen.getByRole('button', { name: vi_['not.queue.cancel.confirm.action'] }));
      expect(await screen.findByText(vi_[key])).toBeTruthy();
      expect(screen.getByTestId('cancel-panel')).toBeTruthy();
      await user.click(screen.getByRole('button', { name: vi_['not.queue.cancel.dismiss.action'] }));
      expect(screen.queryByTestId('cancel-panel')).toBeNull();
    });
  });
});
