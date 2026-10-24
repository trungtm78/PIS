import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { Citation, Money, OriginBadge } from './components';
import { useAppropriations } from './hooks';
import { levelLabel, originLabel } from './labels';
import { BOOK_PATH, SUPPORT_ORIGINS, groupByOrigin } from './model';
import './cap.css';

/**
 * CAP-14: the capital that is neither assigned by the Prime Minister nor added by the province, the central support and the revenue
 * increase. They are source groups of their own and are never merged into the capital the Prime Minister assigned (CAP 3.1 BR-CAP-11);
 * whether the tenant counts them in a denominator of the disbursement rate is a policy that waits for CXN-03.
 */
export default function SupportRevenueScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  return <SupportContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function SupportContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const book = useAppropriations();
  const groups = useMemo(() => groupByOrigin(book.data ?? [], SUPPORT_ORIGINS), [book.data]);
  const state = useScreenState({ isLoading: book.isLoading, error: book.error, data: groups });

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('cap.support.page.title')}</h1>
          <p>{t('cap.support.page.subtitle')}</p>
        </div>
        <Link className="button" to={BOOK_PATH}>
          {t('cap.support.book.link')}
        </Link>
      </div>
      <StateBoundary state={state} onRetry={() => void book.refetch()}>
        <p className="callout" role="note">
          {t('cap.support.separate.note')}
        </p>
        {groups.map((group) => (
          <div className="card" key={group.origin} data-origin-group={group.origin}>
            <h2>
              <OriginBadge origin={group.origin} /> {originLabel(t, group.origin)}
            </h2>
            <div className="cap-scroll">
              <table className="table cap-table" aria-label={t('cap.support.table.aria', { origin: originLabel(t, group.origin) })}>
                <thead>
                  <tr>
                    <th scope="col">{t('cap.support.column.origin')}</th>
                    <th scope="col">{t('cap.support.column.decision')}</th>
                    <th scope="col">{t('cap.support.column.scope')}</th>
                    <th scope="col" className="cap-number">
                      {t('cap.support.column.amount')}
                    </th>
                    <th scope="col" className="cap-number">
                      {t('cap.support.column.allocated')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {group.lines.map((line) => (
                    <tr key={line.id} data-appropriation-id={line.id}>
                      <th scope="row">{originLabel(t, line.origin)}</th>
                      <td>
                        <Citation line={line} />
                      </td>
                      <td>
                        {levelLabel(t, line.budgetLevel)} · {line.fundSource.businessKey} · {line.planYear}
                      </td>
                      <td className="cap-number">
                        <Money vnd={line.amountVnd} />
                      </td>
                      <td className="cap-number">
                        <Money vnd={line.allocatedTotalVnd} />
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr data-testid={`total-${group.origin}`}>
                    <th scope="row" colSpan={3}>
                      {t('cap.support.total.label')}
                    </th>
                    <td className="cap-number">
                      <Money vnd={group.totals.amountVnd} />
                    </td>
                    <td className="cap-number">
                      <Money vnd={group.totals.allocatedVnd} />
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>
        ))}
      </StateBoundary>
      <p className="prototype-note">{t('cap.support.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
