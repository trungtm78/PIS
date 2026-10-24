import { ApiError, NETWORK_ERROR_CODE } from '@machvon/api-client';
import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../i18n/vi.json';
import { routeOf } from '../doc/test-support';
import ConnectorsScreen from './ConnectorsScreen';
import { harness, mountInSession } from './security/test-support';

vi.setConfig({ testTimeout: 30_000 });

const ROUTE = routeOf('ADM-09', 'FR-ADM-09');
const READER = ['adm.integration.read'];

const connector = (id: string, code: string, adapter: string) => ({
  id,
  connector_code: code,
  adapter_status: adapter,
  mode: 'FILE_IMPORT',
  config: { directory: '/inbox' },
  credential_secret_ref: null,
  mapping_version: 'v1',
  status: 'Draft',
  last_test_at: null,
  last_test_result: null,
  version: 1,
});

function withReads(readAll: (operation: string) => Promise<unknown[]>) {
  const h = harness(() => new Error('no read'));
  (h.client as unknown as { readAll: (operation: string) => Promise<unknown[]> }).readAll = readAll;
  return h;
}
const failure = (status: number, code: string) => new ApiError({ status, code, correlationId: 'c' });

afterEach(cleanup);

describe('ConnectorsScreen (ADM-09)', () => {
  it('reads the connectors of the tenant and shows each with its adapter status (AC-ST-ADM-018-1)', async () => {
    const h = withReads((operation) => (operation === 'get_resources_integration_connector' ? Promise.resolve([connector('c1', 'treasury', 'PROPOSED'), connector('c2', 'budget', 'MOCK')]) : Promise.reject(new Error('unexpected read'))));
    mountInSession(<ConnectorsScreen route={ROUTE} />, h, { permissions: READER });
    expect(await screen.findByText('treasury')).toBeTruthy();
    expect(screen.getByText('budget')).toBeTruthy();
  });

  it('shows the loading state while the connectors are read', () => {
    mountInSession(<ConnectorsScreen route={ROUTE} />, withReads(() => new Promise(() => undefined)), { permissions: READER });
    expect(screen.getByRole('status', { name: vi_['states.loading.label'] })).toBeTruthy();
  });

  it('still offers the form to a tenant with no connector: an empty register is not an empty screen', async () => {
    mountInSession(<ConnectorsScreen route={ROUTE} />, withReads(() => Promise.resolve([])), { permissions: [...READER, 'adm.integration.manage'] });
    expect(await screen.findByText(vi_['adm.connectors.list.empty'])).toBeTruthy();
  });

  it('is denied without reading anything when the session lacks adm.integration.read', () => {
    const readAll = vi.fn(() => Promise.resolve([]));
    mountInSession(<ConnectorsScreen route={ROUTE} />, withReads(readAll), { permissions: ['adm.integration.manage'] });
    expect(screen.getByText(vi_['states.denied.title'])).toBeTruthy();
    expect(readAll).not.toHaveBeenCalled();
  });

  it.each([
    ['denied', failure(403, 'SCOPE_DENIED'), 'states.denied.title'],
    ['signedOut', failure(401, 'SESSION_EXPIRED'), 'states.signedOut.title'],
    ['offline', failure(0, NETWORK_ERROR_CODE), 'states.offline.title'],
    ['error', failure(500, 'INTERNAL_ERROR'), 'states.error.title'],
  ] as const)('shows the %s state when the connectors cannot be read', async (_state, error, key) => {
    mountInSession(<ConnectorsScreen route={ROUTE} />, withReads(() => Promise.reject(error)), { permissions: READER });
    expect(await screen.findByText(vi_[key])).toBeTruthy();
  });

  it('reads again when the person retries after a failure', async () => {
    let calls = 0;
    mountInSession(<ConnectorsScreen route={ROUTE} />, withReads(() => (++calls === 1 ? Promise.reject(failure(500, 'INTERNAL_ERROR')) : Promise.resolve([connector('c1', 'treasury', 'PROPOSED')]))), { permissions: READER });
    await userEvent.setup().click(await screen.findByRole('button', { name: vi_['states.retry.action'] }));
    await waitFor(() => expect(screen.getByText('treasury')).toBeTruthy());
    expect(calls).toBe(2);
  });

  it('reads without checking permissions when the session does not know them', async () => {
    mountInSession(<ConnectorsScreen route={ROUTE} />, withReads(() => Promise.resolve([connector('c1', 'treasury', 'VERIFIED')])), { permissions: undefined });
    expect(await screen.findByText('treasury')).toBeTruthy();
  });
});
