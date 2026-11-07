import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiClientProvider } from '../api/ApiClientContext';
import { ALL_MODULES_VISIBLE } from '../navigation/model';
import { PwaRoutes } from './PwaRoutes';
import { SessionContext, useSession } from '../session/SessionContext';
import type { SessionValue } from '../session/SessionContext';
import { TENANT, pwaClient, word } from './screens/test-support';
import { PwaSessionGuard, REVOKE_WAIT_MS } from './PwaSessionGuard';
import { DEVICE_STORAGE_KEY } from './push-client';
import { pwaStore } from './pwa-state';
import type { PurgeDeps } from './purge';

const REGISTRATION_ID = '00000000-0000-4000-8000-000000000001';

function session(overrides: Partial<SessionValue> = {}): SessionValue {
  return { tenant: TENANT, tenants: [TENANT], user: { displayName: 'Lãnh đạo', initials: 'LD' }, access: ALL_MODULES_VISIBLE, switchTenant: () => undefined, getSession: () => Promise.resolve({ token: 't' }), ...overrides };
}

/** Shows what the guard hands down, with a button that ends the session the way the sign-in screen does. */
function Probe() {
  const current = useSession();
  return (
    <button type="button" onClick={() => current.signOut?.()}>
      sign out
    </button>
  );
}

function setup(options: { signOut?: SessionValue['signOut']; command?: (operation: string) => unknown; purgeDeps?: Partial<PurgeDeps> } = {}) {
  const h = pwaClient({ command: options.command });
  const queries = new QueryClient();
  queries.setQueryData(['secret'], { amount: 1 });
  const purge = { cacheStorage: undefined, container: undefined, storage: undefined, ...options.purgeDeps };
  let setValue: (next: SessionValue) => void = () => undefined;
  function Host() {
    const [value, set] = useState<SessionValue>(session({ ...(options.signOut === undefined ? {} : { signOut: options.signOut }) }));
    setValue = set;
    return (
      <SessionContext.Provider value={value}>
        <QueryClientProvider client={queries}>
          <ApiClientProvider client={h.client}>
            <PwaSessionGuard purgeDeps={purge}>
              <Probe />
            </PwaSessionGuard>
          </ApiClientProvider>
        </QueryClientProvider>
      </SessionContext.Provider>
    );
  }
  render(<Host />);
  return { h, queries, endSession: () => act(() => setValue(session({ tenant: undefined, tenants: [], user: undefined, status: 'signedOut' }))) };
}

beforeEach(() => {
  pwaStore.reset();
  window.localStorage.clear();
});
afterEach(() => {
  cleanup();
  pwaStore.reset();
  vi.useRealTimers();
});

describe('PwaSessionGuard: nothing of a person stays on the device when the session ends (R7)', () => {
  it('drops the caches, the push subscription, the device record and the memory of the page when the session ends, whether the person left or it expired', async () => {
    const deleted: string[] = [];
    const removed: string[] = [];
    const unsubscribe = vi.fn(() => Promise.resolve(true));
    const { queries, endSession } = setup({
      purgeDeps: {
        cacheStorage: { keys: () => Promise.resolve(['mv-shell-b', 'mv-static-b']), delete: (name: string) => (deleted.push(name), Promise.resolve(true)) },
        container: { ready: Promise.resolve({ pushManager: { getSubscription: () => Promise.resolve({ unsubscribe }) } }), controller: null } as unknown as ServiceWorkerContainer,
        storage: { removeItem: (key: string) => void removed.push(key) },
      },
    });
    expect(queries.getQueryData(['secret'])).toBeDefined();
    endSession();
    await waitFor(() => expect(deleted.sort()).toEqual(['mv-shell-b', 'mv-static-b']));
    await waitFor(() => expect(unsubscribe).toHaveBeenCalled());
    expect(removed).toEqual([DEVICE_STORAGE_KEY]);
    expect(queries.getQueryData(['secret'])).toBeUndefined();
  });

  it('does nothing while the person stays signed in, nor for a visitor who was never signed in', async () => {
    const clearMemory = vi.fn();
    const { endSession } = setup({ purgeDeps: { clearMemory } });
    await act(() => Promise.resolve());
    expect(clearMemory).not.toHaveBeenCalled();
    endSession();
    await waitFor(() => expect(clearMemory).toHaveBeenCalledTimes(1));
    // Already signed out: a second change of the session is not a second purge.
    endSession();
    await act(() => Promise.resolve());
    expect(clearMemory).toHaveBeenCalledTimes(1);
  });

  it('asks the server to remove the device before the session ends, and then signs out', async () => {
    window.localStorage.setItem(DEVICE_STORAGE_KEY, JSON.stringify({ publicId: 'web-abc', registrationId: REGISTRATION_ID }));
    const order: string[] = [];
    const signOut = vi.fn(() => void order.push('signOut'));
    const { h } = setup({
      signOut,
      command: (operation: string) => {
        order.push(operation);
        return {};
      },
    });
    fireEvent.click(screen.getByRole('button', { name: 'sign out' }));
    await waitFor(() => expect(signOut).toHaveBeenCalledTimes(1));
    expect(order).toEqual(['revokeMyDevice', 'signOut']);
    expect(h.command.mock.calls[0]?.[1]).toMatchObject({ path: { deviceId: REGISTRATION_ID } });
    expect(window.localStorage.getItem(DEVICE_STORAGE_KEY)).toBeNull();
  });

  it('signs out at once when no device was registered', () => {
    const signOut = vi.fn();
    const { h } = setup({ signOut });
    fireEvent.click(screen.getByRole('button', { name: 'sign out' }));
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(h.command).not.toHaveBeenCalled();
  });

  it('signs out even when the server does not answer in time', async () => {
    vi.useFakeTimers();
    window.localStorage.setItem(DEVICE_STORAGE_KEY, JSON.stringify({ publicId: 'web-abc', registrationId: REGISTRATION_ID }));
    const signOut = vi.fn();
    setup({ signOut, command: () => new Promise(() => undefined) });
    fireEvent.click(screen.getByRole('button', { name: 'sign out' }));
    expect(signOut).not.toHaveBeenCalled();
    await act(() => vi.advanceTimersByTimeAsync(REVOKE_WAIT_MS + 10));
    expect(signOut).toHaveBeenCalledTimes(1);
  });

  it('leaves the session as it is when it has no way to sign out (the development session)', () => {
    setup();
    fireEvent.click(screen.getByRole('button', { name: 'sign out' }));
    expect(screen.getByRole('button', { name: 'sign out' })).toBeInTheDocument();
  });

  it('offers the update of the application on every screen, and applies it only when the person asks', () => {
    setup();
    expect(screen.queryByTestId('pwa-update')).toBeNull();
    const apply = vi.fn();
    act(() => pwaStore.updateReady(apply));
    const banner = screen.getByTestId('pwa-update');
    expect(banner.textContent).toContain(word('pwa.update.banner.text'));
    expect(apply).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: word('pwa.update.banner.action') }));
    expect(apply).toHaveBeenCalledTimes(1);
  });
});

describe('PwaRoutes: the manager screens sit behind the same gate as every screen', () => {
  function at(path: string, value: SessionValue) {
    const h = pwaClient({ readAll: () => [], read: () => new Error('unused') });
    return render(
      <SessionContext.Provider value={value}>
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <ApiClientProvider client={h.client}>
            <MemoryRouter initialEntries={[path]}>
              <Routes>
                <Route path="/m/*" element={<PwaRoutes />} />
              </Routes>
            </MemoryRouter>
          </ApiClientProvider>
        </QueryClientProvider>
      </SessionContext.Provider>,
    );
  }

  it('opens the start page and the three screens for a signed-in person, and sends any other path to the start page', async () => {
    const value = session({ permissions: ['approval_task.read', 'approval.decide', 'home.read'] });
    for (const [path, id] of [
      ['/m', 'PWA-01'],
      ['/m/approvals', 'PWA-02'],
      ['/m/directives', 'PWA-04'],
      ['/m/nothing-here', 'PWA-01'],
    ] as const) {
      const view = at(path, value);
      expect(await screen.findByRole('heading', { level: 1 })).toBeInTheDocument();
      expect(document.querySelector(`[data-screen-id="${id}"]`), path).not.toBeNull();
      view.unmount();
    }
    at('/m/dashboard', value);
    expect(document.querySelector('[data-screen-id="PWA-03"]')).not.toBeNull();
  });

  it('shows the lapsed-session card to a person who is not signed in, and the way in when sign-in exists', () => {
    const signedOut = session({ tenant: undefined, tenants: [], user: undefined });
    at('/m/approvals', signedOut);
    expect(screen.getByRole('alert').textContent).toContain(word('states.signedOut.title'));
    cleanup();
    at('/m/approvals', { ...signedOut, status: 'signedOut', signIn: () => Promise.resolve() });
    expect(screen.getByRole('button', { name: word('session.oidc.signIn.action') })).toBeInTheDocument();
  });
});
