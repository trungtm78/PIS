import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vi_ from '../../i18n/vi.json';
import { ALL_MODULES_VISIBLE } from '../../navigation/model';
import { SessionContext } from '../SessionContext';
import type { SessionValue } from '../SessionContext';
import { SignInGate, withoutFreshMark } from './SignInGate';

function mount(url: string) {
  const signIn = vi.fn(() => Promise.resolve());
  const session = { tenant: undefined, tenants: [], user: undefined, access: ALL_MODULES_VISIBLE, switchTenant: vi.fn(), getSession: () => Promise.resolve(undefined), signIn } as unknown as SessionValue;
  render(
    <SessionContext.Provider value={session}>
      <MemoryRouter initialEntries={[url]}>
        <SignInGate />
      </MemoryRouter>
    </SessionContext.Provider>,
  );
  return signIn;
}

afterEach(cleanup);

describe('the sign-in gate', () => {
  it('waits for the person to choose "Đăng nhập", and does not ask the provider for a new sign-in', async () => {
    const signIn = mount('/prj/prj-01?stage=IMPLEMENTATION');
    expect(signIn).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: vi_['session.oidc.signIn.action'] }));
    expect(signIn).toHaveBeenCalledWith({ returnTo: '/prj/prj-01?stage=IMPLEMENTATION' });
  });

  it('starts a NEW sign-in at once for a person the error page of the provider sent back, once, and lands them where they were going', async () => {
    const signIn = mount('/home/home-01?signin=fresh&tab=2');
    await vi.waitFor(() => expect(signIn).toHaveBeenCalledTimes(1));
    expect(signIn).toHaveBeenCalledWith({ returnTo: '/home/home-01?tab=2', prompt: 'login' });
  });

  it('drops the mark from an address and keeps the rest', () => {
    expect(withoutFreshMark('/', '?signin=fresh')).toBe('/');
    expect(withoutFreshMark('/a', '?x=1&signin=fresh')).toBe('/a?x=1');
    expect(withoutFreshMark('/a', '')).toBe('/a');
  });
});

describe('picking the session up again after a reload', () => {
  const MARK = 'pis.session.resume';

  it('starts the trip to the provider by itself when this tab held a session, once, and shows that it is restoring', async () => {
    window.sessionStorage.clear();
    window.sessionStorage.setItem(MARK, '1');
    const signIn = mount('/prj/prj-01?stage=IMPLEMENTATION');
    await vi.waitFor(() => expect(signIn).toHaveBeenCalledTimes(1));
    expect(signIn).toHaveBeenCalledWith({ returnTo: '/prj/prj-01?stage=IMPLEMENTATION' });
    expect(screen.getByTestId('resuming')).toBeTruthy();
    expect(screen.queryByRole('button', { name: vi_['session.oidc.signIn.action'] })).toBeNull();
  });

  it('does not start a second trip within the cooldown (no loop) and falls back to the button', async () => {
    window.sessionStorage.clear();
    window.sessionStorage.setItem(MARK, '1');
    window.sessionStorage.setItem('pis.session.resume.at', String(Date.now()));
    const signIn = mount('/home/home-01');
    expect(signIn).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: vi_['session.oidc.signIn.action'] })).toBeTruthy();
  });

  it('does nothing in a tab that never held a session, or whose person signed out on purpose', () => {
    window.sessionStorage.clear();
    const signIn = mount('/home/home-01');
    expect(signIn).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: vi_['session.oidc.signIn.action'] })).toBeTruthy();
  });
});
