import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { WebRoute } from '../../../routes/types';
import { StateBoundary } from '../../../states/StateBoundary';
import type { ScreenState } from '../../../states/StateBoundary';
import { DeadlineCountdown, StatusPill } from '../../../ui';
import { ScreenFooter, ScreenHead } from '../shared/vnd-ui';
import { vietnamDay } from '../shared/vnd-model';
import { usePortalHome } from './portal-hooks';
import { reconfirmStateLabel, requestClockLabel } from './portal-labels';
import { PORTAL_DESTINATIONS, reconfirmIcon, reconfirmTone, requestClockIcon, requestClockOpen, requestClockTone } from './portal-model';
import type { PortalDestination, ReconfirmState, RequestClock } from './portal-model';
import './portal.css';

/**
 * The layout rules of the contractor portal (design.md has none; these are the portal's own, written once here and held by the screen tests):
 *  1. A contractor sees a reduced frame: its own legal name and tax code as the header, one navigation of the four portal destinations (home, requests, certificates, evaluations and plans), and nothing of the
 *     staff shell: no module menu, no alert bell, no search of other records (`PortalFrame`, chosen by `isPortalCaller`).
 *  2. Every screen says in the same place that only the data of the contractor's own company is shown.
 *  3. The words speak to the contractor in plain language; the portal never shows the words red flag, risk grade, lead, screening or another contractor, and renders from named fields only.
 *  4. A refusal for the area (403, including PORTAL_CONTRACTOR_REQUIRED) is the denied state saying the area is for contractor accounts; it never shows what is behind it.
 *  5. A state is always said in words as well as by colour; a late answer is allowed and labelled as late; a command ends in a receipt with the time.
 */

export interface PortalLayoutProps {
  route: WebRoute;
  active: PortalDestination;
  title: string;
  subtitle: string;
  actions?: ReactNode;
  asOf?: string | undefined;
  stale?: boolean;
  children: ReactNode;
}

/** The frame every portal screen wraps itself in: the header with the contractor, the navigation, the scope line, the head of the screen and the reference line. */
export function PortalLayout({ route, active, title, subtitle, actions, asOf, stale, children }: PortalLayoutProps) {
  const { t } = useTranslation();
  const home = usePortalHome();
  const profile = home.data?.profile;
  return (
    <section data-screen-id={route.id} data-portal="true" aria-labelledby="screen-title" className="portal-screen">
      <div className="portal-identity" data-testid="portal-identity">
        <span className="portal-identity__label">{t('vnp.layout.portal.label')}</span>
        <strong>{profile === undefined ? t('vnp.layout.contractor.pending') : profile.legal_name}</strong>
        {profile !== undefined && <span className="portal-identity__tax">{t('vnp.layout.tax.text', { tax: profile.tax_identifier })}</span>}
      </div>
      <PortalNav active={active} />
      <p className="portal-scope" data-testid="portal-scope">
        {t('vnp.layout.scope.text')}
      </p>
      <ScreenHead title={title} subtitle={subtitle} asOf={asOf} stale={stale === true} actions={actions} />
      {children}
      <ScreenFooter route={route} />
    </section>
  );
}

/** The one navigation of the portal: four destinations, the present one marked. */
export function PortalNav({ active }: { active: PortalDestination | undefined }) {
  const { t } = useTranslation();
  return (
    <nav className="portal-nav" aria-label={t('vnp.layout.nav.label')} data-testid="portal-nav">
      {PORTAL_DESTINATIONS.map((destination) => (
        <Link key={destination.id} to={destination.path} {...(destination.id === active ? { 'aria-current': 'page' as const } : {})}>
          {destinationLabel(t, destination.id)}
        </Link>
      ))}
    </nav>
  );
}

function destinationLabel(t: ReturnType<typeof useTranslation>['t'], id: PortalDestination): string {
  switch (id) {
    case 'VND-16':
      return t('vnp.nav.home.label');
    case 'VND-17':
      return t('vnp.nav.requests.label');
    case 'VND-18':
      return t('vnp.nav.certificates.label');
    case 'VND-19':
      return t('vnp.nav.evaluations.label');
    case 'VND-24':
      return t('po2.nav.files.label');
  }
}

/** The states of a portal screen: the standard cards, and a refusal for the area says the area is for contractor accounts. */
export function PortalBoundary({ state, onRetry, children }: { state: ScreenState; onRetry: () => void; children: ReactNode }) {
  const { t } = useTranslation();
  if (state === 'denied') {
    return (
      <div className="card statecard" role="alert" data-testid="portal-denied">
        <div className="stateicon" aria-hidden="true">
          ⌁
        </div>
        <h2>{t('vnp.denied.title.text')}</h2>
        <p className="muted">{t('vnp.denied.body.text')}</p>
      </div>
    );
  }
  return (
    <StateBoundary state={state} onRetry={onRetry}>
      {children}
    </StateBoundary>
  );
}

/** The clock of a request: its state in words, and while it runs the days left against the day of the answer. */
export function RequestClockCell({ clock, dueAt, asOf }: { clock: RequestClock; dueAt: string; asOf: string }) {
  const { t } = useTranslation();
  return (
    <span className="vnd-stack" data-clock={clock}>
      <StatusPill tone={requestClockTone(clock)} icon={requestClockIcon(clock)}>
        {requestClockLabel(t, clock)}
      </StatusPill>
      {requestClockOpen(clock) && <DeadlineCountdown dueOn={vietnamDay(dueAt)} today={vietnamDay(asOf)} />}
    </span>
  );
}

export function ReconfirmPill({ state }: { state: ReconfirmState }) {
  const { t } = useTranslation();
  return (
    <span data-state={state}>
      <StatusPill tone={reconfirmTone(state)} icon={reconfirmIcon(state)}>
        {reconfirmStateLabel(t, state)}
      </StatusPill>
    </span>
  );
}
