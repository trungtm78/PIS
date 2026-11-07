import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { Translator } from '../../i18n';
import { useSession } from '../../session/SessionContext';
import { StatusPill } from '../../ui';
import { needsManualInstall } from '../install';
import { usePwaState, pwaStore } from '../pwa-state';
import { browserPushDeps, usePushControl } from '../usePushControl';
import type { PushControlDeps, PushControlState } from '../usePushControl';
import { READ_PERMISSION } from './approval-model';
import { useApprovalQueue } from './approval-hooks';
import './pwa.css';

export const APPROVALS_PATH = '/m/approvals';
export const DASHBOARD_PATH = '/m/dashboard';
export const DIRECTIVES_PATH = '/m/directives';

type T = Translator['t'];

function pushText(t: T, state: PushControlState): string {
  switch (state) {
    case 'checking':
      return t('pwa.push.state.checking');
    case 'unsupported':
      return t('pwa.push.state.unsupported');
    case 'unconfigured':
      return t('pwa.push.state.unconfigured');
    case 'blocked':
      return t('pwa.push.state.blocked');
    case 'off':
      return t('pwa.push.state.off');
    case 'on':
      return t('pwa.push.state.on');
    case 'working':
      return t('pwa.push.state.working');
    case 'failed':
      return t('pwa.push.state.failed');
  }
}

export interface PwaStartScreenProps {
  /** Tests pass their own; the page uses the browser's. */
  pushDeps?: PushControlDeps;
  /** Tests pass their own; the page reads the user agent. */
  manualInstall?: boolean;
}

/**
 * The start page of the manager application (PWA-01, YCK.01): the page the installed application opens (`start_url` of the manifest). Three entries, each
 * a screen of its own (the approval queue, the leader dashboard, the directive tracking), then what the person needs to make the page an application:
 * install it and turn on the notifications. A notification carries a generic title and a link, never a figure or a name, so the page tells that too.
 */
export default function PwaStartScreen({ pushDeps, manualInstall }: PwaStartScreenProps) {
  const { t } = useTranslation();
  const { permissions } = useSession();
  const mayRead = permissions === undefined || permissions.includes(READ_PERMISSION);
  const queue = useApprovalQueue(mayRead);
  const pending = queue.data?.length;
  const late = queue.data?.filter((task) => task.overdue).length ?? 0;

  return (
    <section className="pwa-screen" data-screen-id="PWA-01" aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('pwa.start.page.title')}</h1>
          <p>{t('pwa.start.page.subtitle')}</p>
        </div>
      </div>
      <nav aria-label={t('pwa.start.entries.aria')}>
        <ul className="pwa-entries">
          <li>
            <Link to={APPROVALS_PATH} className="pwa-entry pwa-touch" data-entry="approvals">
              <span className="pwa-entry-title">{t('pwa.start.approvals.title')}</span>
              <span className="pwa-entry-body">{t('pwa.start.approvals.body')}</span>
              {pending === undefined ? null : (
                <span className="pwa-entry-count" data-testid="approvals-count">
                  <StatusPill tone={late > 0 ? 'danger' : pending > 0 ? 'warning' : 'success'}>{late > 0 ? t('pwa.start.approvals.countLate', { open: pending, late }) : t('pwa.start.approvals.count', { open: pending })}</StatusPill>
                </span>
              )}
            </Link>
          </li>
          <li>
            <Link to={DASHBOARD_PATH} className="pwa-entry pwa-touch" data-entry="dashboard">
              <span className="pwa-entry-title">{t('pwa.start.dashboard.title')}</span>
              <span className="pwa-entry-body">{t('pwa.start.dashboard.body')}</span>
            </Link>
          </li>
          <li>
            <Link to={DIRECTIVES_PATH} className="pwa-entry pwa-touch" data-entry="directives">
              <span className="pwa-entry-title">{t('pwa.start.directives.title')}</span>
              <span className="pwa-entry-body">{t('pwa.start.directives.body')}</span>
            </Link>
          </li>
        </ul>
      </nav>
      <InstallCard manualInstall={manualInstall} />
      <PushCard pushDeps={pushDeps} />
    </section>
  );
}

function InstallCard({ manualInstall }: { manualInstall: boolean | undefined }) {
  const { t } = useTranslation();
  const state = usePwaState();
  const manual = manualInstall ?? (typeof navigator !== 'undefined' && needsManualInstall(navigator.userAgent, navigator.maxTouchPoints));
  const secure = typeof window === 'undefined' || window.isSecureContext;
  return (
    <section className="card pwa-card-panel" aria-labelledby="pwa-install-title" data-testid="install-card">
      <h2 id="pwa-install-title">{t('pwa.install.card.title')}</h2>
      {state.installed ? (
        <p role="status" data-testid="install-state" data-state="installed">
          {t('pwa.install.state.installed')}
        </p>
      ) : !secure ? (
        <p role="alert" data-testid="install-state" data-state="insecure">
          {t('pwa.install.state.insecure')}
        </p>
      ) : state.canInstall ? (
        <>
          <p data-testid="install-state" data-state="available">
            {t('pwa.install.state.available')}
          </p>
          <button type="button" className="ui-button ui-button--primary pwa-touch" data-action="install" onClick={() => void pwaStore.promptInstall()}>
            {t('pwa.install.action.install')}
          </button>
        </>
      ) : manual ? (
        <>
          <p data-testid="install-state" data-state="manual">
            {t('pwa.install.state.manual')}
          </p>
          <ol className="pwa-steps">
            <li>{t('pwa.install.manual.step1')}</li>
            <li>{t('pwa.install.manual.step2')}</li>
            <li>{t('pwa.install.manual.step3')}</li>
          </ol>
        </>
      ) : (
        <p data-testid="install-state" data-state="menu">
          {t('pwa.install.state.menu')}
        </p>
      )}
    </section>
  );
}

function PushCard({ pushDeps }: { pushDeps: PushControlDeps | undefined }) {
  const { t } = useTranslation();
  const deps = useMemo(() => pushDeps ?? browserPushDeps(), [pushDeps]);
  const push = usePushControl(deps);
  return (
    <section className="card pwa-card-panel" aria-labelledby="pwa-push-title" data-testid="push-card">
      <h2 id="pwa-push-title">{t('pwa.push.card.title')}</h2>
      <p>{t('pwa.push.card.privacy')}</p>
      <p role="status" data-testid="push-state" data-state={push.state}>
        {pushText(t, push.state)}
      </p>
      {push.state === 'off' || push.state === 'failed' ? (
        <button type="button" className="ui-button ui-button--primary pwa-touch" data-action="enable-push" onClick={() => void push.enable()}>
          {t('pwa.push.action.enable')}
        </button>
      ) : null}
      {push.state === 'on' ? (
        <button type="button" className="ui-button ui-button--outline pwa-touch" data-action="disable-push" onClick={() => void push.disable()}>
          {t('pwa.push.action.disable')}
        </button>
      ) : null}
    </section>
  );
}
