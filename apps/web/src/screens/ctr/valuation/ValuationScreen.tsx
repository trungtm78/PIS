import { useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { usePayment } from '../../pay/payment/hooks';
import { kindLabel, statusLabel } from '../../pay/payment/labels';
import { paymentLink, percentText, signedAmountText } from '../../pay/payment/model';
import { quantityText } from '../measurement/model';
import { BackLink } from '../components';
import '../ctr.css';
import { SectionCard } from '../../../ui';

/**
 * CTR-13: how the amount of a payment request is made up (ST-PAY-002, PAY 3.1). For each line of the accepted work the quantity and the price in force on the day the acceptance was drawn up, the
 * gross, the advance recovered, the retention held and the net; then the tax adjustment, which belongs to the whole request, and the amount asked for. Every figure is the server's and read-only;
 * the lines add up to the header, and a difference would be a defect the database refuses to keep.
 */
export default function ValuationScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The table belongs to one membership: a switch of tenant or of membership starts the screen over.
  return <ValuationContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function ValuationContent({ route }: ScreenProps) {
  const { t, locale } = useTranslation();
  const [search] = useSearchParams();
  const id = search.get('request');
  const payment = usePayment(id);
  const state = useScreenState({ isLoading: payment.isLoading, error: payment.error, data: id === null ? null : payment.data, isEmpty: (data) => data === null });
  const request = payment.data;
  const money = (value: string): string => signedAmountText(value, locale) ?? value;

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      {request === null || request === undefined ? null : <BackLink to={paymentLink(request.id)}>{t('ctr.valuation.back')}</BackLink>}
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('ctr.valuation.title')}</h1>
          <p>{t('ctr.valuation.subtitle')}</p>
        </div>
      </div>
      {id === null ? (
        <p className="callout" role="status" data-testid="no-request">
          {t('ctr.valuation.none')}
        </p>
      ) : (
        <StateBoundary state={state} onRetry={() => void payment.refetch()}>
          {request === null || request === undefined ? null : (
            <SectionCard title={t('ctr.valuation.table')} unit={t('w2pay.ctx.unit')}>
              <p>
                <strong data-testid="request-no">{request.requestNo ?? request.id}</strong> · <span data-testid="contract">{request.contract.code}</span> · {kindLabel(t, request.requestKind)} ·{' '}
                <span data-testid="status">{statusLabel(t, request.status)}</span>
              </p>
              {request.lines.length === 0 ? (
                <p className="sub" data-testid="no-lines">
                  {t('ctr.valuation.empty')}
                </p>
              ) : (
                <table className="table" data-testid="valuation">
                  <thead>
                    <tr>
                      <th scope="col">{t('ctr.valuation.column.item')}</th>
                      <th scope="col" className="ctr-amount">
                        {t('ctr.valuation.column.quantity')}
                      </th>
                      <th scope="col" className="ctr-amount">
                        {t('ctr.valuation.column.price')}
                      </th>
                      <th scope="col" className="ctr-amount">
                        {t('ctr.valuation.column.gross')}
                      </th>
                      <th scope="col" className="ctr-amount">
                        {t('ctr.valuation.column.recovery')}
                      </th>
                      <th scope="col" className="ctr-amount">
                        {t('ctr.valuation.column.retention')}
                      </th>
                      <th scope="col" className="ctr-amount">
                        {t('ctr.valuation.column.net')}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {request.lines.map((line) => (
                      <tr key={line.id} data-line={line.id}>
                        <td>
                          <strong data-testid="item">{line.businessKey}</strong> <small className="sub">{line.description}</small>
                        </td>
                        <td className="ctr-amount" data-testid="quantity">
                          {quantityText(line.quantity, locale)} {line.unitCode}
                        </td>
                        <td className="ctr-amount" data-testid="price">
                          {quantityText(line.unitPrice, locale)}
                        </td>
                        <td className="ctr-amount" data-testid="gross">
                          {money(line.grossVnd)}
                        </td>
                        <td className="ctr-amount" data-testid="recovery">
                          {money(line.advanceRecoveryVnd)}
                        </td>
                        <td className="ctr-amount" data-testid="retention" title={t('ctr.valuation.retentionRate', { pct: percentText(line.retentionPct) })}>
                          {money(line.retentionVnd)}
                        </td>
                        <td className="ctr-amount" data-testid="net">
                          {money(line.netVnd)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr data-testid="totals">
                      <th scope="row" colSpan={3}>
                        {t('ctr.valuation.total')}
                      </th>
                      <td className="ctr-amount" data-testid="total-gross">
                        {money(request.grossVnd)}
                      </td>
                      <td className="ctr-amount" data-testid="total-recovery">
                        {money(request.advanceRecoveryVnd)}
                      </td>
                      <td className="ctr-amount" data-testid="total-retention">
                        {money(request.retentionVnd)}
                      </td>
                      <td />
                    </tr>
                    <tr data-testid="tax-row">
                      <th scope="row" colSpan={6}>
                        {t('ctr.valuation.tax')}
                      </th>
                      <td className="ctr-amount" data-testid="total-tax">
                        {money(request.taxAdjustmentVnd)}
                      </td>
                    </tr>
                    <tr data-testid="requested-row">
                      <th scope="row" colSpan={6}>
                        {t('ctr.valuation.requested')}
                      </th>
                      <td className="ctr-amount">
                        <strong data-testid="total-net">{money(request.netVnd)}</strong>
                      </td>
                    </tr>
                  </tfoot>
                </table>
              )}
              {request.taxAdjustmentBasis === null ? null : (
                <p className="sub" data-testid="tax-basis">
                  {t('ctr.valuation.taxBasis', { basis: request.taxAdjustmentBasis })}
                </p>
              )}
              <p className="sub">{t('ctr.valuation.note')}</p>
            </SectionCard>
          )}
        </StateBoundary>
      )}
      <p className="prototype-note">{t('ctr.valuation.footer', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
