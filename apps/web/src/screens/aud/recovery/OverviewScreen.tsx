import { Link } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { ContextBar, DataTable, KpiStrip, KpiTile, SectionCard, StatusPill } from '../../../ui';
import type { DataTableColumn } from '../../../ui';
import '../aud.css';
import { formatVnd } from '../conclusion/model';
import { engagementStatusLabel } from '../labels';
import { ENGAGEMENT_PATH, ENGAGEMENTS_PATH } from '../model';
import type { EngagementStatus } from '../model';
import { RateText } from './components';
import type { WatchedEngagement } from './model';
import { useOverview } from './hooks';
import { RECOVERY_PATH } from './model';

/**
 * AUD-01: the overview of the inspections and audits in the scope of the caller (ST-AUD-004, AUD 8): the engagements being worked, the recommendations still open and overdue, the money
 * recommended and recovered, and the two rates of completion each with their numerator and denominator (BR-AUD-04: a rate shown without them cannot be checked). The watch list names the
 * engagements with the most overdue first. The data are confidential: only engagements whose scope meets a grant of the caller are counted.
 */
export default function OverviewScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The figures belong to one membership: a switch of tenant or of membership starts the screen over.
  return <OverviewContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function OverviewContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { tenant } = useSession();
  const overview = useOverview();
  const state = useScreenState({ isLoading: overview.isLoading, error: overview.error, data: overview.data, isEmpty: (data) => data === undefined });
  const data = overview.data;
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('aud.overview.page.title')}</h1>
          <p>{t('aud.overview.page.subtitle')}</p>
        </div>
        <div className="actions">
          <Link className="ui-button ui-button--outline" to={ENGAGEMENTS_PATH}>
            {t('aud.overview.engagements.link')}
          </Link>
        </div>
      </div>
      <ContextBar items={[{ label: t('w2iss.ctx.scope'), value: tenant?.name ?? t('w2iss.ctx.scope.all') }]} unit={t('w2iss.aud.unit')} />
      <p className="callout" data-testid="confidential-note">
        {t('aud.overview.confidential.note')}
      </p>
      <StateBoundary state={state} onRetry={() => void overview.refetch()}>
        {data === undefined ? null : (
          <>
            <div data-testid="tiles">
              <KpiStrip label={t('w2iss.aud.kpi.label')}>
                <div className="aud-tile" data-testid="tile-engagements">
                  <KpiTile label={t('aud.overview.tile.engagements')} value={String(data.engagementsOngoing + data.engagementsFollowUp)} sub={t('aud.overview.tile.engagements.parts', { ongoing: data.engagementsOngoing, followUp: data.engagementsFollowUp })} />
                </div>
                <div className="aud-tile" data-testid="tile-open">
                  <KpiTile label={t('aud.overview.tile.open')} value={String(data.recommendationsOpen)} />
                </div>
                <div className="aud-tile" data-testid="tile-overdue">
                  <KpiTile label={t('aud.overview.tile.overdue')} value={String(data.recommendationsOverdue)} tone={data.recommendationsOverdue > 0 ? 'danger' : 'default'} />
                </div>
                <div className="aud-tile" data-testid="tile-money">
                  <KpiTile label={t('aud.overview.tile.money')} value={formatVnd(data.amountVnd)} tone="info" sub={t('aud.overview.tile.money.parts', { recovered: formatVnd(data.recoveredVnd), remaining: formatVnd(data.remainingVnd) })} />
                </div>
              </KpiStrip>
            </div>
            <div data-testid="tile-rates">
              <SectionCard title={t('aud.overview.tile.rates')}>
                <dl className="aud-facts">
                  <dt>{t('aud.recovery.rates.money')}</dt>
                  <dd>
                    <RateText rate={data.moneyRate} testId="overview-rate-money" />
                  </dd>
                  <dt>{t('aud.recovery.rates.count')}</dt>
                  <dd>
                    <RateText rate={data.countRate} testId="overview-rate-count" />
                  </dd>
                </dl>
              </SectionCard>
            </div>
            {data.exceptionsOpen > 0 ? (
              <p className="callout warning" role="status" data-testid="exceptions-note">
                {t('aud.overview.exceptions.note', { count: data.exceptionsOpen })}
              </p>
            ) : null}
            <SectionCard title={t('aud.overview.watch.title')} unit={t('w2iss.aud.unit')}>
              {data.engagements.length === 0 ? (
                <p className="muted" data-testid="no-engagements">
                  {t('aud.overview.watch.none')}
                </p>
              ) : (
                <WatchTable engagements={data.engagements} />
              )}
            </SectionCard>
          </>
        )}
      </StateBoundary>
      <p className="prototype-note">{t('aud.overview.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

/** The watch list, the engagements with the most overdue first: a stripe marks the ones with a recommendation that is overdue. */
function WatchTable({ engagements }: { engagements: WatchedEngagement[] }) {
  const { t } = useTranslation();
  const columns: DataTableColumn<WatchedEngagement>[] = [
    {
      key: 'engagement',
      header: t('aud.overview.watch.col.engagement'),
      pinned: true,
      render: (engagement) => (
        <>
          <strong>{engagement.code}</strong>
          <span className="aud-sub">{engagement.title}</span>
        </>
      ),
    },
    { key: 'status', header: t('aud.overview.watch.col.status'), render: (engagement) => <StatusPill tone="info">{engagementStatusLabel(t, engagement.status as EngagementStatus)}</StatusPill> },
    { key: 'open', header: t('aud.overview.watch.col.open'), align: 'right', render: (engagement) => String(engagement.recommendationsOpen) },
    { key: 'overdue', header: t('aud.overview.watch.col.overdue'), align: 'right', render: (engagement) => String(engagement.recommendationsOverdue) },
    { key: 'amount', header: t('aud.overview.watch.col.amount'), align: 'right', render: (engagement) => formatVnd(engagement.amountVnd) },
    { key: 'recovered', header: t('aud.overview.watch.col.recovered'), align: 'right', render: (engagement) => formatVnd(engagement.recoveredVnd) },
    {
      key: 'links',
      header: t('aud.overview.watch.col.links'),
      render: (engagement) => (
        <span className="aud-links">
          <Link to={`${ENGAGEMENT_PATH}?engagement=${engagement.id}`}>{t('aud.overview.watch.open.link')}</Link>
          <Link to={`${RECOVERY_PATH}?engagement=${engagement.id}`}>{t('aud.overview.watch.recovery.link')}</Link>
        </span>
      ),
    },
  ];
  return <DataTable caption={t('w2iss.aud.watch.aria')} columns={columns} rows={engagements} rowKey={(engagement) => engagement.id} rowAttrs={(engagement) => ({ 'data-engagement-id': engagement.id })} severity={(engagement) => (engagement.recommendationsOverdue > 0 ? 'ACTION' : null)} />;
}
