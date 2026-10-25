import { Link } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { usePayments } from '../payment/hooks';
import { kindLabel, statusLabel } from '../payment/labels';
import { paymentLink, signedAmountText } from '../payment/model';
import { BOARD_STATUSES, FORM_CODES, formsLink, standingCount } from './model';
import '../pay.css';

/**
 * PAY-04: the payment requests on their way to the Treasury (ST-PAY-005, PAY 3.3). A request that has been checked waits for its four forms and then for the record that the file was sent; a
 * request that was sent shows the day and the number the Treasury gave it. Each row leads to the forms of the request (PAY-14). The platform follows the file, it does not send it.
 */
export default function BoardScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The board belongs to one membership: a switch of tenant or of membership starts the screen over.
  return <BoardContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function BoardContent({ route }: ScreenProps) {
  const { t, locale } = useTranslation();
  const payments = usePayments({});
  const state = useScreenState({ isLoading: payments.isLoading, error: payments.error, data: payments.data, isEmpty: () => false });
  const onTheWay = (payments.data ?? []).filter((request) => (BOARD_STATUSES as readonly string[]).includes(request.status));
  const money = (value: string): string => signedAmountText(value, locale) ?? value;

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('pay.board.title')}</h1>
          <p>{t('pay.board.subtitle')}</p>
        </div>
      </div>
      <StateBoundary state={state} onRetry={() => void payments.refetch()}>
        <article className="card" aria-label={t('pay.board.title')}>
          {onTheWay.length === 0 ? (
            <p className="sub" data-testid="nothing">
              {t('pay.board.empty')}
            </p>
          ) : (
            <table className="table" data-testid="board">
              <thead>
                <tr>
                  <th scope="col">{t('pay.board.column.no')}</th>
                  <th scope="col">{t('pay.board.column.contract')}</th>
                  <th scope="col">{t('pay.board.column.kind')}</th>
                  <th scope="col" className="pay-amount">
                    {t('pay.board.column.net')}
                  </th>
                  <th scope="col">{t('pay.board.column.status')}</th>
                  <th scope="col" className="pay-amount">
                    {t('pay.board.column.forms')}
                  </th>
                  <th scope="col">{t('pay.board.column.sentOn')}</th>
                  <th scope="col">{t('pay.board.column.ref')}</th>
                </tr>
              </thead>
              <tbody>
                {onTheWay.map((request) => (
                  <tr key={request.id} data-request={request.id} data-status={request.status}>
                    <td>
                      <Link to={formsLink(request.id)} data-testid="open">
                        {request.requestNo ?? request.id}
                      </Link>{' '}
                      <Link to={paymentLink(request.id)} className="sub" data-testid="detail">
                        {t('pay.board.detail')}
                      </Link>
                    </td>
                    <td data-testid="contract">{request.contract.code}</td>
                    <td data-testid="kind">{kindLabel(t, request.requestKind)}</td>
                    <td className="pay-amount" data-testid="net">
                      {money(request.netVnd)}
                    </td>
                    <td>
                      <span className="pay-badge" data-testid="status">
                        {statusLabel(t, request.status)}
                      </span>
                    </td>
                    <td className="pay-amount" data-testid="forms">
                      {t('pay.board.forms', { count: standingCount(request), total: FORM_CODES.length })}
                    </td>
                    <td data-testid="sent-on">{request.treasurySubmittedOn ?? ''}</td>
                    <td data-testid="ref">{request.treasuryRef ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </article>
      </StateBoundary>
      <p className="prototype-note">{t('pay.board.footer', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
