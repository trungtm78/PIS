import { Link } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { kindLabel, statusLabel as paymentStatusLabel } from '../../pay/payment/labels';
import { READ_PERMISSION as PAYMENT_READ, listLink, paymentLink } from '../../pay/payment/model';
import { scopeLabel, statusLabel as settlementStatusLabel } from '../../pay/settlement/labels';
import { READ_PERMISSION as SETTLEMENT_READ, settlementLink } from '../../pay/settlement/model';
import { amountText } from '../model';
import { ViewFrame } from './ViewFrame';
import { useSettlementView, useViewScope } from './hooks';

/**
 * CTR-17: the settlement of a contract and of its project, read-only (ST-CTR-017, CTR section 7). PAY owns the settlement (PAY-15) and the payment requests (PAY-03): it computes the figures,
 * verifies the file and closes it. Here the contract officer follows the settlements that concern the contract (its own and its project's) and the final payment requests, and goes to PAY to act.
 * Every amount is a financial column, which a guest contractor does not see.
 */
export default function SettlementViewScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The view belongs to one membership: a switch of tenant or of membership starts it over.
  return <SettlementContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function SettlementContent({ route }: ScreenProps) {
  const { t, locale } = useTranslation();
  const scope = useViewScope([SETTLEMENT_READ, PAYMENT_READ]);
  const settled = useSettlementView(scope);
  return (
    <ViewFrame
      route={route}
      title={t('ctr.settlementView.page.title')}
      subtitle={t('ctr.settlementView.page.subtitle')}
      module="PAY"
      scope={scope}
      loaded={settled}
      isEmpty={(data) => data.settlements.length === 0 && data.finals.length === 0}
      owners={[
        { id: 'PAY-15', to: settlementLink() },
        { id: 'PAY-01', to: listLink(scope.contractId ?? '') },
      ]}
    >
      {({ data, financial }) => (
        <>
          <article className="card" aria-label={t('ctr.settlementView.settlements.title')}>
            <h2>{t('ctr.settlementView.settlements.title')}</h2>
            {data.settlements.length === 0 ? (
              <p className="sub" data-testid="no-settlements">
                {t('ctr.settlementView.settlements.empty')}
              </p>
            ) : (
              <table className="table" data-testid="settlements">
                <thead>
                  <tr>
                    <th scope="col">{t('ctr.settlementView.column.scope')}</th>
                    <th scope="col">{t('ctr.settlementView.column.year')}</th>
                    <th scope="col" className="ctr-amount">
                      {t('ctr.settlementView.column.revision')}
                    </th>
                    <th scope="col">{t('ctr.settlementView.column.status')}</th>
                    <th scope="col">{t('ctr.settlementView.column.submitted')}</th>
                    <th scope="col">{t('ctr.settlementView.column.due')}</th>
                    <th scope="col">{t('ctr.settlementView.column.closed')}</th>
                    {financial ? (
                      <>
                        <th scope="col" className="ctr-amount">
                          {t('ctr.settlementView.column.settled')}
                        </th>
                        <th scope="col" className="ctr-amount">
                          {t('ctr.settlementView.column.outstanding')}
                        </th>
                        <th scope="col" className="ctr-amount">
                          {t('ctr.settlementView.column.advance')}
                        </th>
                      </>
                    ) : null}
                  </tr>
                </thead>
                <tbody>
                  {data.settlements.map((settlement) => (
                    <tr key={settlement.id} data-settlement={settlement.id}>
                      <td>
                        <Link to={settlementLink(settlement.id)} data-testid="open">
                          {scopeLabel(t, settlement.scope)}
                        </Link>
                      </td>
                      <td data-testid="year">{settlement.fiscalYear ?? '–'}</td>
                      <td className="ctr-amount" data-testid="revision">
                        {settlement.revision}
                      </td>
                      <td data-testid="status">{settlementStatusLabel(t, settlement.status)}</td>
                      <td data-testid="submitted">{settlement.submittedOn ?? '–'}</td>
                      <td data-testid="due">{settlement.verificationDueOn ?? '–'}</td>
                      <td data-testid="closed">{settlement.closedAt === null ? '–' : settlement.closedAt.slice(0, 10)}</td>
                      {financial ? (
                        <>
                          <td className="ctr-amount" data-testid="settled">
                            {amountText(settlement.settledVnd, locale)}
                          </td>
                          <td className="ctr-amount" data-testid="outstanding">
                            {amountText(settlement.outstandingVnd, locale)}
                          </td>
                          <td className="ctr-amount" data-testid="advance">
                            {amountText(settlement.unrecoveredAdvanceVnd, locale)}
                          </td>
                        </>
                      ) : null}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </article>
          <article className="card" aria-label={t('ctr.settlementView.finals.title')}>
            <h2>{t('ctr.settlementView.finals.title')}</h2>
            {data.finals.length === 0 ? (
              <p className="sub" data-testid="no-finals">
                {t('ctr.settlementView.finals.empty')}
              </p>
            ) : (
              <table className="table" data-testid="finals">
                <thead>
                  <tr>
                    <th scope="col">{t('ctr.settlementView.column.request')}</th>
                    <th scope="col">{t('ctr.settlementView.column.kind')}</th>
                    <th scope="col">{t('ctr.settlementView.column.status')}</th>
                    <th scope="col">{t('ctr.settlementView.column.paid')}</th>
                    {financial ? (
                      <>
                        <th scope="col" className="ctr-amount">
                          {t('ctr.settlementView.column.gross')}
                        </th>
                        <th scope="col" className="ctr-amount">
                          {t('ctr.settlementView.column.net')}
                        </th>
                      </>
                    ) : null}
                  </tr>
                </thead>
                <tbody>
                  {data.finals.map((request) => (
                    <tr key={request.id} data-request={request.id}>
                      <td>
                        <Link to={paymentLink(request.id)} data-testid="open-request">
                          {request.requestNo ?? request.id}
                        </Link>
                      </td>
                      <td data-testid="kind">{kindLabel(t, request.requestKind)}</td>
                      <td data-testid="request-status">{paymentStatusLabel(t, request.status)}</td>
                      <td data-testid="paid">{request.treasuryPaidOn ?? '–'}</td>
                      {financial ? (
                        <>
                          <td className="ctr-amount" data-testid="gross">
                            {amountText(request.grossVnd, locale)}
                          </td>
                          <td className="ctr-amount" data-testid="net">
                            {amountText(request.netVnd, locale)}
                          </td>
                        </>
                      ) : null}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </article>
        </>
      )}
    </ViewFrame>
  );
}
