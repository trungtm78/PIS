import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiClientProvider } from '../api/ApiClientContext';
import { ALL_MODULES_VISIBLE } from '../navigation/model';
import { ReleaseFlagNote } from './ReleaseFlagNote';
import { SessionContext } from './SessionContext';
import type { SessionValue } from './SessionContext';
import { flagMapOf, useFeatureFlags } from './useFeatureFlags';

const TENANT = { id: '00000000-0000-4000-8000-00000000000a', name: 'T', monogram: 'T', membershipId: '00000000-0000-4000-8000-000000000001', theme: { themeId: 'x', version: 1, overlay: {} } };

function wrap(read: (operation: string) => unknown, child: React.ReactNode, withTenant = true) {
  const session: SessionValue = { tenant: withTenant ? TENANT : undefined, tenants: [], user: undefined, access: ALL_MODULES_VISIBLE, switchTenant: () => undefined, getSession: () => Promise.resolve({ token: 't' }) };
  const client = { read: vi.fn((operation: string) => (async () => { const answer = read(operation); if (answer instanceof Error) throw answer; return answer; })()), readAll: vi.fn(), command: vi.fn() };
  render(
    <SessionContext.Provider value={session}>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })}>
        <ApiClientProvider client={client as never}>{child}</ApiClientProvider>
      </QueryClientProvider>
    </SessionContext.Provider>,
  );
  return client;
}

function Probe({ flag }: { flag: string }) {
  const flags = useFeatureFlags();
  return <p data-testid="probe">{flags.isLoading ? 'loading' : flags.isError ? 'error' : String(flags.enabled(flag))}</p>;
}

afterEach(cleanup);

describe('flagMapOf', () => {
  it('reads the rows of the answer and drops the ones that are not that shape', () => {
    expect([...flagMapOf({ items: [{ flag_key: 'a', enabled: true }, { flag_key: 'b', enabled: false }, { flag_key: 3, enabled: true }, null, { flag_key: 'c' }] })]).toEqual([['a', true], ['b', false]]);
    expect(flagMapOf(undefined).size).toBe(0);
    expect(flagMapOf({ items: 'x' }).size).toBe(0);
  });
});

describe('useFeatureFlags', () => {
  it('is loading first, then says on, off, and off for a flag the server did not name', async () => {
    const client = wrap(() => ({ items: [{ flag_key: 'x.on', enabled: true }, { flag_key: 'x.off', enabled: false }] }), <><Probe flag="x.on" /><Probe flag="x.off" /><Probe flag="x.unknown" /></>);
    expect(screen.getAllByTestId('probe')[0]?.textContent).toBe('loading');
    await waitFor(() => expect(screen.getAllByTestId('probe').map((node) => node.textContent)).toEqual(['true', 'false', 'false']));
    expect(client.read).toHaveBeenCalledWith('getMyFeatureFlags');
  });

  it('says a failed read is a failure, never off, and reads nothing without a tenant', async () => {
    wrap(() => new Error('down'), <Probe flag="x.on" />);
    await waitFor(() => expect(screen.getByTestId('probe').textContent).toBe('error'));
    cleanup();
    const client = wrap(() => ({ items: [] }), <Probe flag="x.on" />, false);
    expect(client.read).not.toHaveBeenCalled();
  });
});

describe('ReleaseFlagNote', () => {
  it('shows nothing while loading and when the flag is on', async () => {
    wrap(() => ({ items: [{ flag_key: 'sas.silo_promotion', enabled: true }] }), <ReleaseFlagNote flagKey="sas.silo_promotion" />);
    expect(screen.queryByTestId('release-flag-off')).toBeNull();
    await waitFor(() => expect(screen.queryByTestId('release-flag-unknown')).toBeNull());
    expect(screen.queryByTestId('release-flag-off')).toBeNull();
  });

  it('says the feature is not on for the tenant when the flag is off or missing', async () => {
    wrap(() => ({ items: [] }), <ReleaseFlagNote flagKey="sas.silo_promotion" />);
    const note = await screen.findByTestId('release-flag-off');
    expect(note.getAttribute('data-flag')).toBe('sas.silo_promotion');
    expect(note.textContent).toContain('sas.silo_promotion');
  });

  it('says the flags could not be read, with a way to read again', async () => {
    let calls = 0;
    wrap(() => (calls++ === 0 ? new Error('down') : { items: [{ flag_key: 'f', enabled: true }] }), <ReleaseFlagNote flagKey="f" />);
    const unknown = await screen.findByTestId('release-flag-unknown');
    fireEvent.click(unknown.querySelector('button') as HTMLElement);
    await waitFor(() => expect(screen.queryByTestId('release-flag-unknown')).toBeNull());
    expect(screen.queryByTestId('release-flag-off')).toBeNull();
  });
});
