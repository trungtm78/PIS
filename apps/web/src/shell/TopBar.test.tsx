import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import shellVi from '../i18n/parts/shell.vi.json';
import vi_ from '../i18n/vi.json';
import { mockMatchMedia, renderApp } from '../test/render';

const SEARCH_LABEL = shellVi['shell.search.field.label'];
const ACCOUNT = shellVi['shell.topbar.account.label'].replace('{initials}', 'AN').replace('{name}', 'Nguyễn An');

/** Stands in for IAM-07 so that the test sees the address the quick search opened. */
function WhereAmI() {
  const location = useLocation();
  return <p data-testid="where">{`${location.pathname}${location.search}`}</p>;
}
const SCREENS = { 'IAM-07': () => Promise.resolve({ default: WhereAmI }) };

beforeEach(() => {
  window.localStorage.clear();
  mockMatchMedia(() => false);
});
afterEach(() => cleanup());

describe('the top bar', () => {
  it('has the quick search "Tìm nhanh hồ sơ" and the avatar of the account, under the breadcrumb', () => {
    renderApp('/home/home-01');
    const bar = screen.getByRole('banner');
    expect(within(bar).getByRole('searchbox', { name: SEARCH_LABEL })).toBeInTheDocument();
    expect(within(bar).getByRole('search')).toBeInTheDocument();
    const avatar = within(bar).getByRole('link', { name: ACCOUNT });
    expect(avatar).toHaveAttribute('href', '/iam/iam-05');
    expect(avatar).toHaveTextContent('AN');
    // The module label is gone from the header: only the breadcrumb and the title stand above the content.
    expect(within(bar).getByRole('navigation', { name: vi_['shell.nav.breadcrumb.label'] })).toBeInTheDocument();
  });

  it('opens the search screen with the keyword in the address', async () => {
    renderApp('/home/home-01', { screens: SCREENS });
    await userEvent.type(screen.getByRole('searchbox', { name: SEARCH_LABEL }), 'cầu Bến Thủy{Enter}');
    expect(await screen.findByTestId('where')).toHaveTextContent('/iam/iam-07?q=c%E1%BA%A7u+B%E1%BA%BFn+Th%E1%BB%A7y');
  });

  it('opens the search screen with nothing asked when the keyword is empty', async () => {
    renderApp('/home/home-01', { screens: SCREENS });
    await userEvent.type(screen.getByRole('searchbox', { name: SEARCH_LABEL }), '{Enter}');
    expect(await screen.findByTestId('where')).toHaveTextContent(/^\/iam\/iam-07$/);
  });

  it('has a link to the search screen for the narrow bar, where the box is not drawn', () => {
    renderApp('/home/home-01');
    expect(within(screen.getByRole('banner')).getByRole('link', { name: shellVi['shell.search.link.label'] })).toHaveAttribute('href', '/iam/iam-07');
  });

  it('Ctrl K moves the focus to the search box and keeps the browser from using the shortcut', () => {
    renderApp('/home/home-01');
    const box = screen.getByRole('searchbox', { name: SEARCH_LABEL });
    // jsdom draws no layout: report the box as rendered, as it is on a wide screen.
    box.getClientRects = () => [new DOMRect(0, 0, 100, 20)] as unknown as DOMRectList;
    expect(fireEvent.keyDown(document, { key: 'k', ctrlKey: true })).toBe(false);
    expect(box).toHaveFocus();
  });

  it('Ctrl K opens the search screen when the box is not on screen', async () => {
    renderApp('/home/home-01', { screens: SCREENS });
    fireEvent.keyDown(document, { key: 'k', metaKey: true });
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent(/^\/iam\/iam-07$/));
  });

  it('leaves other key presses alone', () => {
    renderApp('/home/home-01');
    expect(fireEvent.keyDown(document, { key: 'k' })).toBe(true);
    expect(fireEvent.keyDown(document, { key: 'j', ctrlKey: true })).toBe(true);
  });

  it('offers no avatar without a signed-in user', () => {
    renderApp('/home/home-01', { session: { user: undefined } });
    expect(screen.queryByRole('link', { name: ACCOUNT })).toBeNull();
  });
});
