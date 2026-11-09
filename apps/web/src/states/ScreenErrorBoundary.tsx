import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { Link, Outlet, useInRouterContext, useLocation } from 'react-router-dom';
import { useTranslation } from '../i18n';

/** Where the way back leads: the root of the application, which opens the home screen of the signed-in person. */
const HOME_HREF = '/';

/** The way back: a router link inside the router (the session of the page is kept), a plain link outside it (the top of the application). */
export function HomeLink({ className, children }: { className?: string; children: ReactNode }) {
  const inRouter = useInRouterContext();
  return inRouter ? (
    <Link className={className} to={HOME_HREF}>
      {children}
    </Link>
  ) : (
    <a className={className} href={HOME_HREF}>
      {children}
    </a>
  );
}

/**
 * The card of a screen that broke (a render error, or a screen chunk that did not load): the standard error card of the states,
 * with the two ways out: reload (a full load also clears a chunk that failed) and the way back to the home screen.
 */
export function CrashCard() {
  const { t } = useTranslation();
  return (
    <div className="card statecard" role="alert" data-state="crash">
      <div className="stateicon" aria-hidden="true">
        !
      </div>
      <h1>{t('states.crash.title')}</h1>
      <p className="muted">{t('states.crash.body')}</p>
      <p>
        <button type="button" className="primary" onClick={() => window.location.reload()}>
          {t('states.crash.reload')}
        </button>{' '}
        <HomeLink className="ui-button ui-button--outline">{t('states.crash.home')}</HomeLink>
      </p>
    </div>
  );
}

export interface ScreenErrorBoundaryProps {
  children: ReactNode;
  /** A new value clears a caught error (the address of the screen): the person who navigates away from a broken screen gets the next one. */
  resetKey?: string;
  /** Tells the host (a log, a test) about the caught error. */
  onError?: (error: Error, info: ErrorInfo) => void;
}

interface ScreenErrorBoundaryState {
  failed: boolean;
}

/**
 * No screen, route or lazy chunk may leave the page empty: without a boundary React unmounts the whole tree when a render throws and
 * the person sees a white page. This one shows the error card instead and keeps the frame around it.
 */
export class ScreenErrorBoundary extends Component<ScreenErrorBoundaryProps, ScreenErrorBoundaryState> {
  override state: ScreenErrorBoundaryState = { failed: false };
  private lastKey: string | undefined = this.props.resetKey;

  static getDerivedStateFromError(): ScreenErrorBoundaryState {
    return { failed: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    this.props.onError?.(error, info);
    console.error(error);
  }

  override componentDidUpdate(): void {
    if (this.props.resetKey !== this.lastKey) {
      this.lastKey = this.props.resetKey;
      if (this.state.failed) this.setState({ failed: false });
    }
  }

  override render(): ReactNode {
    return this.state.failed ? <CrashCard /> : this.props.children;
  }
}

/** The routed screen of a frame (the shell, the portal frame): a broken screen shows the error card inside the frame, and the next address starts clean. */
export function GuardedOutlet() {
  const location = useLocation();
  return (
    <ScreenErrorBoundary resetKey={`${location.pathname}${location.search}`}>
      <Outlet />
    </ScreenErrorBoundary>
  );
}
