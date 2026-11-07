import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { DataTable, FilterPanel, StatusPill } from '../../../ui';
import type { DataTableColumn } from '../../../ui';
import { useContracts } from '../../ctr/hooks';
import { ScopeBar, sumAmounts } from '../../ctr/kit';
import { usePayments } from './hooks';
import { kindLabel, statusLabel, statusTone } from './labels';
import { STATUSES, canCreate, createLink, paymentLink, signedAmountText } from './model';
import type { PaymentRequest, PaymentStatus } from './model';
import '../pay.css';

/**
 * PAY-01: the payment requests the caller may see (ST-PAY-002, PAY 3.1), the newest first, narrowed by contract and status. The amounts are the server's: the list only shows them. An accountant
 * who may draw a request up is offered the form (PAY-02) for the contract being looked at. The total row adds up the requests that still stand (not cancelled, not reversed) and says how many.
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
  const [pageIndex, setPageIndex] = useState(0);
  const [pageSize, setPageSize] = useState(20);
  const contractId = search.get('contract');
  const status = search.get('status');
  const payments = usePayments({ contractId, status });
  // The contracts are only the choices of the filter: a reader who may not list them still reads the requests.
  const contracts = useContracts();
  const state = useScreenState({
    isLoading: payments.isLoading,
    error: payments.error,
    data: payments.data,
    isEmpty: () => false,
  });
  const money = (value: string): string => signedAmountText(value, locale) ?? value;
  const setFilter = (name: 'contract' | 'status', value: string): void => {
    const next = new URLSearchParams(search);
    if (value === '') next.delete(name);
    else next.set(name, value);
    setSearch(next, { replace: true });
    setPageIndex(0);
  };
  const changeSize = (size: number): void => {
    setPageSize(size);
    setPageIndex(0);
  };
  const rows = payments.data ?? [];
  const filtered = contractId !== null || status !== null;
  const applied = [contractId, status].filter((value) => value !== null).length;
  const chosenContract = (contracts.data ?? []).find((contract) => contract.id === contractId);
  const from = pageIndex * pageSize + 1;
  const shown = rows.slice(pageIndex * pageSize, (pageIndex + 1) * pageSize);
  const standing = rows.filter((request) => request.status !== 'CANCELLED' && request.status !== 'REVERSED');
  const clear = (): void => {
    setSearch(new URLSearchParams(), { replace: true });
    setPageIndex(0);
  };
  const columns: DataTableColumn<PaymentRequest>[] = [
    {
      key: 'no',
      header: t('pay.payment.column.no'),
      pinned: true,
      render: (request) => (
        <Link to={paymentLink(request.id)} data-testid="open">
          {request.requestNo ?? request.id}
        </Link>
      ),
    },
    {
      key: 'contract',
      header: t('pay.payment.column.contract'),
      render: (request) => <span data-testid="contract">{request.contract.code}</span>,
    },
    {
      key: 'kind',
      header: t('pay.payment.column.kind'),
      render: (request) => <span data-testid="kind">{kindLabel(t, request.requestKind)}</span>,
    },
    {
      key: 'gross',
      header: t('pay.payment.column.gross'),
      align: 'right',
      render: (request) => <span data-testid="gross">{money(request.grossVnd)}</span>,
    },
    {
      key: 'net',
      header: t('pay.payment.column.net'),
      align: 'right',
      render: (request) => <span data-testid="net">{money(request.netVnd)}</span>,
    },
    {
      key: 'status',
      header: t('pay.payment.column.status'),
      render: (request) => (
        <span data-testid="status" data-request={request.id} data-status={request.status}>
          <StatusPill tone={statusTone(request.status)}>{statusLabel(t, request.status)}</StatusPill>
        </span>
      ),
    },
  ];

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('pay.payment.list.title')}</h1>
          <p>{t('pay.payment.list.subtitle')}</p>
        </div>
        {canCreate(permissions, mode) ? (
          <Link className="ui-button ui-button--primary" to={createLink(contractId ?? undefined)} data-testid="create">
            {t('pay.payment.list.create')}
          </Link>
        ) : null}
      </div>
      <ScopeBar
        money
        extra={[
          {
            label: t('w2pay.pay.ctx.contract'),
            value: chosenContract?.code ?? (contractId === null ? t('w2pay.pay.ctx.all') : contractId),
          },
          {
            label: t('w2pay.pay.ctx.status'),
            value: STATUSES.find((candidate) => candidate === status) === undefined ? t('w2pay.pay.ctx.all') : statusLabel(t, status as PaymentStatus),
          },
        ]}
        updatedAt={payments.dataUpdatedAt}
        stale={payments.isRefetchError}
      />
      <FilterPanel applied={applied} unitLabel={t('w2pay.ctx.unit')}>
        <div className="pay-form-grid" role="group" aria-label={t('pay.payment.list.filter')}>
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
      </FilterPanel>
      <StateBoundary state={state} onRetry={() => void payments.refetch()}>
        {rows.length === 0 && !filtered ? (
          <p className="sub" data-testid="no-payments">
            {t('pay.payment.list.empty')}
          </p>
        ) : (
          <div data-testid="payments">
            <DataTable
              caption={t('pay.payment.list.title')}
              columns={columns}
              rows={shown}
              rowKey={(request) => request.id}
              totalsLabel={t('w2pay.pay.list.totals')}
              totals={{
                gross: money(sumAmounts(standing.map((request) => request.grossVnd))),
                net: money(sumAmounts(standing.map((request) => request.netVnd))),
              }}
              emptyKind={filtered ? 'filtered' : 'none'}
              onClearFilters={clear}
              page={{
                from,
                to: from + shown.length - 1,
                total: rows.length,
                size: pageSize,
                index: pageIndex,
                onPage: setPageIndex,
                onSize: changeSize,
              }}
            />
            <p className="sub" data-testid="totals-note">
              {t('w2pay.pay.list.totals.note', {
                standing: standing.length,
                total: rows.length,
              })}
            </p>
          </div>
        )}
      </StateBoundary>
      <p className="prototype-note">{t('pay.payment.list.footer', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
