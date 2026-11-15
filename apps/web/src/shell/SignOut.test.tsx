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
