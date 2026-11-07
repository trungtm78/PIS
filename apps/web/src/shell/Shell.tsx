import { useEffect, useMemo, useRef, useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { useTranslation } from '../i18n';
import { ARCHITECTURE } from '../navigation/architecture';
import { buildNavigation } from '../navigation/model';
import { routeById, routeByPath } from '../routes/registry';
import { WEB_ROUTES } from '../routes/web-routes';
import { useUnreadBadge } from '../screens/not/inbox/badge';
import { useSession } from '../session/SessionContext';
import { useAlertCounts } from '../ui/alerts';
import { AppLibrary } from './AppLibrary';
import type { LibraryScope } from './AppLibrary';
import { FavouritesDialog } from './FavouritesDialog';
import { useFavourites } from './favourites';
import { ModuleDirectory } from './ModuleDirectory';
import { Sidebar } from './Sidebar';
import { TopBar } from './TopBar';
import { useFocusFirstInvalid } from './useFocusFirstInvalid';
import { useMediaQuery } from './useMediaQuery';

/** `businessNavigation.mobileDrawerBreakpoint` of design_tokens.json: below it the sidebar is a drawer. */
const DRAWER_QUERY = '(max-width: 980px)';
const HOME = 'HOME-01';
const ACCOUNT = 'IAM-05';
const TENANT_CHOOSER = 'IAM-04';
const HELP = 'IAM-08';
const SEARCH = 'IAM-07';
const TASKS = 'HOME-02';
const FALLBACK_PATH = '/';

const isWebScreen = (id: string): boolean => routeById(id) !== undefined;
const titleOf = (id: string): string | undefined => routeById(id)?.title;
const pathOf = (id: string): string | undefined => routeById(id)?.path;

type Overlay = { kind: 'library'; scope: LibraryScope } | { kind: 'directory'; module: string } | { kind: 'favourites' };

/**
 * The application frame of every screen: business sidebar (a drawer on narrow viewports), top bar with breadcrumb and
 * pin, and the content area where the routed screen renders. The markup follows the prototype's workspace shell so
 * its stylesheets apply unchanged.
 */
export function Shell() {
  useFocusFirstInvalid();
  const { t } = useTranslation();
  const session = useSession();
  const location = useLocation();
  const route = routeByPath(location.pathname);
  const navigation = useMemo(() => buildNavigation(ARCHITECTURE, WEB_ROUTES, session.access), [session.access]);
  const { favourites, toggle, move, isPinned } = useFavourites(isWebScreen);
  const narrow = useMediaQuery(DRAWER_QUERY);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [overlay, setOverlay] = useState<Overlay | undefined>(undefined);
  const menuButton = useRef<HTMLButtonElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);

  const closeDrawer = (): void => {
    setDrawerOpen(false);
    menuButton.current?.focus();
  };

  // A new address closes the drawer; Escape closes it, and opening it moves focus to its close button once. The focus
  // effect depends on the drawer alone: an overlay opened from the drawer (or closed again) must keep the focus it has.
  useEffect(() => setDrawerOpen(false), [location.pathname]);
  useEffect(() => {
    if (drawerOpen) closeButton.current?.focus();
  }, [drawerOpen]);
  useEffect(() => {
    if (!drawerOpen) return undefined;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && overlay === undefined) {
        event.preventDefault();
        closeDrawer();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [drawerOpen, overlay]);

  const crumb = route === undefined ? { module: undefined, title: t('shell.notFound.title') } : navigation.breadcrumb(route);
  const tenantName = session.tenant?.name ?? '';
  // The badge follows the inbox once it is loaded; until then the session's own figure stands.
  const unreadNotifications = useUnreadBadge(session.user?.unreadNotifications);
  // The work waiting for the person is the badge of the task list; it reads the same counts as the alert bell (one query).
  const alertCounts = useAlertCounts('mine');
  const counts = useMemo(() => ({ [TASKS]: alertCounts.data?.counts.total ?? 0 }), [alertCounts.data]);

  return (
    <div className="app workspace-app" id="screen-capture">
      <Sidebar
        navigation={navigation}
        route={route}
        tenant={session.tenant}
        tenants={session.tenants}
        user={session.user}
        favourites={favourites}
        unreadNotifications={unreadNotifications}
        counts={counts}
        onManageFavourites={() => setOverlay({ kind: 'favourites' })}
        routeTitle={titleOf}
        routePath={pathOf}
        homePath={pathOf(HOME) ?? FALLBACK_PATH}
        accountPath={pathOf(ACCOUNT) ?? FALLBACK_PATH}
        tenantChooserPath={pathOf(TENANT_CHOOSER) ?? FALLBACK_PATH}
        open={drawerOpen}
        modal={drawerOpen && narrow}
        closeButton={closeButton}
        onClose={closeDrawer}
        onSwitchTenant={session.switchTenant}
        onOpenLibrary={(scope) => setOverlay({ kind: 'library', scope })}
        onOpenDirectory={(module) => setOverlay({ kind: 'directory', module })}
      />
      <div className="appbody">
        <TopBar
          module={crumb.module}
          title={crumb.title}
          screenId={route?.id}
          pinned={route !== undefined && isPinned(route.id)}
          helpPath={pathOf(HELP)}
          searchPath={pathOf(SEARCH)}
          accountPath={pathOf(ACCOUNT)}
          user={session.user}
          period={String(new Date().getFullYear())}
          drawerOpen={drawerOpen}
          menuButton={menuButton}
          onOpenDrawer={() => setDrawerOpen(true)}
          onOpenModule={() => route !== undefined && setOverlay({ kind: 'directory', module: route.module })}
          onTogglePin={() => route !== undefined && toggle(route.id)}
        />
        <div className="content">
          <Outlet />
        </div>
      </div>
      <button
        type="button"
        className={`workspace-drawer-shade${drawerOpen ? ' visible' : ''}`}
        onClick={closeDrawer}
        aria-label={t('shell.nav.close.label')}
        tabIndex={-1}
      />
      {overlay?.kind === 'library' ? (
        <AppLibrary navigation={navigation} scope={overlay.scope} workspaceName={tenantName} onClose={() => setOverlay(undefined)} />
      ) : null}
      {overlay?.kind === 'favourites' ? (
        <FavouritesDialog favourites={favourites} routeTitle={titleOf} onMove={move} onRemove={toggle} onClose={() => setOverlay(undefined)} />
      ) : null}
      {overlay?.kind === 'directory' ? (
        <ModuleDirectory navigation={navigation} module={overlay.module} onClose={() => setOverlay(undefined)} />
      ) : null}
    </div>
  );
}
