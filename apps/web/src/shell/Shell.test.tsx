import { act, cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import vi_ from '../i18n/vi.json';
import { mockMatchMedia, renderApp, TENANT_A, TENANT_B } from '../test/render';

const MAIN_NAV = vi_['shell.nav.main.label'];
const accountLabel = vi_['shell.account.open.label'].replace('{initials}', 'AN').replace('{name}', 'Nguyễn An').replace('{role}', vi_['shell.account.role.text']);
const BREADCRUMB = vi_['shell.nav.breadcrumb.label'];

beforeEach(() => {
  window.localStorage.clear();
  mockMatchMedia(() => false);
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe('shell frame', () => {
  it('renders the sidebar group, the breadcrumb and the active item for ADM-01', () => {
    renderApp('/adm/adm-01');
    const sidebar = screen.getByRole('navigation', { name: MAIN_NAV });
    // ADM is not a quick module, so its own link is added under "Nghiệp vụ" and is the current page.
    const current = within(sidebar).getByRole('link', { name: 'Quản trị tổ chức' });
    expect(current).toHaveAttribute('aria-current', 'page');
    expect(within(sidebar).getByRole('heading', { level: 2, name: vi_['shell.nav.business.heading'] })).toBeInTheDocument();
    const breadcrumb = screen.getByRole('navigation', { name: BREADCRUMB });
    expect(within(breadcrumb).getByRole('button', { name: 'Quản trị tổ chức' })).toBeInTheDocument();
    expect(within(breadcrumb).getByText('Cây tổ chức')).toBeInTheDocument();
  });

  it('shows the personal destinations, the quick modules and the tenant identity', () => {
    renderApp('/home/home-01');
    const sidebar = screen.getByRole('navigation', { name: MAIN_NAV });
    for (const name of [vi_['shell.nav.home.label'], vi_['shell.nav.tasks.label'], vi_['shell.nav.notifications.label'], 'Dự án', 'Kế hoạch vốn', 'Giải ngân', 'Thanh toán', 'Nhà thầu', 'BI & báo cáo']) {
      expect(within(sidebar).getByRole('link', { name })).toBeInTheDocument();
    }
    expect(within(sidebar).getByRole('link', { name: vi_['shell.nav.home.label'] })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: `${TENANT_A.monogram}: trang chủ ${TENANT_A.name}` })).toHaveAttribute('href', '/home/home-01');
    expect(screen.getByText(TENANT_A.name, { selector: 'strong' })).toBeInTheDocument();
  });

  it('renders an unimplemented screen with the shell intact', () => {
    renderApp('/home/home-01');
    expect(screen.getByRole('heading', { level: 1, name: 'Tổng quan điều hành' })).toBeInTheDocument();
    expect(screen.getByText(vi_['shell.screen.notImplemented.title'])).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: MAIN_NAV })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: BREADCRUMB })).toBeInTheDocument();
  });

  it('renders the not-found state inside the shell for an address outside the route table', () => {
    renderApp('/nowhere/at-all');
    expect(screen.getByRole('alert')).toHaveTextContent(vi_['shell.notFound.title']);
    expect(screen.getByRole('navigation', { name: MAIN_NAV })).toBeInTheDocument();
    expect(within(screen.getByRole('navigation', { name: BREADCRUMB })).getByText(vi_['shell.notFound.title'])).toBeInTheDocument();
  });

  it('redirects the root address to the home screen', () => {
    renderApp('/');
    expect(screen.getByRole('heading', { level: 1, name: 'Tổng quan điều hành' })).toBeInTheDocument();
  });

  it('shows the signed-out state, not a screen, when nobody is signed in', () => {
    renderApp('/home/home-01', { tenants: [] });
    expect(screen.getByRole('heading', { level: 1, name: vi_['states.signedOut.title'] })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: MAIN_NAV })).toBeInTheDocument();
  });

  it('hides modules the session may not open', () => {
    renderApp('/home/home-01', { session: { access: { isModuleVisible: (code) => code !== 'PAY' } } });
    const sidebar = screen.getByRole('navigation', { name: MAIN_NAV });
    expect(within(sidebar).queryByRole('link', { name: 'Thanh toán' })).toBeNull();
    expect(within(sidebar).getByRole('link', { name: 'Dự án' })).toBeInTheDocument();
  });
});

describe('contextual shortcuts', () => {
  it('opens the shortcuts of the current module, toggles them and lists the whole directory', async () => {
    renderApp('/prj/prj-01');
    const sidebar = screen.getByRole('navigation', { name: MAIN_NAV });
    expect(within(sidebar).getByRole('link', { name: 'Tiến độ & mốc' })).toBeInTheDocument();
    const toggle = within(sidebar).getByRole('button', { name: vi_['shell.nav.expand.label'].replace('{name}', 'Dự án') });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(within(sidebar).queryByRole('link', { name: 'Tiến độ & mốc' })).toBeNull();
    await userEvent.click(toggle);
    expect(within(sidebar).getByRole('link', { name: 'Tiến độ & mốc' })).toBeInTheDocument();

    await userEvent.click(within(sidebar).getByRole('button', { name: vi_['shell.nav.allFunctions.action'] }));
    const directory = screen.getByRole('dialog', { name: 'Quản lý dự án' });
    expect(within(directory).getByRole('link', { name: /Danh sách dự án/i })).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(toggle.ownerDocument.activeElement).not.toBe(document.body);
  });

  it('filters the module directory without diacritics', async () => {
    renderApp('/prj/prj-01');
    await userEvent.click(screen.getByRole('button', { name: vi_['shell.nav.allFunctions.action'] }));
    const directory = screen.getByRole('dialog', { name: 'Quản lý dự án' });
    await userEvent.type(within(directory).getByRole('textbox', { name: vi_['shell.directory.search.label'] }), 'tien do');
    expect(within(directory).getAllByRole('link').every((link) => /tiến độ/i.test(link.textContent ?? ''))).toBe(true);
    await userEvent.clear(within(directory).getByRole('textbox'));
    await userEvent.type(within(directory).getByRole('textbox'), 'zzzz-no-such-function');
    expect(within(directory).getByText(vi_['shell.directory.empty.text'])).toBeVisible();
  });
});

describe('application library', () => {
  it('lists every area, filters by search text and closes with Escape', async () => {
    renderApp('/home/home-01');
    await userEvent.click(screen.getByRole('button', { name: vi_['shell.nav.allApplications.action'] }));
    const library = screen.getByRole('dialog', { name: vi_['shell.library.all.title'] });
    for (const area of ['Điều hành', 'Đầu tư', 'Phân tích', 'Tương tác', 'Dữ liệu', 'Quản trị']) {
      expect(within(library).getByRole('heading', { level: 3, name: area })).toBeInTheDocument();
    }
    await userEvent.type(within(library).getByRole('textbox', { name: vi_['shell.library.search.label'] }), 'cay to chuc');
    expect(within(library).getByRole('status')).toHaveTextContent(/^\d+ kết quả$/);
    expect(within(library).getByRole('link', { name: /Cây tổ chức/ })).toHaveAttribute('href', '/adm/adm-01');
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('shows the empty message when nothing matches', async () => {
    renderApp('/home/home-01');
    await userEvent.click(screen.getByRole('button', { name: vi_['shell.nav.allApplications.action'] }));
    await userEvent.type(screen.getByRole('textbox', { name: vi_['shell.library.search.label'] }), 'zzzz-no-such-thing');
    expect(screen.getByText(vi_['shell.library.results.empty'])).toBeInTheDocument();
  });

  it('opens the administration library from the footer with only administration modules', async () => {
    renderApp('/home/home-01');
    await userEvent.click(screen.getByRole('button', { name: vi_['shell.nav.admin.action'] }));
    const library = screen.getByRole('dialog', { name: vi_['shell.library.admin.title'] });
    expect(within(library).getByRole('link', { name: /Quản trị tổ chức/ })).toBeInTheDocument();
    expect(within(library).queryByRole('link', { name: /Quản lý dự án/ })).toBeNull();
  });

  it('follows a link, closes the dialog and shows the screen', async () => {
    renderApp('/home/home-01');
    await userEvent.click(screen.getByRole('button', { name: vi_['shell.nav.allApplications.action'] }));
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('link', { name: /Quản trị tổ chức/ }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('heading', { level: 1, name: 'Cây tổ chức' })).toBeInTheDocument();
  });
});

describe('pinned screens', () => {
  it('pins and unpins the current screen and shows it in the sidebar', async () => {
    renderApp('/adm/adm-01');
    const pin = screen.getByRole('button', { name: vi_['shell.nav.pin.label'] });
    expect(pin).toHaveAttribute('aria-pressed', 'false');
    await userEvent.click(pin);
    expect(screen.getByRole('button', { name: vi_['shell.nav.unpin.label'] })).toHaveAttribute('aria-pressed', 'true');
    const sidebar = screen.getByRole('navigation', { name: MAIN_NAV });
    expect(within(sidebar).getAllByRole('link', { name: 'Cây tổ chức' }).length).toBeGreaterThan(0);
    expect(JSON.parse(window.localStorage.getItem('investment-favorites') ?? '[]')).toContain('ADM-01');
    await userEvent.click(screen.getByRole('button', { name: vi_['shell.nav.unpin.label'] }));
    expect(JSON.parse(window.localStorage.getItem('investment-favorites') ?? '[]')).not.toContain('ADM-01');
  });

  it('shows the hint when nothing is pinned', async () => {
    window.localStorage.setItem('investment-favorites', '[]');
    renderApp('/adm/adm-01');
    expect(screen.getByText(vi_['shell.nav.pinned.empty'])).toBeInTheDocument();
  });
});

describe('drawer on a narrow viewport', () => {
  it('opens as a modal dialog, closes with Escape and returns focus to the menu button', async () => {
    mockMatchMedia((query) => query.includes('980'));
    renderApp('/home/home-01');
    const toggle = screen.getByRole('button', { name: vi_['shell.nav.open.label'] });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).toHaveAttribute('aria-controls', 'workspace-sidebar');
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const sidebar = document.getElementById('workspace-sidebar');
    expect(sidebar).toHaveClass('drawer-open');
    expect(sidebar).toHaveAttribute('role', 'dialog');
    expect(sidebar).toHaveAttribute('aria-modal', 'true');
    expect(document.activeElement).toHaveClass('workspace-drawer-close');
    await userEvent.keyboard('{Escape}');
    expect(sidebar).not.toHaveClass('drawer-open');
    expect(sidebar).not.toHaveAttribute('role');
    expect(document.activeElement).toBe(toggle);
  });

  it('closes from the shade and keeps focus inside the open drawer when tabbing', async () => {
    mockMatchMedia((query) => query.includes('980'));
    renderApp('/home/home-01');
    await userEvent.click(screen.getByRole('button', { name: vi_['shell.nav.open.label'] }));
    const sidebar = document.getElementById('workspace-sidebar') as HTMLElement;
    const focusable = [...sidebar.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), select')];
    focusable.at(-1)?.focus();
    await userEvent.tab();
    expect(sidebar.contains(document.activeElement)).toBe(true);
    await userEvent.tab({ shift: true });
    expect(sidebar.contains(document.activeElement)).toBe(true);
    const shade = document.querySelector<HTMLElement>('.workspace-drawer-shade') as HTMLElement;
    await userEvent.click(shade);
    expect(sidebar).not.toHaveClass('drawer-open');
  });

  it('keeps focus in the application library opened from the drawer, and returns it to the opener when the library closes', async () => {
    mockMatchMedia((query) => query.includes('980'));
    renderApp('/home/home-01');
    await userEvent.click(screen.getByRole('button', { name: vi_['shell.nav.open.label'] }));
    const opener = within(document.getElementById('workspace-sidebar') as HTMLElement).getByRole('button', { name: new RegExp(vi_['shell.nav.allApplications.action']) });
    await userEvent.click(opener);
    const dialog = await screen.findByRole('dialog', { name: vi_['shell.library.all.title'] });
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toHaveClass('workspace-drawer-close');
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: vi_['shell.library.all.title'] })).toBeNull());
    expect(document.activeElement).toBe(opener);
    expect(document.activeElement).not.toHaveClass('workspace-drawer-close');
  });

  it('does not make the sidebar a dialog on a wide viewport', async () => {
    renderApp('/home/home-01');
    await userEvent.click(screen.getByRole('button', { name: vi_['shell.nav.open.label'] }));
    expect(document.getElementById('workspace-sidebar')).not.toHaveAttribute('role', 'dialog');
  });
});

describe('tenant switch (AC-ST-KERNEL-031-3)', () => {
  const FORM_SCREENS = {
    'HOME-01': () =>
      Promise.resolve({
        default: function Form() {
          return <input aria-label="Ghi chú nháp" />;
        },
      }),
  };

  it('changes the theme id and version while breadcrumb, form value and sidebar position stay', async () => {
    const { container } = renderApp('/home/home-01', { screens: FORM_SCREENS });
    const field = await screen.findByLabelText('Ghi chú nháp');
    await userEvent.type(field, 'bản nháp');
    const nav = container.querySelector('.single-sidebar-scroll') as HTMLElement;
    Object.defineProperty(nav, 'scrollTop', { value: 120, writable: true });
    const crumbBefore = screen.getByRole('navigation', { name: BREADCRUMB }).textContent;
    const theme = () => container.querySelector('[data-mv-tenant-theme]') as HTMLElement;
    expect(theme()).toHaveAttribute('data-mv-theme-id', 'theme-a');
    expect(theme()).toHaveAttribute('data-mv-theme-version', '3');

    await userEvent.selectOptions(screen.getByRole('combobox', { name: vi_['shell.tenant.switch.label'] }), TENANT_B.id);

    expect(theme()).toHaveAttribute('data-mv-theme-id', 'theme-b');
    expect(theme()).toHaveAttribute('data-mv-theme-version', '9');
    expect(screen.getByText(TENANT_B.name, { selector: 'strong' })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: BREADCRUMB }).textContent).toBe(crumbBefore);
    expect(screen.getByLabelText('Ghi chú nháp')).toHaveValue('bản nháp');
    expect(container.querySelector('.single-sidebar-scroll')).toBe(nav);
    expect(nav.scrollTop).toBe(120);
  });

  it('keeps the previous theme and shows the notice when a tenant overlay is rejected', async () => {
    const bad = { ...TENANT_B, theme: { themeId: 'theme-bad', version: 1, overlay: { primary: '#CCCCCC', primaryText: '#FFFFFF' } } };
    const { container } = renderApp('/home/home-01', { tenants: [TENANT_A, bad] });
    await userEvent.selectOptions(screen.getByRole('combobox', { name: vi_['shell.tenant.switch.label'] }), bad.id);
    expect(container.querySelector('[data-mv-tenant-theme]')).toHaveAttribute('data-mv-theme-id', 'theme-a');
    expect(screen.getByText(vi_['theme.overlay.rejected'])).toBeInTheDocument();
  });

  it('offers no switch for a single tenant', () => {
    renderApp('/home/home-01', { tenants: [TENANT_A] });
    expect(screen.queryByRole('combobox', { name: vi_['shell.tenant.switch.label'] })).toBeNull();
  });
});

describe('help and account', () => {
  it('links the help and account destinations', async () => {
    renderApp('/home/home-01');
    expect(screen.getByRole('link', { name: vi_['shell.nav.help.label'] })).toHaveAttribute('href', '/iam/iam-08');
    const account = screen.getByRole('link', { name: accountLabel });
    expect(account).toHaveAttribute('href', '/iam/iam-05');
    expect(within(account).getByText('Nguyễn An')).toBeInTheDocument();
    await act(async () => undefined);
    await waitFor(() => expect(screen.getByRole('navigation', { name: MAIN_NAV })).toBeInTheDocument());
  });
});
