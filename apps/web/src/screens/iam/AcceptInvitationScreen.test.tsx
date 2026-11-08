import { ApiError } from '@machvon/api-client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ALL_MODULES_VISIBLE } from '../../navigation/model';
import { renderApp } from '../../test/render';
import { SessionContext } from '../../session/SessionContext';
import type { SessionValue } from '../../session/SessionContext';
import { ApiClientProvider } from '../../api/ApiClientContext';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import AcceptInvitationScreen, { TOKEN_MIN, refusalOf } from './AcceptInvitationScreen';

const INVITATION = '00000000-0000-4000-8000-0000000000c1';
const TOKEN = 'a'.repeat(TOKEN_MIN);
const PATH = `/invitations/${INVITATION}/accept?token=${TOKEN}`;

const session = (over: Partial<SessionValue> = {}): SessionValue => ({
  tenant: undefined,
  tenants: [],
  user: undefined,
  access: ALL_MODULES_VISIBLE,
  switchTenant: () => undefined,
  getSession: () => Promise.resolve(undefined),
  ...over,
});

function mountPage(value: SessionValue, path = PATH, command: (operation: string, input: unknown) => unknown = () => ({})) {
  const cmd = vi.fn((operation: string, input: unknown) => {
    const answer = command(operation, input);
    return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
  });
  const client = { read: vi.fn(), readAll: vi.fn(), command: cmd };
  render(
    <SessionContext.Provider value={value}>
      <QueryClientProvider client={new QueryClient()}>
        <ApiClientProvider client={client as never}>
          <MemoryRouter initialEntries={[path]}>
            <Routes>
              <Route path="/invitations/:invitationId/accept" element={<AcceptInvitationScreen />} />
              <Route path="*" element={<p>elsewhere</p>} />
            </Routes>
          </MemoryRouter>
        </ApiClientProvider>
      </QueryClientProvider>
    </SessionContext.Provider>,
  );
  return cmd;
}

afterEach(() => cleanup());

describe('the invitation accept page', () => {
  it('names a broken link and sends nothing when the token is missing or short or the id is not an id', () => {
    const cmd = mountPage(session(), `/invitations/${INVITATION}/accept?token=short`);
    expect(screen.getByTestId('invite-invalid')).toBeTruthy();
    expect(screen.queryByTestId('invite-accept')).toBeNull();
    cleanup();
    mountPage(session(), `/invitations/not-an-id/accept?token=${TOKEN}`);
    expect(screen.getByTestId('invite-invalid')).toBeTruthy();
    expect(cmd).not.toHaveBeenCalled();
  });

  it('asks a signed-out visitor to sign in first, and comes back to the same link', async () => {
    const signIn = vi.fn(() => Promise.resolve());
    mountPage(session({ status: 'signedOut', signIn }));
    expect(screen.queryByTestId('invite-accept')).toBeNull();
    fireEvent.click(screen.getByTestId('invite-signin'));
    await waitFor(() => expect(signIn).toHaveBeenCalledWith({ returnTo: PATH }));
  });

  it('accepts under the identity of the signed-in person, once, and goes on to the tenant chooser', async () => {
    const acceptInvitation = vi.fn(() => Promise.resolve());
    mountPage(session({ status: 'identified', acceptInvitation }));
    fireEvent.click(screen.getByTestId('invite-accept'));
    await waitFor(() => expect(acceptInvitation).toHaveBeenCalledWith(INVITATION, TOKEN));
    expect(await screen.findByTestId('invite-done')).toBeTruthy();
    expect(screen.getByTestId('invite-next').getAttribute('href')).toMatch(/iam/i);
  });

  it('sends the command with one idempotency attempt when the session has no identity-bound accept, and keeps the attempt for a retry after a lost answer', async () => {
    let calls = 0;
    const cmd = mountPage(session({ tenant: { id: 't', name: 'T', monogram: 'T', membershipId: 'm', theme: { themeId: 'x', version: 1, overlay: {} } } }), PATH, () => (calls++ === 0 ? new ApiError({ status: 503, code: 'DEPENDENCY_UNAVAILABLE', correlationId: 'c' }) : {}));
    fireEvent.click(screen.getByTestId('invite-accept'));
    expect(await screen.findByTestId('invite-error')).toBeTruthy();
    fireEvent.click(screen.getByTestId('invite-accept'));
    expect(await screen.findByTestId('invite-done')).toBeTruthy();
    expect(cmd).toHaveBeenCalledTimes(2);
    const first = cmd.mock.calls[0]?.[1] as { attempt: unknown; path: unknown; body: unknown };
    const second = cmd.mock.calls[1]?.[1] as { attempt: unknown };
    expect(first.path).toEqual({ invitationId: INVITATION });
    expect(first.body).toEqual({ token: TOKEN });
    expect(second.attempt).toBe(first.attempt);
  });

  it.each([
    ['INVITATION_EXPIRED', 409, 'expired'],
    ['INVITATION_EMAIL_MISMATCH', 403, 'email'],
    ['QUOTA_EXCEEDED', 409, 'quota'],
    ['RESOURCE_NOT_FOUND', 404, 'missing'],
    ['SESSION_EXPIRED', 401, 'session'],
    ['SOMETHING_ELSE', 500, 'other'],
  ])('says in words what the server refused: %s', async (code, status, kind) => {
    const acceptInvitation = vi.fn(() => Promise.reject(new ApiError({ status, code, correlationId: 'c' })));
    mountPage(session({ status: 'identified', acceptInvitation }));
    fireEvent.click(screen.getByTestId('invite-accept'));
    const error = await screen.findByTestId('invite-error');
    expect(error.getAttribute('data-failure')).toBe(kind);
    expect(error.textContent).not.toBe('');
    expect(screen.queryByTestId('invite-done')).toBeNull();
  });

  it('refusalOf treats anything that is not an API error as other', () => {
    expect(refusalOf(new Error('x'))).toBe('other');
  });
});

describe('the route of the accept page', () => {
  it('is outside the shell: no navigation around it', async () => {
    renderApp(PATH, { session: { status: 'identified', acceptInvitation: () => Promise.resolve() } });
    expect(await screen.findByTestId('invite-accept')).toBeTruthy();
    expect(screen.queryByRole('navigation')).toBeNull();
  });
});
