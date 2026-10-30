import { ApiError, NETWORK_ERROR_CODE } from '@machvon/api-client';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../i18n/vi.json';
import { harness, mount, routeOf } from '../not/delivery/test-support';
import WebhookEventsScreen from './WebhookEventsScreen';

const OPERATOR = ['adm.integration.read', 'adm.integration.operate'];
const READER = ['adm.integration.read'];
const NOBODY = ['notification.self'];
const reason = 'The provider was down for an hour, so the event is taken up again.';

const event = (overrides: Record<string, unknown> = {}) => ({
  id: 'event-1',
  provider: 'smtp-relay',
  event_key: 'evt-100',
  provider_event_type: 'message.inbound',
  channel_account_id: 'account-1',
  status: 'PROCESSED',
  attempts: 1,
  next_attempt_at: null,
  error_code: null,
  received_at: '2026-10-30T03:00:00Z',
  processed_at: '2026-10-30T03:00:01Z',
  payload_kept: true,
  replay_count: 0,
  version: 2,
  ...overrides,
});

afterEach(cleanup);

function open(permissions: readonly string[], items: () => unknown = () => [event()], command: () => unknown = () => ({}), mode?: 'READ_ONLY') {
  const respond = (value: unknown) => (value instanceof Error ? Promise.reject(value) : Promise.resolve(value));
  const h = harness(() => new Error('unexpected read'), command);
  (h.client as unknown as { readAll: unknown }).readAll = vi.fn((operation: string) => (operation === 'get_resources_integration_event_inbox' ? respond(items()) : respond(new Error(`unexpected readAll ${operation}`))));
  return { h, ...mount(<WebhookEventsScreen route={routeOf('OMNI-11', 'FR-OMNI-11')} />, h, { permissions, ...(mode === undefined ? {} : { mode }) }) };
}
const row = async (id: string): Promise<HTMLElement> =>
  (await waitFor(() => {
    const found = document.querySelector(`[data-event-id="${id}"]`) as HTMLElement | null;
    if (found === null) throw new Error('not yet');
    return found;
  })) as HTMLElement;

describe('OMNI-11 the webhook events and their reconciliation (UI-OMNI-11)', () => {
  it('AC-ST-OMNI-004-4 UI-OMNI-11: shows the events of the channel accounts only, with the provider, the key, the signature, when they came, the state, the attempts and the error', async () => {
    open(READER, () => [
      event(),
      event({ id: 'event-2', event_key: 'evt-101', status: 'FAILED', attempts: 3, error_code: 'PROVIDER_DOWN' }),
      // An event of a provider that is not a channel (a connector of master data) is not this screen's.
      event({ id: 'event-3', provider: 'other-connector', channel_account_id: null }),
    ]);
    const first = await row('event-1');
    expect(first.textContent).toContain('smtp-relay');
    expect(first.textContent).toContain('evt-100');
    expect(first.querySelector('[data-signature]')?.textContent).toBe(vi_['omni.webhook.signature.valid']);
    const failed = await row('event-2');
    expect(failed.textContent).toContain('PROVIDER_DOWN');
    expect(failed.querySelectorAll('td')[5]?.textContent).toBe('3');
    expect(document.querySelector('[data-event-id="event-3"]')).toBeNull();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(vi_['omni.webhook.page.title']);
    // The body of an event is not part of the view.
    expect(document.body.textContent).not.toContain('payload');
  });

  it('shows a loading state, then the denied, signed-out, offline, error and empty states', async () => {
    for (const [error, title] of [
      [new ApiError({ status: 403, code: 'SCOPE_DENIED', correlationId: 'c' }), vi_['states.denied.title']],
      [new ApiError({ status: 401, code: 'SESSION_EXPIRED', correlationId: 'c' }), vi_['states.signedOut.title']],
      [new ApiError({ status: 0, code: NETWORK_ERROR_CODE, correlationId: 'c' }), vi_['states.offline.title']],
      [new ApiError({ status: 500, code: 'INTERNAL_ERROR', correlationId: 'c' }), vi_['states.error.title']],
    ] as const) {
      open(READER, () => error);
      expect(await screen.findByText(title)).toBeTruthy();
      cleanup();
    }
    const loading = open(READER);
    expect(loading.container.querySelector('[role="status"]')).not.toBeNull();
    cleanup();
    const { h } = open(NOBODY);
    expect(await screen.findByText(vi_['states.denied.title'])).toBeTruthy();
    expect(h.client.readAll).not.toHaveBeenCalled();
    cleanup();
    open(READER, () => []);
    expect(await screen.findByText(vi_['states.empty.title'])).toBeTruthy();
    cleanup();
    // Events of other providers only: this screen has none.
    open(READER, () => [event({ channel_account_id: null })]);
    expect(await screen.findByText(vi_['states.empty.title'])).toBeTruthy();
  });

  it('filters by state and says so when none matches', async () => {
    open(READER, () => [event(), event({ id: 'event-2', status: 'DEAD', error_code: 'PROVIDER_DOWN' })]);
    await row('event-1');
    fireEvent.change(screen.getByLabelText(vi_['omni.webhook.filter.status.label']), { target: { value: 'DEAD' } });
    expect(document.querySelector('[data-event-id="event-1"]')).toBeNull();
    expect(document.querySelector('[data-event-id="event-2"]')).not.toBeNull();
    fireEvent.change(screen.getByLabelText(vi_['omni.webhook.filter.status.label']), { target: { value: 'RECEIVED' } });
    expect(await screen.findByText(vi_['omni.webhook.events.none'])).toBeTruthy();
  });

  it('takes a failed event up again with a reason, at the version read, asking for the reason before it sends anything', async () => {
    const { h } = open(OPERATOR, () => [event({ id: 'event-2', status: 'FAILED', version: 5 })], () => ({ operation_id: 'o', status: 'RECEIVED', resource_version: 6, resource_id: 'event-2' }));
    const failed = await row('event-2');
    fireEvent.click(within(failed).getByRole('button', { name: vi_['omni.webhook.replay.action'] }));
    const form = (await screen.findByRole('form', { name: vi_['omni.webhook.replay.form.aria'] })) as HTMLElement;
    fireEvent.click(within(form).getByRole('button', { name: vi_['omni.webhook.replay.confirm.action'] }));
    expect(within(form).getByText(vi_['omni.webhook.replay.reason.invalid'])).toBeTruthy();
    expect(h.command).not.toHaveBeenCalled();
    fireEvent.change(within(form).getByLabelText(vi_['omni.webhook.replay.reason.label']), { target: { value: reason } });
    fireEvent.click(within(form).getByRole('button', { name: vi_['omni.webhook.replay.confirm.action'] }));
    await waitFor(() => expect(h.command).toHaveBeenCalledTimes(1));
    expect(h.command.mock.calls[0]).toEqual(['replayInboxEvent', expect.objectContaining({ path: { inboxEventId: 'event-2' }, body: { reason }, ifMatchVersion: 5 })]);
    await waitFor(() => expect(document.querySelector('[data-replay-form]')).toBeNull());
  });

  it('says in words that the event changed, and keeps the form for another try; and can be cancelled', async () => {
    open(OPERATOR, () => [event({ id: 'event-2', status: 'DEAD' })], () => new ApiError({ status: 409, code: 'VERSION_CONFLICT', correlationId: 'c' }));
    fireEvent.click(within(await row('event-2')).getByRole('button', { name: vi_['omni.webhook.replay.action'] }));
    const form = (await screen.findByRole('form')) as HTMLElement;
    fireEvent.change(within(form).getByLabelText(vi_['omni.webhook.replay.reason.label']), { target: { value: reason } });
    fireEvent.click(within(form).getByRole('button', { name: vi_['omni.webhook.replay.confirm.action'] }));
    expect(await screen.findByText(vi_['adm.sync.problem.conflict'])).toBeTruthy();
    fireEvent.click(within(form).getByRole('button', { name: vi_['omni.webhook.replay.cancel.action'] }));
    expect(document.querySelector('[data-replay-form]')).toBeNull();
  });

  it('offers no replay to one who may not operate, none for an event that did not fail, none in a suspended tenant, and says when the body is gone', async () => {
    open(READER, () => [event({ id: 'event-2', status: 'FAILED' })]);
    expect(within(await row('event-2')).queryByRole('button')).toBeNull();
    cleanup();
    open(OPERATOR, () => [event()]);
    expect(within(await row('event-1')).queryByRole('button')).toBeNull();
    cleanup();
    open(OPERATOR, () => [event({ id: 'event-2', status: 'FAILED' })], () => ({}), 'READ_ONLY');
    expect(within(await row('event-2')).queryByRole('button')).toBeNull();
    cleanup();
    open(OPERATOR, () => [event({ id: 'event-2', status: 'DEAD', payload_kept: false })]);
    const gone = await row('event-2');
    expect(within(gone).queryByRole('button')).toBeNull();
    expect(gone.querySelector('[data-payload-gone]')?.textContent).toBe(vi_['omni.webhook.replay.gone']);
  });
});
