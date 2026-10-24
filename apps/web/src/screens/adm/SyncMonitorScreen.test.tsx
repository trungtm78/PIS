import { ApiError, NETWORK_ERROR_CODE } from '@machvon/api-client';
import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../i18n/vi.json';
import { routeOf } from '../doc/test-support';
import { harness, mountInSession } from './security/test-support';
import SyncMonitorScreen from './SyncMonitorScreen';

vi.setConfig({ testTimeout: 30_000 });

const ROUTE = routeOf('ADM-10', 'FR-ADM-10');
const READER = ['adm.integration.read', 'integration_cursor.read'];

const EVENT = {
  id: 'e-failed',
  provider: 'TREASURY',
  event_key: 'key-e-failed',
  provider_event_type: 'payment.confirmed',
  status: 'FAILED',
  attempts: 3,
  next_attempt_at: null,
  error_code: 'PROVIDER_DOWN',
  received_at: '2026-10-24T09:00:00.000Z',
  processed_at: null,
  payload_kept: true,
  replay_count: 0,
  version: 7,
};
const CURSOR = { id: 'k1', connector_code: 'TREASURY_STATEMENT_FILE', source_scope: 'DEFAULT', adapter_status: 'PROPOSED', status: 'ACTIVE', last_success_at: null, last_file_sha256: null, last_error_code: null, reset_reason: null, version: 1 };

type Reads = Record<string, () => Promise<unknown[]>>;

function withReads(reads: Reads) {
  const h = harness(() => new Error('no read'));
  (h.client as unknown as { readAll: (operation: string) => Promise<unknown[]> }).readAll = (operation) => (reads[operation] ?? (() => Promise.reject(new Error('unexpected read ' + operation))))();
  return h;
}
const ok = (): Reads => ({
  get_resources_integration_event_inbox: () => Promise.resolve([EVENT]),
  get_resources_integration_cursor: () => Promise.resolve([CURSOR]),
});
const failure = (status: number, code: string) => new ApiError({ status, code, correlationId: 'c' });

afterEach(cleanup);

describe('SyncMonitorScreen (ADM-10)', () => {
  it('reads the inbound events and the positions of the connectors and shows them without any payload (AC-ST-ADM-018-2)', async () => {
    mountInSession(<SyncMonitorScreen route={ROUTE} />, withReads(ok()), { permissions: READER });
    await waitFor(() => expect(document.querySelector('[data-event-id="e-failed"]')).not.toBeNull());
    expect(await screen.findByText('TREASURY_STATEMENT_FILE')).toBeTruthy();
    expect(screen.queryByText(vi_['adm.sync.cursors.error'])).toBeNull();
  });

  it('shows the loading state while the events are read', () => {
    mountInSession(<SyncMonitorScreen route={ROUTE} />, withReads({ ...ok(), get_resources_integration_event_inbox: () => new Promise(() => undefined) }), { permissions: READER });
    expect(screen.getByRole('status', { name: vi_['states.loading.label'] })).toBeTruthy();
  });

  it('still shows the positions of the connectors when the inbox is empty: an empty inbox is not an empty screen', async () => {
    mountInSession(<SyncMonitorScreen route={ROUTE} />, withReads({ ...ok(), get_resources_integration_event_inbox: () => Promise.resolve([]) }), { permissions: READER });
    expect(await screen.findByText(vi_['adm.sync.events.empty'])).toBeTruthy();
    expect(await screen.findByText('TREASURY_STATEMENT_FILE')).toBeTruthy();
  });

  it('is denied without reading anything when the session lacks adm.integration.read', () => {
    mountInSession(<SyncMonitorScreen route={ROUTE} />, withReads({}), { permissions: ['integration_cursor.read'] });
    expect(screen.getByText(vi_['states.denied.title'])).toBeTruthy();
  });

  it.each([
    ['denied', failure(403, 'SCOPE_DENIED'), 'states.denied.title'],
    ['signedOut', failure(401, 'SESSION_EXPIRED'), 'states.signedOut.title'],
    ['offline', failure(0, NETWORK_ERROR_CODE), 'states.offline.title'],
    ['error', failure(500, 'INTERNAL_ERROR'), 'states.error.title'],
  ] as const)('shows the %s state when the events cannot be read', async (_state, error, key) => {
    mountInSession(<SyncMonitorScreen route={ROUTE} />, withReads({ ...ok(), get_resources_integration_event_inbox: () => Promise.reject(error) }), { permissions: READER });
    expect(await screen.findByText(vi_[key])).toBeTruthy();
  });

  it('reads again when the person retries after a failure', async () => {
    let calls = 0;
    const reads = { ...ok(), get_resources_integration_event_inbox: () => (++calls === 1 ? Promise.reject(failure(500, 'INTERNAL_ERROR')) : Promise.resolve([EVENT])) };
    mountInSession(<SyncMonitorScreen route={ROUTE} />, withReads(reads), { permissions: READER });
    await userEvent.setup().click(await screen.findByRole('button', { name: vi_['states.retry.action'] }));
    await waitFor(() => expect(document.querySelector('[data-event-id="e-failed"]')).not.toBeNull());
    expect(calls).toBe(2);
  });

  it('keeps the events and says so when the positions cannot be read or may not be read', async () => {
    mountInSession(<SyncMonitorScreen route={ROUTE} />, withReads({ ...ok(), get_resources_integration_cursor: () => Promise.reject(failure(500, 'INTERNAL_ERROR')) }), { permissions: READER });
    expect(await screen.findByText(vi_['adm.sync.cursors.error'])).toBeTruthy();
    expect(document.querySelector('[data-event-id="e-failed"]')).not.toBeNull();
    cleanup();
    mountInSession(<SyncMonitorScreen route={ROUTE} />, withReads(ok()), { permissions: ['adm.integration.read'] });
    expect(await screen.findByText(vi_['adm.sync.cursors.error'])).toBeTruthy();
  });

  it('reads without checking permissions when the session does not know them', async () => {
    mountInSession(<SyncMonitorScreen route={ROUTE} />, withReads(ok()), { permissions: undefined });
    await waitFor(() => expect(document.querySelector('[data-event-id="e-failed"]')).not.toBeNull());
  });
});
