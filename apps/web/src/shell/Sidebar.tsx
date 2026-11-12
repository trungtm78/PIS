import { useState } from 'react';
import type { KeyboardEvent, RefObject } from 'react';
import { Link } from 'react-router-dom';
import { BrandMark } from '../brand/BrandMark';
import { useTranslation } from '../i18n';
import type { NavLink, NavigationModel } from '../navigation/model';
import type { WebRoute } from '../routes/types';
import type { SessionTenant, SessionUser } from '../session/SessionContext';
import { Icon } from './Icon';
import { labelText } from './labels';
import { TenantSwitcher } from './TenantSwitcher';

export interface SidebarProps {
  navigation: NavigationModel;
  /** The route of the current location; undefined for an address outside the route table. */
  route: WebRoute | undefined;
  tenant: SessionTenant | undefined;
  tenants: readonly SessionTenant[];
  user: SessionUser | undefined;
  favourites: readonly string[];
  /** Unread notifications for the badge next to the notifications link; 0 or undefined shows none. */
  unreadNotifications?: number;
  /** Count badges by destination id (for example the open work of `HOME-02`); 0 or a missing id shows none. */
  counts?: Readonly<Record<string, number>>;
  onManageFavourites(): void;
  routeTitle(id: string): string | undefined;
  routePath(id: string): string | undefined;
  homePath: string;
  accountPath: string;
  tenantChooserPath: string;
  open: boolean;
  /** The drawer is a modal dialog: only true below the drawer breakpoint while it is open. */
  modal: boolean;
  closeButton: RefObject<HTMLButtonElement>;
  onClose(): void;
  onSwitchTenant(tenantId: string): void;
  onOpenLibrary(scope: 'all' | 'admin'): void;
  onOpenDirectory(module: string): void;
}

const NOTIFICATIONS = 'NOT-01';
const OVERVIEW = 'HOME-01';
const TASKS = 'HOME-02';

/**
 * Screens of the HOME module other than the task list belong to the overview: the prototype leaves them without an
 * active item, the application keeps the overview destination active so every page shows where the user is.
 */
function isOverviewChild(link: NavLink, route: WebRoute | undefined): boolean {
  return link.id === OVERVIEW && route !== undefined && route.module === 'HOME' && route.id !== TASKS;
}

/** The module code of a screen id (`DIS-15` is in `DIS`). */
function moduleOf(screen: string): string {
  return screen.split('-')[0] ?? screen;
}

const FOCUSABLE = 'a[href], button:not([disabled]), select:not([disabled])';

function trapTab(event: KeyboardEvent<HTMLElement>): void {
  if (event.key !== 'Tab') return;
  const items = [...event.currentTarget.querySelectorAll<HTMLElement>(FOCUSABLE)];
  const first = items[0];
  const last = items.at(-1);
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last?.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first?.focus();
  }
}

/** The single business sidebar of the prototype: tenant identity, personal links, modules, pinned screens, footer. */
export function Sidebar(props: SidebarProps) {
  const { t } = useTranslation();
  const { navigation, route, tenant, user } = props;
  // Modules whose shortcuts the user opened or closed by hand; the current module is open until the user closes it.
  const [overrides, setOverrides] = useState<ReadonlyMap<string, boolean>>(new Map());
  // An entry of an edition may gather several modules (`covers`): a screen of any of them keeps the entry active and open.
  const owns = (link: NavLink, module: string | undefined): boolean => module !== undefined && (module === link.module || (link.covers?.includes(module) ?? false));
  const isOpen = (link: NavLink): boolean => overrides.get(link.module) ?? owns(link, route?.module);
  const toggle = (link: NavLink): void => setOverrides(new Map(overrides).set(link.module, !isOpen(link)));

  const represented = new Set(['HOME', 'NOT', ...navigation.quick.flatMap((link) => [link.module, ...(link.covers ?? [])])]);
  const moduleLink: NavLink | undefined =
    route === undefined || represented.has(route.module) || !navigation.isModuleVisible(route.module)
      ? undefined
      : {
          id: `${route.module}-01`,
          module: route.module,
          label: { text: navigation.moduleName(route.module) },
          icon: 'grid',
          path: props.routePath(`${route.module}-01`) ?? route.path,
          expandable: true,
        };

  // A pinned screen of a module the session may not open is not offered, whatever was pinned or is pinned by default.
  const pinned = props.favourites.flatMap((id) => {
    const path = props.routePath(id);
    return path === undefined || !navigation.isModuleVisible(moduleOf(id)) ? [] : [{ id, path }];
  });

  const renderLink = (link: NavLink) => {
    const exact = route?.id === link.id;
    const active = link.expandable ? owns(link, route?.module) : exact || isOverviewChild(link, route);
    const open = link.expandable && isOpen(link);
    const label = labelText(t, link.label);
    const shortcuts = navigation.shortcuts.get(link.module) ?? [];
    const count = link.id === NOTIFICATIONS ? (props.unreadNotifications ?? 0) : (props.counts?.[link.id] ?? 0);
    const leaf = route !== undefined && owns(link, route.module) && route.id !== link.id && !shortcuts.some((shortcut) => shortcut.id === route.id) ? route : undefined;
    return (
      <div key={link.id}>
        <div className={`sidebar-destination${active ? ' destination-active' : ''}`}>
          <Link
            to={link.path}
            className="sidebar-link"
            aria-current={exact ? 'page' : undefined}
            onClick={(event) => {
              // Opening the page you are on toggles its shortcuts instead of reloading it, as in the prototype.
              if (link.expandable && exact) {
                event.preventDefault();
                toggle(link);
              }
            }}
          >
            <Icon name={link.icon} />
            <span>{label}</span>
            {count > 0 ? <span className="nav-count">{count}</span> : null}
          </Link>
          {link.expandable ? (
            <button
              type="button"
              className="sidebar-expand"
              aria-label={t('shell.nav.expand.label', { name: label })}
              aria-expanded={open}
              onClick={() => toggle(link)}
            >
              <Icon name="chevron" />
            </button>
          ) : null}
        </div>
        {open ? (
          <div className="sidebar-context">
            {shortcuts.map((shortcut) => (
              <Link key={shortcut.id} to={shortcut.path} aria-current={route?.id === shortcut.id ? 'page' : undefined}>
                <span>{shortcut.label}</span>
              </Link>
            ))}
            {leaf === undefined ? null : (
              <Link className="current-context-leaf" to={leaf.path} aria-current="page">
                <span>{leaf.title}</span>
              </Link>
            )}
            <button type="button" className="all-module-tasks" onClick={() => props.onOpenDirectory(link.module)}>
              {t('shell.nav.allFunctions.action')} <Icon name="chevron" />
            </button>
          </div>
        ) : null}
      </div>
    );
  };

  const modalProps = props.modal ? ({ role: 'dialog', 'aria-modal': true } as const) : {};

  return (
    <aside
      className={`sidebar workspace-sidebar${props.open ? ' drawer-open' : ''}`}
      id="workspace-sidebar"
      onKeyDown={props.open ? trapTab : undefined}
      {...modalProps}
    >
      <div className="sidebar-brand">
        <Link to={props.homePath} className="sidebar-brand-link" aria-label={t('shell.brand.home.label')}>
          <BrandMark className="sidebar-brand-logo" size={34} />
          <span className="sidebar-brand-copy">
            <strong>{t('shell.brand.name.text')}</strong>
          </span>
        </Link>
        <button type="button" className="workspace-drawer-close" ref={props.closeButton} onClick={props.onClose} aria-label={t('shell.nav.close.label')}>
          <Icon name="close" />
        </button>
      </div>
      <div className="tenant-identity workspace-card">
        {/* The name starts with the letters the link shows, so that the visible label is in the accessible name (WCAG 2.5.3). */}
        <Link to={props.homePath} className="tenant-monogram" aria-label={t('shell.tenant.home.label', { monogram: tenant?.monogram ?? '·', name: tenant?.name ?? '' })}>
          {tenant?.monogram ?? '·'}
          <span />
        </Link>
        <Link to={props.tenantChooserPath} className="tenant-name">
          <strong>{tenant?.name ?? t('shell.tenant.signedOut.text')}</strong>
          <span>
            {t('shell.tenant.workspace.text')} <Icon name="chevron" />
          </span>
        </Link>
        <TenantSwitcher tenants={props.tenants} current={tenant} onSwitch={props.onSwitchTenant} />
      </div>
      <nav className="single-sidebar-scroll" aria-label={t('shell.nav.main.label')}>
        <div className="personal-navigation">{navigation.personal.map(renderLink)}</div>
        <section className="sidebar-section">
          <h2>{t('shell.nav.business.heading')}</h2>
          {navigation.quick.map(renderLink)}
          {moduleLink === undefined ? null : renderLink(moduleLink)}
          <button type="button" className="all-applications" onClick={() => props.onOpenLibrary('all')}>
            <Icon name="grid" />
            <span>{t('shell.nav.allApplications.action')}</span>
            <Icon name="chevron" />
          </button>
        </section>
        <section className="sidebar-section favorites-section">
          <h2>
            {t('shell.nav.pinned.heading')}
            <button type="button" className="favorites-manage" onClick={props.onManageFavourites} aria-label={t('shell.nav.pinned.manage.label')}>
              ···
            </button>
          </h2>
          {pinned.length === 0 ? <p className="favorites-empty">{t('shell.nav.pinned.empty')}</p> : null}
          {pinned.map(({ id, path }) => (
            <Link key={id} className="favorite-link" to={path} aria-current={route?.id === id ? 'page' : undefined}>
              <Icon name="pin" />
              <span>{props.routeTitle(id)}</span>
            </Link>
          ))}
        </section>
      </nav>
      <footer className="single-sidebar-footer">
        <button type="button" onClick={() => props.onOpenLibrary('admin')}>
          <Icon name="admin" />
          <span>{t('shell.nav.admin.action')}</span>
          <Icon name="chevron" />
        </button>
        {user === undefined ? null : (
          <Link to={props.accountPath} className="account-link" aria-label={t('shell.account.open.label', { initials: user.initials, name: user.displayName, role: t('shell.account.role.text') })}>
            <span className="account-avatar">{user.initials}</span>{' '}
            <span>
              <strong>{user.displayName}</strong> <small>{t('shell.account.role.text')}</small>
            </span>
            <span aria-hidden="true">···</span>
          </Link>
        )}
      </footer>
    </aside>
  );
}
