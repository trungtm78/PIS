import { Link } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { instantText } from '../model';
import { useTracking } from './hooks';
import { TRANSACTION_READ_PERMISSION, boardLink, differenceText, vndText } from './model';
import '../pay.css';

/**
 * PAY-09: where each project stands with the Treasury (ST-PAY-007, PAY 3.3). For every project that has anything with the Treasury: the Treasury code (the code of the project, which is what the
 * statements carry), the requests that went to the Treasury and are not yet settled, the requests settled, the payments the Treasury confirmed, how many of those wait to be matched, the
 * differences that wait for a person with the signed sum they hold, and when the Treasury was last heard from. Counted from the rows of PAY when the screen is read.
 */
export default function TrackingScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The table belongs to one membership: a switch of tenant or of membership starts the screen over.
  return <TrackingContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function TrackingContent({ route }: ScreenProps) {
  const { t, locale } = useTranslation();
  const { permissions } = useSession();
  const mayRead = permissions === undefined || permissions.includes(TRANSACTION_READ_PERMISSION);
  const tracking = useTracking(mayRead);
  const state = useScreenState({ isLoading: tracking.isLoading, error: tracking.error, data: tracking.data, isEmpty: () => false });
  const rows = tracking.data ?? [];

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('pay.track.title')}</h1>
          <p>{t('pay.track.subtitle')}</p>
        </div>
      </div>
      {!mayRead ? (
        <p className="callout" role="status" data-testid="no-read">
          {t('pay.track.read.denied')}
        </p>
      ) : (
        <StateBoundary state={state} onRetry={() => void tracking.refetch()}>
          <article className="card" aria-label={t('pay.track.title')}>
            {rows.length === 0 ? (
              <p className="sub" data-testid="nothing">
                {t('pay.track.empty')}
              </p>
            ) : (
              <table className="table" data-testid="tracking">
                <thead>
                  <tr>
                    <th scope="col">{t('pay.track.column.project')}</th>
                    <th scope="col">{t('pay.track.column.code')}</th>
                    <th scope="col" className="pay-amount">
                      {t('pay.track.column.sent')}
                    </th>
                    <th scope="col" className="pay-amount">
                      {t('pay.track.column.settled')}
                    </th>
                    <th scope="col" className="pay-amount">
                      {t('pay.track.column.confirmed')}
                    </th>
                    <th scope="col" className="pay-amount">
                      {t('pay.track.column.unmatched')}
                    </th>
                    <th scope="col" className="pay-amount">
                      {t('pay.track.column.differences')}
                    </th>
                    <th scope="col">{t('pay.track.column.sync')}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.projectId} data-project={row.projectId}>
                      <td data-testid="project">{row.projectName}</td>
                      <td data-testid="code">{row.projectCode}</td>
                      <td className="pay-amount" data-testid="sent">
                        {t('pay.track.count', { count: row.sent.count, amount: vndText(row.sent.amountVnd, locale) })}
                      </td>
                      <td className="pay-amount" data-testid="settled">
                        {t('pay.track.count', { count: row.settled.count, amount: vndText(row.settled.amountVnd, locale) })}
                      </td>
                      <td className="pay-amount" data-testid="confirmed">
                        {t('pay.track.count', { count: row.confirmed.count, amount: vndText(row.confirmed.amountVnd, locale) })}
                      </td>
                      <td className="pay-amount" data-testid="unmatched">
                        {row.unmatched}
                      </td>
                      <td className="pay-amount" data-testid="differences">
                        {row.differences.count === 0 ? (
                          '0'
                        ) : (
                          <Link to={boardLink()}>{t('pay.track.count', { count: row.differences.count, amount: differenceText(row.differences.amountVnd, locale) })}</Link>
                        )}
                      </td>
                      <td data-testid="sync">{row.lastImportAt === null ? t('pay.track.never') : instantText(row.lastImportAt, locale)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </article>
        </StateBoundary>
      )}
      <p className="prototype-note">{t('pay.track.footer', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
