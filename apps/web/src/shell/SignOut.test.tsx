import { cleanup, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { translator } from '../i18n';
import { mockMatchMedia, renderApp } from '../test/render';

const LABEL = translator.t('shell.account.signOut.label', { name: 'Nguyễn An' });

beforeEach(() => {
  window.localStorage.clear();
  mockMatchMedia(() => false);
});
afterEach(() => cleanup());

describe('signing out from the shell', () => {
  it('offers "Đăng xuất" beside the avatar of the top bar and under the account card of the sidebar, and signs out when one is chosen', async () => {
    const signOut = vi.fn();
    renderApp('/home/home-01', { session: { signOut } });
    const inBar = within(screen.getByRole('banner')).getByRole('button', { name: LABEL });
    expect(inBar).toHaveTextContent('Đăng xuất');
    const all = screen.getAllByRole('button', { name: LABEL });
    expect(all).toHaveLength(2);
    // Reachable by the keyboard: a button that takes the focus and answers Enter.
    inBar.focus();
    expect(inBar).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    expect(signOut).toHaveBeenCalledTimes(1);
    await userEvent.click(all.find((button) => button !== inBar) as HTMLElement);
    expect(signOut).toHaveBeenCalledTimes(2);
  });

  it('offers nothing where the session cannot sign out', () => {
    renderApp('/home/home-01');
    expect(screen.queryByRole('button', { name: LABEL })).toBeNull();
  });
});

describe('the role under the name of the person and the control plane', () => {
  const asked = (spy: { mock: { calls: readonly (readonly unknown[])[] } }): boolean => spy.mock.calls.some((call) => String(call[0] instanceof Request ? call[0].url : call[0]).includes('effective-access'));

  it('does not ask the tenant plane for the effective access in a control-plane session (the platform operator has no membership: the answer is 403)', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 403 }));
    renderApp('/home/home-01', { session: { controlPlane: true } });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(asked(spy)).toBe(false);
    spy.mockRestore();
  });

  it('asks it in a session of a tenant', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 403 }));
    renderApp('/home/home-01');
    await vi.waitFor(() => expect(asked(spy)).toBe(true));
    spy.mockRestore();
  });
});
