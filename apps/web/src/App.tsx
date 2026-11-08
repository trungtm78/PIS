import { TOKENS } from '@machvon/design-tokens';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { lazy, Suspense, useEffect, useMemo } from 'react';
import type { ReactNode } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { applyBrand } from './editions/brand';
import { editionRoutes } from './editions/edition';
import { useEdition } from './editions/EditionContext';
import { useTranslation } from './i18n';
import { ARCHITECTURE } from './navigation/architecture';
import { resolveScreen, routeById } from './routes/registry';
import { NotFound } from './routes/NotFound';
import { DocumentLink } from './routes/DocumentLink';
import { OpaqueLink } from './routes/OpaqueLink';
import { WEB_ROUTES } from './routes/web-routes';
import type { ScreenLoader, WebRoute } from './routes/types';
import { PwaRoutes } from './pwa/PwaRoutes';
import { PwaSessionGuard } from './pwa/PwaSessionGuard';
import { Shell } from './shell/Shell';
import { oidcConfigFromEnv, oidcRequestedInDevelopment, CALLBACK_PATH } from './session/oidc/config';
import OidcSessionProvider from './session/oidc/OidcSessionProvider';
import { OidcCallback } from './session/oidc/OidcCallback';
import { SignInGate } from './session/oidc/SignInGate';
import { useSession } from './session/SessionContext';
import { StateBoundary } from './states/StateBoundary';
import type { ScreenState } from './states/StateBoundary';
import { PublishedThemeProvider } from './theme/PublishedThemeProvider';

// The public portal (GOV-12, PRJ-34) needs no session and no shell: it is read by anyone, so it is a route of its own outside the shell.
const PublicPortalScreen = lazy(() => import('./screens/gov12/prj/PublicPortalScreen'));
// The page an invited person opens from the email (IAM 3.3): the person has no tenant yet, so it is a route of its own outside the shell; it asks for the sign-in itself.
const AcceptInvitationScreen = lazy(() => import('./screens/iam/AcceptInvitationScreen'));

const HOME = 'HOME-01';
const CHOOSER = 'IAM-04';
const SIGN_IN_SCREENS: ReadonlySet<string> = new Set(['IAM-01', 'IAM-02', 'IAM-03']);

export interface AppRoutesProps {
  /** Screen implementations by id; defaults to the registry. Tests pass their own. */
  screenModules?: Readonly<Record<string, ScreenLoader>>;
}

const DEMO_STATES: readonly ScreenState[] = ['loading', 'empty', 'error', 'denied', 'expired', 'offline'];

/**
 * Development builds only: `?demoState=<state>` forces a state card on the screen so the visual regression can compare
 * every state with the baseline PNGs. `import.meta.env.DEV` is a constant false in production, so the branch, and the
 * query name with it, never reach a production bundle.
 */
function forcedStateOf(search: string): ScreenState | undefined {
  if (!import.meta.env.DEV) return undefined;
  const requested = new URLSearchParams(search).get('demoState');
  return DEMO_STATES.find((state) => state === requested);
}

function ScreenHost({ route, screenModules }: { route: WebRoute; screenModules: AppRoutesProps['screenModules'] }) {
  const session = useSession();
  // The router's location, not window.location: a query-only change inside the same route must show the new state.
  const location = useLocation();
  const demo = forcedStateOf(location.search);
  if (demo !== undefined) {
    // The page frame of the prototype's state cards: title and the module's description above the card.
    return (
      <section>
        <div className="heading">
          <div>
            <h1>{route.title}</h1>
            <p>{ARCHITECTURE.moduleDescriptions[route.module] ?? ''}</p>
          </div>
        </div>
        <StateBoundary state={demo} />
      </section>
    );
  }
  // A real sign-in: nobody is signed in yet (offer the way in), or the person is known but has not chosen a tenant yet. The sign-in screens (IAM-01 to IAM-03) are where such a person goes, so neither stands in front of them.
  if (!SIGN_IN_SCREENS.has(route.id)) {
    if (session.status === 'signedOut' && session.signIn !== undefined) return <SignInGate />;
    if (session.tenant === undefined && route.id !== CHOOSER) {
      if (session.status === 'identified') return <Navigate to={`${routeById(CHOOSER)?.path ?? '/'}?next=${encodeURIComponent(`${location.pathname}${location.search}`)}`} replace />;
      return <StateBoundary state="signedOut" />;
    }
  }
  const Screen = resolveScreen(route.id, screenModules);
  return (
    <Suspense fallback={<StateBoundary state="loading" />}>
      <Screen route={route} />
    </Suspense>
  );
}

/** The route tree: the shell around every screen of the route table, a redirect from the root and the not-found state. */
export function AppRoutes({ screenModules }: AppRoutesProps) {
  const { manifest } = useEdition();
  const routes = useMemo(() => editionRoutes(WEB_ROUTES, manifest), [manifest]);
  return (
    <PublishedThemeProvider base={TOKENS}>
      <Routes>
        <Route element={<Shell />}>
          <Route index element={<Navigate to={routeById(HOME)?.path ?? '/'} replace />} />
          {routes.map((route) => (
            <Route key={route.id} path={route.path} element={<ScreenHost route={route} screenModules={screenModules} />} />
          ))}
          {/* The manager application of the installed PWA (YCK.01): its start page and three screens. */}
          <Route path="/m/*" element={<PwaRoutes />} />
          {/* The link a push carries: it names the notification only (ST-NOT-007). */}
          <Route path="/r/:id" element={<OpaqueLink />} />
          {/* The link a message to a person carries for a file or a record: it names the version of a document only (ST-OMNI-005). */}
          <Route path="/d/:id" element={<DocumentLink />} />
          <Route path="*" element={<NotFound />} />
        </Route>
        <Route
          path="/public/portals/:slug"
          element={
            <Suspense fallback={<StateBoundary state="loading" />}>
              <PublicPortalScreen />
            </Suspense>
          }
        />
        <Route
          path="/invitations/:invitationId/accept"
          element={
            <Suspense fallback={<StateBoundary state="loading" />}>
              <AcceptInvitationScreen />
            </Suspense>
          }
        />
        <Route path={CALLBACK_PATH} element={<OidcCallback />} />
      </Routes>
    </PublishedThemeProvider>
  );
}

// The development session is only imported when the build is a development one: `import.meta.env.DEV` is a
// constant false in production, so the bundler drops the branch and the module never reaches the bundle.
const DevSessionProvider = import.meta.env.DEV ? lazy(() => import('./session/DevSession')) : undefined;

/**
 * The session of the application: real sign-in (OIDC) when an identity provider is configured (in a development build
 * only when asked for with `?session=oidc`), the development session in a development build, nothing otherwise.
 */
function AppSession({ children }: { children: ReactNode }) {
  const oidc = useMemo(() => {
    const config = oidcConfigFromEnv(import.meta.env, window.location.origin);
    return config !== undefined && (!import.meta.env.DEV || oidcRequestedInDevelopment(window.location.search)) ? config : undefined;
  }, []);
  if (oidc !== undefined) {
    return (
      <OidcSessionProvider config={oidc} apiBaseUrl={import.meta.env.VITE_API_BASE_URL ?? ''}>
        {children}
      </OidcSessionProvider>
    );
  }
  if (DevSessionProvider === undefined) return <>{children}</>;
  return (
    <Suspense fallback={null}>
      <DevSessionProvider>{children}</DevSessionProvider>
    </Suspense>
  );
}

const queryClient = new QueryClient();

/** The browser tab title: the application name in the current language (the edition's overlay says it), and the brand of the edition in the head. */
function DocumentTitle() {
  const { t, locale } = useTranslation();
  const { manifest } = useEdition();
  useEffect(() => {
    document.title = t('shell.app.name.title');
    applyBrand(document, manifest);
  }, [t, locale, manifest]);
  return null;
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <DocumentTitle />
      <AppSession>
        <PwaSessionGuard>
          <BrowserRouter>
            <AppRoutes />
          </BrowserRouter>
        </PwaSessionGuard>
      </AppSession>
    </QueryClientProvider>
  );
}
