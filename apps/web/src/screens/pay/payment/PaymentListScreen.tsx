import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { useContracts } from '../../ctr/hooks';
import { usePayments } from './hooks';
import { kindLabel, statusLabel } from './labels';
import { STATUSES, canCreate, createLink, paymentLink, signedAmountText } from './model';
import '../pay.css';

/**
 * PAY-01: the payment requests the caller may see (ST-PAY-002, PAY 3.1), the newest first, narrowed by contract and status. The amounts are the server's: the list only shows them. An accountant
 * who may draw a request up is offered the form (PAY-02) for the contract being looked at.
 */
export default function PaymentListScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The list belongs to one membership: a switch of tenant or of membership starts the screen over.
  return <PaymentListContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function PaymentListContent({ route }: ScreenProps) {
  const { t, locale } = useTranslation();
  const { permissions, mode } = useSession();
  const [search, setSearch] = useSearchParams();
  const contractId = search.get('contract');
  const status = search.get('status');
  const payments = usePayments({ contractId, status });
  // The contracts are only the choices of the filter: a reader who may not list them still reads the requests.
  const contracts = useContracts();
  const state = useScreenState({ isLoading: payments.isLoading, error: payments.error, data: payments.data, isEmpty: () => false });
  const money = (value: string): string => signedAmountText(value, locale) ?? value;
  const setFilter = (name: 'contract' | 'status', value: string): void => {
    const next = new URLSearchParams(search);
    if (value === '') next.delete(name);
    else next.set(name, value);
    setSearch(next, { replace: true });
  };

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('pay.payment.list.title')}</h1>
          <p>{t('pay.payment.list.subtitle')}</p>
        </div>
        {canCreate(permissions, mode) ? (
          <Link className="button primary" to={createLink(contractId ?? undefined)} data-testid="create">
            {t('pay.payment.list.create')}
          </Link>
        ) : null}
      </div>
      <article className="card" aria-label={t('pay.payment.list.filter')}>
        <div className="pay-form-grid">
          <label>
            {t('pay.payment.list.contract')}
            <select value={contractId ?? ''} onChange={(event) => setFilter('contract', event.target.value)} data-testid="filter-contract">
              <option value="">{t('pay.payment.list.all')}</option>
              {(contracts.data ?? []).map((contract) => (
                <option key={contract.id} value={contract.id}>
                  {contract.code}
                </option>
              ))}
            </select>
          </label>
          <label>
            {t('pay.payment.list.status')}
            <select value={status ?? ''} onChange={(event) => setFilter('status', event.target.value)} data-testid="filter-status">
              <option value="">{t('pay.payment.list.all')}</option>
              {STATUSES.map((candidate) => (
                <option key={candidate} value={candidate}>
                  {statusLabel(t, candidate)}
                </option>
              ))}
            </select>
          </label>
        </div>
      </article>
      <StateBoundary state={state} onRetry={() => void payments.refetch()}>
        <article className="card" aria-label={t('pay.payment.list.title')}>
          {(payments.data ?? []).length === 0 ? (
            <p className="sub" data-testid="no-payments">
              {t('pay.payment.list.empty')}
            </p>
          ) : (
            <table className="table" data-testid="payments">
              <thead>
                <tr>
                  <th scope="col">{t('pay.payment.column.no')}</th>
                  <th scope="col">{t('pay.payment.column.contract')}</th>
                  <th scope="col">{t('pay.payment.column.kind')}</th>
                  <th scope="col" className="pay-amount">
                    {t('pay.payment.column.gross')}
                  </th>
                  <th scope="col" className="pay-amount">
                    {t('pay.payment.column.net')}
                  </th>
                  <th scope="col">{t('pay.payment.column.status')}</th>
                </tr>
              </thead>
              <tbody>
                {(payments.data ?? []).map((request) => (
                  <tr key={request.id} data-request={request.id} data-status={request.status}>
                    <td>
                      <Link to={paymentLink(request.id)} data-testid="open">
                        {request.requestNo ?? request.id}
                      </Link>
                    </td>
                    <td data-testid="contract">{request.contract.code}</td>
                    <td data-testid="kind">{kindLabel(t, request.requestKind)}</td>
                    <td className="pay-amount" data-testid="gross">
                      {money(request.grossVnd)}
                    </td>
                    <td className="pay-amount" data-testid="net">
                      {money(request.netVnd)}
                    </td>
                    <td>
                      <span className={request.status === 'CANCELLED' || request.status === 'REVERSED' || request.status === 'RETURNED' ? 'pay-badge warning' : 'pay-badge'} data-testid="status">
                        {statusLabel(t, request.status)}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </article>
      </StateBoundary>
      <p className="prototype-note">{t('pay.payment.list.footer', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
