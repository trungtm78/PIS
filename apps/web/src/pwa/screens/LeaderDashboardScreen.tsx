import { useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { useAlertSource } from '../../screens/home/alert-source';
import { MetricTile, NewDataBanner, ProblemCard, QualityBadgeLabel } from '../../screens/home/components';
import { homeRoot, useCommandCenter, useLatestSnapshot } from '../../screens/home/hooks';
import { READ_PERMISSION, describeCommandCenter, hasNewSnapshot, isAuthFailure, isStale, ratePair, shortId, waitingOf } from '../../screens/home/model';
import type { CommandCenter, WaitingCounts } from '../../screens/home/model';
import { clockText, dayText } from '../../screens/home/overview-model';
import { Hero, Kpis } from '../../screens/home/overview-sections';
import { vietnamToday } from '../../screens/mne/model';
import { AlertBand, ContextBar } from '../../ui';
import { CommitteeCard } from './CommitteeCard';
import { FunnelCard } from './FunnelCard';
import { PwaBackLink } from './PwaBackLink';
import { ApiError } from '@machvon/api-client';
import '../../screens/dis/dis.css';
import '../../screens/home/home.css';
import './pwa.css';

const START_PATH = '/m';
/** The full command center, where the leader goes for the drill-down the phone does not repeat. */
export const COMMAND_CENTER_PATH = '/home/home-09';

/** The failures that this screen answers with a card of its own; every other failure is one of the standard states. */
const OWN_PROBLEMS = new Set(['RESOURCE_NOT_FOUND', 'SNAPSHOT_NOT_FROZEN', 'SCOPE_DENIED', 'METRIC_UNAVAILABLE', 'VALIDATION_FAILED']);
const hasOwnCard = (error: unknown): boolean => error instanceof ApiError && OWN_PROBLEMS.has(error.code);

/**
 * The leader dashboard on the phone (PWA-03, YCK.01): the HOME command center of the latest frozen snapshot, trimmed to what a leader reads standing up: the
 * context of every figure first, the amount disbursed with its ring, the two rates side by side, the plan and what waits, and "Needs action now". It is the
 * same reading, the same model and the same kit as HOME-09 (`getCommandCenter`), so the figures can never differ from the ones of the full screen. A figure that
 * cannot be given is said so, never shown as 0; the figures belong to the snapshot on the screen, and a newer snapshot is offered, not applied.
 */
export default function LeaderDashboardScreen() {
  const { t } = useTranslation();
  const { tenant, permissions } = useSession();
  if (permissions !== undefined && !permissions.includes(READ_PERMISSION)) {
    // Without the right to read the command center nothing is asked of the server: the card says the scope is hidden and names nothing.
    return (
      <section className="pwa-screen" data-screen-id="PWA-03" aria-labelledby="screen-title">
        <PwaBackLink to={START_PATH} />
        <div className="heading">
          <div>
            <h1 id="screen-title">{t('pwa.dashboard.page.title')}</h1>
          </div>
        </div>
        <StateBoundary state="denied" />
      </section>
    );
  }
  return <DashboardContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} />;
}

function DashboardContent() {
  const { t } = useTranslation();
  const { tenant } = useSession();
  const queryClient = useQueryClient();
  const query = useCommandCenter({ snapshotId: '', unitId: '' });
  const own = hasOwnCard(query.error);
  const problem = own ? describeCommandCenter(query.error) : undefined;
  const latest = useLatestSnapshot(query.data !== undefined, '');
  // A right taken away while the page is open ends what is shown.
  const revoked = isAuthFailure(latest.error) && problem !== 'unitDenied';
  const queryState = useScreenState({ isLoading: query.isLoading, error: revoked ? latest.error : own ? undefined : query.error, data: own ? undefined : query.data });
  const state = queryState;
  const center: CommandCenter | undefined = revoked || own ? undefined : query.data;
  const refresh = (): void => {
    queryClient.removeQueries({ queryKey: [...homeRoot(tenant?.id), 'center'] });
    void query.refetch();
    void latest.refetch();
  };

  return (
    <section className="pwa-screen" data-screen-id="PWA-03" aria-labelledby="screen-title">
      <PwaBackLink to={START_PATH} />
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('pwa.dashboard.page.title')}</h1>
          <p>{t('pwa.dashboard.page.subtitle')}</p>
        </div>
      </div>
      <Context center={center} updatedAt={query.dataUpdatedAt} />
      <NeedsAction />
      <FunnelCard />
      <CommitteeCard />
      {problem !== undefined && !revoked ? <ProblemCard problem={problem} /> : null}
      <StateBoundary
        state={state}
        onRetry={() => {
          void query.refetch();
          void latest.refetch();
        }}
      >
        {center === undefined ? null : (
          <>
            {hasNewSnapshot(center.snapshotId, latest.data?.snapshotId) ? <NewDataBanner onRefresh={refresh} /> : null}
            <Body center={center} waiting={latest.data?.waiting ?? waitingOf(center)} />
          </>
        )}
      </StateBoundary>
    </section>
  );
}

/** The context of every figure, above them: the scope, the year and the closing day, how fresh the snapshot is and how good its data. */
function Context({ center, updatedAt }: { center: CommandCenter | undefined; updatedAt: number }) {
  const { t } = useTranslation();
  const items = [
    { label: t('home.ov.context.scope'), value: center === undefined ? '—' : center.scope.unitId === null ? t('home.ov.context.unitAll', { projects: center.scope.projects }) : t('home.ov.context.unit', { unit: shortId(center.scope.unitId), projects: center.scope.projects }) },
    { label: t('home.ov.context.year'), value: center === undefined ? '—' : center.asOfDate.slice(0, 4) },
    { label: t('home.ov.context.closing'), value: center === undefined ? '—' : dayText(center.asOfDate) },
  ];
  return (
    <div data-testid="pwa-context" className="home-context">
      <ContextBar items={items} unit={t('home.ov.hero.unit')} asOf={center === undefined ? undefined : clockText(updatedAt)} stale={center !== undefined && isStale(center, vietnamToday())} />
      {center === undefined ? null : <QualityBadgeLabel badge={center.qualityBadge} />}
    </div>
  );
}

/** "Needs action now": the same source as the bell, the whole scope for a leader. It is read on its own, so a failure of the figures never hides the work. */
function NeedsAction() {
  const source = useAlertSource('scope');
  return (
    <div data-testid="pwa-band" data-view={source.view}>
      <AlertBand items={source.items} counts={source.counts} max={3} state={source.state} unavailable={source.unavailable} asOf={source.asOf} stale={source.stale} onRetry={source.retry} />
    </div>
  );
}

function Body({ center, waiting }: { center: CommandCenter; waiting: WaitingCounts }) {
  const { t } = useTranslation();
  const pair = ratePair(center);
  return (
    <>
      <Hero center={center} year={center.asOfDate.slice(0, 4)} />
      <section className="card" aria-labelledby="pwa-rates-title" data-testid="pwa-rates">
        <h2 id="pwa-rates-title">{t('home.rates.title')}</h2>
        {pair === undefined ? (
          <p role="alert">{t('home.problem.unavailable')}</p>
        ) : (
          <div className="dis-rate-pair" role="group" aria-label={t('home.rates.aria')}>
            <MetricTile tile={pair.pm} rate="pm" />
            <MetricTile tile={pair.total} rate="total" />
          </div>
        )}
      </section>
      <Kpis center={center} waiting={waiting} />
      <p>
        <Link className="ui-button ui-button--outline pwa-touch" to={COMMAND_CENTER_PATH} data-testid="pwa-full">
          {t('pwa.dashboard.full.link')}
        </Link>
      </p>
    </>
  );
}
