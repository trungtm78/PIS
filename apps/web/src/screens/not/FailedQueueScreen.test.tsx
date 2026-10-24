import { NETWORK_ERROR_CODE } from '@machvon/api-client';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../i18n/vi.json';
import { OPERATOR, READER, failure, harness, mount, rawAttempt, routeOf } from './delivery/test-support';
import FailedQueueScreen from './FailedQueueScreen';

vi.setConfig({ testTimeout: 30_000 });

const ROUTE = routeOf('NOT-13', 'FR-NOT-13');

const FAILED = rawAttempt({
  id: 'a-failed',
  notification_id: '22222222-bbbb-4bbb-8bbb-222222222222',
  notification_status: 'Failed',
  notification_version: 9,
  status: 'Failed',
  attempt_no: 5,
  failure_class: 'RETRYABLE',
  error_code: 'HTTP_503',
});
const LOST_RECENT = rawAttempt({
  id: 'a-lost',
  notification_id: '33333333-cccc-4ccc-8ccc-333333333333',
  notification_status: 'Unknown',
  status: 'Unknown',
  channel: 'SMS',
  failure_class: 'UNKNOWN',
  error_code: 'TIMEOUT_AFTER_SEND',
  needs_reconcile: true,
  reconcile_due_at: '2026-10-25T03:00:00.000Z',
});
const LOST_OLD = rawAttempt({
  id: 'a-old',
  notification_id: '44444444-dddd-4ddd-8ddd-444444444444',
  notification_status: 'Unknown',
  notification_version: 4,
  status: 'Unknown',
  channel: 'SMS',
  failure_class: 'UNKNOWN',
  error_code: 'TIMEOUT_AFTER_SEND',
  needs_reconcile: false,
});

afterEach(cleanup);

function reads(items: unknown[]) {
  return harness((operation) => (operation === 'get_resources_delivery_attempt' ? { items, next_cursor: null } : new Error(`unexpected read ${operation}`)), () => ({ status: 'QUEUED' }));
}

const rowOf = (id: string): HTMLElement => document.querySelector(`[data-attempt-id="${id}"]`) as HTMLElement;

describe('NOT-13 failed queue and replay (UI-NOT-13, AC-ST-NOT-002-9)', () => {
  it('asks the server for the failed queue only and shows the error, whether it can be retried, the attempts used and when the next is due', async () => {
    const h = reads([FAILED, LOST_RECENT]);
    mount(<FailedQueueScreen route={ROUTE} />, h);
    await waitFor(() => expect(rowOf('a-failed')).not.toBeNull());
    expect(h.read).toHaveBeenCalledWith('get_resources_delivery_attempt', { query: { limit: 25, dlq: 'true' } });
    const failed = rowOf('a-failed');
    expect(within(failed).getByText('HTTP_503')).toBeTruthy();
    expect(within(failed).getByText(vi_['not.delivery.class.retryable'])).toBeTruthy();
    expect(within(failed).getByText('5/5')).toBeTruthy();
    expect(within(failed).getByText(vi_['not.failed.row.next.none'])).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1, name: vi_['not.failed.page.title'] })).toBeTruthy();
  });

  it('marks a send of unknown result that must be reconciled first, and offers no replay for it', async () => {
    mount(<FailedQueueScreen route={ROUTE} />, reads([FAILED, LOST_RECENT]));
    await waitFor(() => expect(rowOf('a-lost')).not.toBeNull());
    const lost = rowOf('a-lost');
    expect(within(lost).getByTestId('needs-reconcile').textContent).toMatch(/Đối soát đến/);
    expect(within(lost).getByText(vi_['not.delivery.class.unknown'])).toBeTruthy();
    expect(within(lost).queryByRole('button', { name: vi_['not.failed.replay.action'] })).toBeNull();
    expect(within(rowOf('a-failed')).getByRole('button', { name: vi_['not.failed.replay.action'] })).toBeTruthy();
  });

  it('replays a failed notification with the reason and the version of the notification', async () => {
    const user = userEvent.setup();
    const h = reads([FAILED]);
    mount(<FailedQueueScreen route={ROUTE} />, h);
    await user.click(await screen.findByRole('button', { name: vi_['not.failed.replay.action'] }));
    const panel = screen.getByTestId('replay-panel');
    expect(within(panel).queryByTestId('replay-panel-risk')).toBeNull();
    await user.click(within(panel).getByRole('button', { name: vi_['not.failed.replay.confirm.action'] }));
    expect(await within(panel).findByText(vi_['not.failed.replay.reason.error'])).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
    await user.type(within(panel).getByLabelText(vi_['not.failed.replay.reason.label']), 'The relay is back');
    await user.click(within(panel).getByRole('button', { name: vi_['not.failed.replay.confirm.action'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(h.command.mock.calls[0]?.[0]).toBe('post_notifications_id_replay');
    expect(h.command.mock.calls[0]?.[1]).toMatchObject({
      path: { id: '22222222-bbbb-4bbb-8bbb-222222222222' },
      body: { decision: 'approve', reason: 'The relay is back', evidence_ids: [] },
      ifMatchVersion: 9,
    });
    await waitFor(() => expect(screen.queryByTestId('replay-panel')).toBeNull());
  });

  it('warns that the message may be sent twice before replaying a send whose result was never learnt', async () => {
    const user = userEvent.setup();
    mount(<FailedQueueScreen route={ROUTE} />, reads([LOST_OLD]));
    await user.click(await screen.findByRole('button', { name: vi_['not.failed.replay.action'] }));
    expect(within(screen.getByTestId('replay-panel')).getByTestId('replay-panel-risk').textContent).toBe(vi_['not.failed.replay.risk']);
  });

  it.each([
    ['RECONCILE_REQUIRED', 'not.delivery.problem.reconcile'],
    ['NOTIFICATION_EXPIRED', 'not.delivery.problem.expired'],
    ['NOTIFICATION_STATE_INVALID', 'not.delivery.problem.stateInvalid'],
    ['VERSION_CONFLICT', 'not.delivery.problem.conflict'],
    ['RESOURCE_NOT_FOUND', 'not.delivery.problem.notFound'],
    ['SCOPE_DENIED', 'not.delivery.problem.denied'],
    ['VALIDATION_FAILED', 'not.delivery.problem.invalid'],
    ['SESSION_EXPIRED', 'not.delivery.problem.session'],
    ['SOMETHING_ELSE', 'not.delivery.problem.general'],
  ] as const)('says what the server refused with (%s) and leaves the panel open', async (code, key) => {
    const user = userEvent.setup();
    const h = harness(() => ({ items: [FAILED], next_cursor: null }), () => failure(409, code));
    mount(<FailedQueueScreen route={ROUTE} />, h);
    await user.click(await screen.findByRole('button', { name: vi_['not.failed.replay.action'] }));
    await user.type(screen.getByLabelText(vi_['not.failed.replay.reason.label']), 'The relay is back');
    await user.click(screen.getByRole('button', { name: vi_['not.failed.replay.confirm.action'] }));
    expect(await screen.findByText(vi_[key])).toBeTruthy();
    expect(screen.getByTestId('replay-panel')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: vi_['not.failed.replay.dismiss.action'] }));
    expect(screen.queryByTestId('replay-panel')).toBeNull();
  });

  it('is read-only in read-only mode and without the replay permission', async () => {
    mount(<FailedQueueScreen route={ROUTE} />, reads([FAILED]), { mode: 'READ_ONLY', permissions: OPERATOR });
    await waitFor(() => expect(rowOf('a-failed')).not.toBeNull());
    expect(screen.queryByRole('button', { name: vi_['not.failed.replay.action'] })).toBeNull();
    cleanup();
    mount(<FailedQueueScreen route={ROUTE} />, reads([FAILED]), { permissions: READER });
    await waitFor(() => expect(rowOf('a-failed')).not.toBeNull());
    expect(screen.queryByRole('button', { name: vi_['not.failed.replay.action'] })).toBeNull();
  });

  it('shows the loading state while the failed queue is read', () => {
    mount(<FailedQueueScreen route={ROUTE} />, harness(() => new Promise(() => undefined)));
    expect(screen.getByRole('status', { name: vi_['states.loading.label'] })).toBeTruthy();
  });

  it('shows the empty state when nothing has failed', async () => {
    mount(<FailedQueueScreen route={ROUTE} />, reads([]));
    expect(await screen.findByText(vi_['states.empty.title'])).toBeTruthy();
  });

  it('is denied without reading anything when the session lacks delivery_attempt.read', () => {
    const h = reads([FAILED]);
    mount(<FailedQueueScreen route={ROUTE} />, h, { permissions: ['notification.replay'] });
    expect(screen.getByText(vi_['states.denied.title'])).toBeTruthy();
    expect(h.read).not.toHaveBeenCalled();
  });

  it.each([
    ['denied', failure(403, 'SCOPE_DENIED'), 'states.denied.title'],
    ['signedOut', failure(401, 'SESSION_EXPIRED'), 'states.signedOut.title'],
    ['offline', failure(0, NETWORK_ERROR_CODE), 'states.offline.title'],
    ['error', failure(500, 'INTERNAL_ERROR'), 'states.error.title'],
  ] as const)('shows the %s state when the failed queue cannot be read', async (_state, error, key) => {
    mount(<FailedQueueScreen route={ROUTE} />, harness(() => error));
    expect(await screen.findByText(vi_[key])).toBeTruthy();
  });

  it('pages with the cursor of the server', async () => {
    const user = userEvent.setup();
    const h = harness((_operation, input) => {
      const cursor = (input as { query: { cursor?: string } }).query.cursor;
      return cursor === undefined ? { items: [FAILED], next_cursor: 'next-1' } : { items: [LOST_OLD], next_cursor: null };
    });
    mount(<FailedQueueScreen route={ROUTE} />, h);
    await user.click(await screen.findByRole('button', { name: vi_['not.failed.footer.more.action'] }));
    await waitFor(() => expect(rowOf('a-old')).not.toBeNull());
    expect(screen.getByText('Đã tải 2 mục')).toBeTruthy();
  });

  it('says when a further page cannot be loaded', async () => {
    const user = userEvent.setup();
    const h = harness((_operation, input) => ((input as { query: { cursor?: string } }).query.cursor === undefined ? { items: [FAILED], next_cursor: 'next-1' } : failure(500, 'INTERNAL_ERROR')));
    mount(<FailedQueueScreen route={ROUTE} />, h);
    await user.click(await screen.findByRole('button', { name: vi_['not.failed.footer.more.action'] }));
    expect(await screen.findByText(vi_['not.failed.footer.pageError'])).toBeTruthy();
  });
});
