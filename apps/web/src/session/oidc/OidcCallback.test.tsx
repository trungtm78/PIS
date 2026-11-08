import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../i18n/vi.json';
import { ALL_MODULES_VISIBLE } from '../../navigation/model';
import { SessionContext } from '../SessionContext';
import type { SessionValue } from '../SessionContext';
import { OidcError } from './client';
import { OidcCallback } from './OidcCallback';
import { SignInGate } from './SignInGate';

function Where() {
  const location = useLocation();
  return <p data-testid="where">{`${location.pathname}${location.search}`}</p>;
}

function session(over: Partial<SessionValue>): SessionValue {
  return { tenant: undefined, tenants: [], user: undefined, access: ALL_MODULES_VISIBLE, switchTenant: () => undefined, getSession: () => Promise.resolve(undefined), ...over };
}

function mountCallback(value: SessionValue, url = '/auth/callback?code=c&state=s') {
  return render(
    <SessionContext.Provider value={value}>
      <MemoryRouter initialEntries={[url]}>
        <Routes>
          <Route path="/auth/callback" element={<OidcCallback />} />
          <Route path="*" element={<Where />} />
        </Routes>
      </MemoryRouter>
    </SessionContext.Provider>,
  );
}

afterEach(cleanup);

describe('OidcCallback', () => {
  it('completes the sign-in once with the query of the address and continues at the chooser with the screen the person came for', async () => {
    const completeSignIn = vi.fn(() => Promise.resolve({ returnTo: '/adm/adm-01?tab=2' }));
    mountCallback(session({ completeSignIn }));
    expect(screen.getByRole('status', { name: vi_['session.oidc.callback.loading.label'] })).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe(`/iam/iam-04?next=${encodeURIComponent('/adm/adm-01?tab=2')}`));
    expect(completeSignIn).toHaveBeenCalledTimes(1);
    expect(completeSignIn).toHaveBeenCalledWith('?code=c&state=s');
  });

  it('returns to the chooser as it was after a second-factor sign-in that started there, instead of nesting it in a new one', async () => {
    const back = `/iam/iam-04?next=${encodeURIComponent('/adm/adm-01')}`;
    mountCallback(session({ completeSignIn: () => Promise.resolve({ returnTo: back }) }));
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe(back));
  });

  it('still wraps an address that only looks like the chooser', async () => {
    const lookalike = '/iam/iam-04x';
    mountCallback(session({ completeSignIn: () => Promise.resolve({ returnTo: lookalike }) }));
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe(`/iam/iam-04?next=${encodeURIComponent(lookalike)}`));
  });

  it('goes straight to the accept page of an invitation, before any tenant is chosen (the invitee may hold no membership)', async () => {
    const accept = '/invitations/00000000-0000-4000-8000-0000000000c1/accept?token=abc123_-';
    mountCallback(session({ completeSignIn: () => Promise.resolve({ returnTo: accept }), loadCandidates: () => Promise.resolve([]) }));
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe(accept));
  });

  it.each([
    '/invitations/not-an-id/accept?token=x',
    '/invitations/00000000-0000-4000-8000-0000000000c1/accept/../../adm',
    '/invitations/00000000-0000-4000-8000-0000000000c1/accept?token=x#frag',
    '//evil.example/invitations/00000000-0000-4000-8000-0000000000c1/accept',
    'https://evil.example/invitations/00000000-0000-4000-8000-0000000000c1/accept',
  ])('does not take %s as an invitation return path', async (returnTo) => {
    mountCallback(session({ completeSignIn: () => Promise.resolve({ returnTo }) }));
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe(`/iam/iam-04?next=${encodeURIComponent(returnTo)}`));
  });

  it('shows the callback error and offers a new sign-in when the provider answer is refused, without saying why', async () => {
    const signIn = vi.fn(() => Promise.resolve());
    mountCallback(session({ completeSignIn: () => Promise.reject(new OidcError('state_mismatch')), signIn }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(vi_['session.oidc.callback.error.title']);
    expect(alert.textContent).toContain(vi_['session.oidc.callback.error.body']);
    expect(alert.textContent).not.toContain('state_mismatch');
    await userEvent.click(screen.getByRole('button', { name: vi_['session.oidc.callback.retry.action'] }));
    expect(signIn).toHaveBeenCalledWith({ returnTo: '/' });
  });

  it('shows the unavailable state, not a lapsed session, when the new sign-in cannot reach the provider, and lets the person try again', async () => {
    const signIn = vi.fn().mockRejectedValueOnce(new OidcError('discovery_failed')).mockResolvedValue(undefined);
    mountCallback(session({ completeSignIn: () => Promise.reject(new OidcError('state_mismatch')), signIn }));
    await screen.findByRole('alert');
    await userEvent.click(screen.getByRole('button', { name: vi_['session.oidc.callback.retry.action'] }));
    expect((await screen.findByRole('alert')).textContent).toContain(vi_['session.oidc.unavailable.title']);
    await userEvent.click(screen.getByRole('button', { name: vi_['session.oidc.callback.retry.action'] }));
    expect(signIn).toHaveBeenCalledTimes(2);
  });

  it('shows the service-unavailable state when the provider cannot be reached', async () => {
    mountCallback(session({ completeSignIn: () => Promise.reject(new OidcError('discovery_failed')) }));
    expect((await screen.findByRole('alert')).textContent).toContain(vi_['session.oidc.unavailable.title']);
  });

  it('shows the callback error when the session offers no sign-in at all', async () => {
    mountCallback(session({}));
    expect((await screen.findByRole('alert')).textContent).toContain(vi_['session.oidc.callback.error.title']);
  });
});

describe('SignInGate', () => {
  it('states that the person is signed out and starts the sign-in at the current address', async () => {
    const signIn = vi.fn(() => Promise.resolve());
    render(
      <SessionContext.Provider value={session({ signIn })}>
        <MemoryRouter initialEntries={['/adm/adm-01?x=1']}>
          <SignInGate />
        </MemoryRouter>
      </SessionContext.Provider>,
    );
    expect(screen.getByRole('heading', { name: vi_['states.signedOut.title'] })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: vi_['session.oidc.signIn.action'] }));
    expect(signIn).toHaveBeenCalledWith({ returnTo: '/adm/adm-01?x=1' });
  });

  it('shows the unavailable state when the provider cannot be reached, and a new click tries again', async () => {
    const signIn = vi.fn().mockRejectedValueOnce(new OidcError('discovery_failed')).mockResolvedValue(undefined);
    render(
      <SessionContext.Provider value={session({ signIn })}>
        <MemoryRouter initialEntries={['/adm/adm-01']}>
          <SignInGate />
        </MemoryRouter>
      </SessionContext.Provider>,
    );
    await userEvent.click(screen.getByRole('button', { name: vi_['session.oidc.signIn.action'] }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(vi_['session.oidc.unavailable.title']);
    expect(alert.textContent).toContain(vi_['session.oidc.unavailable.body']);
    expect(alert.textContent).not.toContain(vi_['states.signedOut.title']);
    await userEvent.click(screen.getByRole('button', { name: vi_['session.oidc.signIn.action'] }));
    expect(signIn).toHaveBeenCalledTimes(2);
  });
});
