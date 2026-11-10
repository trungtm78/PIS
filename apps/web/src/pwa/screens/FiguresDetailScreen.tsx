import { useQueryClient } from '@tanstack/react-query';
import { ApiError } from '@machvon/api-client';
import { useEdition } from '../../editions/EditionContext';
import { useTranslation } from '../../i18n';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { MetricTile, NewDataBanner, ProblemCard } from '../../screens/home/components';
import { ChangesCard, RagSummaryCard } from '../../screens/home/gov-components';
import { homeRoot, useCommandCenter, useLatestSnapshot } from '../../screens/home/hooks';
import { READ_PERMISSION, amountTiles, describeCommandCenter, hasNewSnapshot, isAuthFailure } from '../../screens/home/model';
import type { CommandCenter } from '../../screens/home/model';
import { clockText, dayText } from '../../screens/home/overview-model';
import { CashFlowCard, Causes, RankingCard } from '../../screens/home/overview-sections';
import { PwaBackLink } from './PwaBackLink';
import '../../screens/dis/dis.css';
import '../../screens/home/home.css';
import './pwa.css';

const BACK_PATH = '/m/dashboard';

/** The failures that this screen answers with a card of its own; every other failure is one of the standard states. */
const OWN_PROBLEMS = new Set(['RESOURCE_NOT_FOUND', 'SNAPSHOT_NOT_FROZEN', 'SCOPE_DENIED', 'METRIC_UNAVAILABLE', 'VALIDATION_FAILED']);
const hasOwnCard = (error: unknown): boolean => error instanceof ApiError && OWN_PROBLEMS.has(error.code);

/**
 * The figures behind the leader dashboard on the phone (PWA-08, YCK.01): the drill-down of HOME-09 as one column. It reads the same snapshot through the same
 * model and the same cards (`getCommandCenter` for the amounts; the ranking, the causes, the cash flow, the changes against the snapshot before and the warning
 * band each read on their own), so a figure here cannot differ from the full screen and a failure of one card never hides the others. The figures belong to the
 * snapshot on the screen: a newer snapshot is offered, not applied.
 */
export default function FiguresDetailScreen() {
  const { t } = useTranslation();
  const { tenant, permissions } = useSession();
  if (permissions !== undefined && !permissions.includes(READ_PERMISSION)) {
    return (
      <section className="pwa-screen" data-screen-id="PWA-08" aria-labelledby="screen-title">
        <PwaBackLink to={BACK_PATH} label={t('pwa2.figures.back.link')} />
        <div className="heading">
          <h1 id="screen-title">{t('pwa2.figures.page.title')}</h1>
        </div>
        <StateBoundary state="denied" />
      </section>
    );
  }
  return <FiguresContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} />;
}

function FiguresContent() {
  const { t } = useTranslation();
  const treasuryBlocks = useEdition().slots?.homeFigures?.treasuryBlocks !== false;
  const { tenant } = useSession();
  const queryClient = useQueryClient();
  const query = useCommandCenter({ snapshotId: '', unitId: '' });
  const own = hasOwnCard(query.error);
  const problem = own ? describeCommandCenter(query.error) : undefined;
  const latest = useLatestSnapshot(query.data !== undefined, '');
  const revoked = isAuthFailure(latest.error) && problem !== 'unitDenied';
  const state = useScreenState({ isLoading: query.isLoading, error: revoked ? latest.error : own ? undefined : query.error, data: own ? undefined : query.data });
  const center: CommandCenter | undefined = revoked || own ? undefined : query.data;
  const refresh = (): void => {
    queryClient.removeQueries({ queryKey: [...homeRoot(tenant?.id), 'center'] });
    void query.refetch();
    void latest.refetch();
  };
  return (
    <section className="pwa-screen" data-screen-id="PWA-08" aria-labelledby="screen-title">
      <PwaBackLink to={BACK_PATH} label={t('pwa2.figures.back.link')} />
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('pwa2.figures.page.title')}</h1>
          <p>{t('pwa2.figures.page.subtitle')}</p>
        </div>
      </div>
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
            <p className="sub" data-testid="figures-context">
              {t('pwa2.figures.context', { day: dayText(center.asOfDate), time: clockText(query.dataUpdatedAt) })}
            </p>
            <section className="card" aria-labelledby="pwa-amounts-title" data-testid="figures-amounts">
              <h2 id="pwa-amounts-title">{t('pwa2.figures.amounts.title')}</h2>
              <div className="pwa-tiles-stack">
                {amountTiles(center).map((tile) => (
                  <MetricTile key={tile.metricCode} tile={tile} />
                ))}
              </div>
              {center.projectsWithoutData > 0 ? <p className="sub">{t('home.footer.withoutData', { count: center.projectsWithoutData })}</p> : null}
            </section>
            {treasuryBlocks ? (
              <div className="pwa-scroll-x" data-testid="figures-ranking">
                <RankingCard />
              </div>
            ) : null}
            <Causes />
            {treasuryBlocks ? <CashFlowCard snapshotId={center.snapshotId} unitId="" year={center.asOfDate.slice(0, 4)} /> : null}
            <ChangesCard snapshotId={center.snapshotId} unitId="" />
            <RagSummaryCard snapshotId={center.snapshotId} unitId="" />
          </>
        )}
      </StateBoundary>
    </section>
  );
}
