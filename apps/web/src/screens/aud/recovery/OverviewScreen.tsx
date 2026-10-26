import { Link } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import '../aud.css';
import { formatVnd } from '../conclusion/model';
import { engagementStatusLabel } from '../labels';
import { ENGAGEMENT_PATH, ENGAGEMENTS_PATH } from '../model';
import type { EngagementStatus } from '../model';
import { RateText } from './components';
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
          <Link to={ENGAGEMENTS_PATH}>{t('aud.overview.engagements.link')}</Link>
        </div>
      </div>
      <p className="callout" data-testid="confidential-note">
        {t('aud.overview.confidential.note')}
      </p>
      <StateBoundary state={state} onRetry={() => void overview.refetch()}>
        {data === undefined ? null : (
          <>
            <div className="aud-cards" data-testid="tiles">
              <div className="card" data-testid="tile-engagements">
                <h2>{t('aud.overview.tile.engagements')}</h2>
                <p className="aud-figure">{data.engagementsOngoing + data.engagementsFollowUp}</p>
                <p className="sub">{t('aud.overview.tile.engagements.parts', { ongoing: data.engagementsOngoing, followUp: data.engagementsFollowUp })}</p>
              </div>
              <div className="card" data-testid="tile-open">
                <h2>{t('aud.overview.tile.open')}</h2>
                <p className="aud-figure">{data.recommendationsOpen}</p>
              </div>
              <div className="card" data-testid="tile-overdue">
                <h2>{t('aud.overview.tile.overdue')}</h2>
                <p className="aud-figure">{data.recommendationsOverdue}</p>
              </div>
              <div className="card" data-testid="tile-money">
                <h2>{t('aud.overview.tile.money')}</h2>
                <p className="aud-figure">{formatVnd(data.amountVnd)}</p>
                <p className="sub">{t('aud.overview.tile.money.parts', { recovered: formatVnd(data.recoveredVnd), remaining: formatVnd(data.remainingVnd) })}</p>
              </div>
              <div className="card" data-testid="tile-rates">
                <h2>{t('aud.overview.tile.rates')}</h2>
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
              </div>
            </div>
            {data.exceptionsOpen > 0 ? (
              <p className="callout warning" role="status" data-testid="exceptions-note">
                {t('aud.overview.exceptions.note', { count: data.exceptionsOpen })}
              </p>
            ) : null}
            <div className="card">
              <h2>{t('aud.overview.watch.title')}</h2>
              {data.engagements.length === 0 ? (
                <p className="muted" data-testid="no-engagements">
                  {t('aud.overview.watch.none')}
                </p>
              ) : (
                <div className="tablewrap">
                  <table>
                    <thead>
                      <tr>
                        <th>{t('aud.overview.watch.col.engagement')}</th>
                        <th>{t('aud.overview.watch.col.status')}</th>
                        <th>{t('aud.overview.watch.col.open')}</th>
                        <th>{t('aud.overview.watch.col.overdue')}</th>
                        <th>{t('aud.overview.watch.col.amount')}</th>
                        <th>{t('aud.overview.watch.col.recovered')}</th>
                        <th>{t('aud.overview.watch.col.links')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.engagements.map((engagement) => (
                        <tr key={engagement.id} data-engagement-id={engagement.id}>
                          <td>
                            <strong>{engagement.code}</strong>
                            <div className="sub">{engagement.title}</div>
                          </td>
                          <td>
                            <span className="aud-badge">{engagementStatusLabel(t, engagement.status as EngagementStatus)}</span>
                          </td>
                          <td>{engagement.recommendationsOpen}</td>
                          <td>{engagement.recommendationsOverdue}</td>
                          <td>{formatVnd(engagement.amountVnd)}</td>
                          <td>{formatVnd(engagement.recoveredVnd)}</td>
                          <td className="aud-links">
                            <Link to={`${ENGAGEMENT_PATH}?engagement=${engagement.id}`}>{t('aud.overview.watch.open.link')}</Link>
                            <Link to={`${RECOVERY_PATH}?engagement=${engagement.id}`}>{t('aud.overview.watch.recovery.link')}</Link>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </>
        )}
      </StateBoundary>
      <p className="prototype-note">{t('aud.overview.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
