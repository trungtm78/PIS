import { cleanup, render, screen, within } from '@testing-library/react';
import { createRef } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import shellVi from '../i18n/vi.json';
import vi_ from '../i18n/vi.json';
import { ARCHITECTURE } from '../navigation/architecture';
import { ALL_MODULES_VISIBLE, buildNavigation } from '../navigation/model';
import { routeById } from '../routes/registry';
import { WEB_ROUTES } from '../routes/web-routes';
import { TENANT_A } from '../test/render';
import { Sidebar } from './Sidebar';
import type { SidebarProps } from './Sidebar';

afterEach(() => cleanup());

function sidebar(overrides: Partial<SidebarProps> = {}) {
  const navigation = buildNavigation(ARCHITECTURE, WEB_ROUTES, ALL_MODULES_VISIBLE);
  const props: SidebarProps = {
    navigation,
    route: routeById('HOME-01'),
    tenant: TENANT_A,
    tenants: [TENANT_A],
    user: { displayName: 'Nguyễn An', initials: 'AN' },
    favourites: [],
    onManageFavourites: () => undefined,
    routeTitle: (id) => routeById(id)?.title,
    routePath: (id) => routeById(id)?.path,
    homePath: '/home/home-01',
    accountPath: '/iam/iam-05',
    tenantChooserPath: '/iam/iam-04',
    open: false,
    modal: false,
    closeButton: createRef<HTMLButtonElement>(),
    onClose: () => undefined,
    onSwitchTenant: () => undefined,
    onOpenLibrary: () => undefined,
    onOpenDirectory: () => undefined,
    ...overrides,
  };
  return render(
    <MemoryRouter>
      <Sidebar {...props} />
    </MemoryRouter>,
  );
}

describe('sidebar of "Xanh dầu điều hành"', () => {
  it('shows the product name, then the workspace card with the organisation and the workspace line', () => {
    const { container } = sidebar();
    const brand = container.querySelector('.sidebar-brand') as HTMLElement;
    expect(within(brand).getByRole('link', { name: shellVi['shell.brand.home.label'] })).toHaveAttribute('href', '/home/home-01');
    expect(within(brand).getByText(shellVi['shell.brand.name.text'])).toBeInTheDocument();
    const card = container.querySelector('.tenant-identity.workspace-card') as HTMLElement;
    expect(within(card).getByText(TENANT_A.name)).toBeInTheDocument();
    expect(within(card).getByText(vi_['shell.tenant.workspace.text'])).toBeInTheDocument();
    // The brand comes first, the card second, then the destinations.
    expect(brand.nextElementSibling).toBe(card);
  });

  it('keeps the drawer close button in the brand row so that the drawer can focus it', () => {
    const closeButton = createRef<HTMLButtonElement>();
    const { container } = sidebar({ closeButton, open: true, modal: true });
    const close = within(container.querySelector('.sidebar-brand') as HTMLElement).getByRole('button', { name: vi_['shell.nav.close.label'] });
    expect(closeButton.current).toBe(close);
  });

  it('marks the selected destination with aria-current (the stylesheet draws its 3px bar) and no other', () => {
    sidebar();
    const nav = screen.getByRole('navigation', { name: vi_['shell.nav.main.label'] });
    const current = within(nav).getAllByRole('link').filter((link) => link.getAttribute('aria-current') === 'page');
    expect(current.map((link) => link.textContent)).toEqual([vi_['shell.nav.home.label']]);
    expect(current[0]?.closest('.sidebar-destination')).toHaveClass('destination-active');
  });

  it('shows a count badge on the destinations that have one, and none for 0 or a missing count', () => {
    sidebar({ counts: { 'HOME-02': 7, 'HOME-01': 0 }, unreadNotifications: 2 });
    const nav = screen.getByRole('navigation', { name: vi_['shell.nav.main.label'] });
    const badges = [...nav.querySelectorAll('.nav-count')].map((badge) => ({ text: badge.textContent, link: badge.closest('a')?.textContent }));
    expect(badges).toEqual([
      { text: '7', link: `${vi_['shell.nav.tasks.label']}7` },
      { text: '2', link: `${vi_['shell.nav.notifications.label']}2` },
    ]);
  });
});
