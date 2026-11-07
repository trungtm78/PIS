import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { DataTable, FilterPanel, KpiStrip, KpiTile, SectionCard, StatusPill } from '../../../ui';
import type { DataTableColumn, Tone } from '../../../ui';
import { ScopeBar } from '../../ctr/kit';
import { usePayments } from '../payment/hooks';
import { paymentLink } from '../payment/model';
import { instantText } from '../model';
import { MatchDialog } from './ReconDialogs';
import { useItems, useTransactions } from './hooks';
import { itemStatusLabel, kindLabel } from './labels';
import { ITEM_STATUSES, MATCH_PERMISSION, READ_PERMISSION, REQUEST_READ_PERMISSION, TRANSACTION_READ_PERMISSION, differenceText, itemLink, unmatchedTransactions, vndText } from './model';
import type { ItemStatus, ReconItem, Settlement, Transaction } from './model';
import '../pay.css';

/** The first characters of a hash, enough to tell two files apart on a row. */
const SHORT_HASH = 16;

/** The word of an item of difference carries its tone: what is open is a warning, what was explained is info, what is settled is success. */
function itemTone(status: ItemStatus): Tone {
  return status === 'RESOLVED' ? 'success' : status === 'EXPLAINED' ? 'info' : status === 'OPEN' ? 'warning' : 'neutral';
}

/**
 * PAY-05: matching the Treasury's transactions to payments and the differences that wait (ST-PAY-007, PAY 3.3 steps 4 and 5). The transactions that no request has taken wait on one side, each with
 * the button to match it; on the other, the items of difference, the ones due first, each with the figure the request says, the figure the Treasury confirmed, the difference between them (signed,
 * never rounded towards the larger), the file the figure came from with its hash, the owner and the day it is due. An item past its day says so in words.
 */
export default function BoardScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The board belongs to one membership: a switch of tenant or of membership starts the screen over.
  return <BoardContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function BoardContent({ route }: ScreenProps) {
  const { t, locale } = useTranslation();
  const { permissions, mode } = useSession();
  const holds = (permission: string): boolean => permissions === undefined || permissions.includes(permission);
  const mayRead = holds(READ_PERMISSION);
  const mayReadTransactions = holds(TRANSACTION_READ_PERMISSION);
  const mayMatch = holds(MATCH_PERMISSION) && mode !== 'READ_ONLY';
  const [status, setStatus] = useState('');
  const items = useItems({ status }, mayRead);
  const transactions = useTransactions(mayReadTransactions);
  const requests = usePayments({ status: 'SENT_TREASURY' }, mayMatch && holds(REQUEST_READ_PERMISSION));
  const [matching, setMatching] = useState<Transaction | undefined>(undefined);
  const [done, setDone] = useState<string | undefined>(undefined);
  const state = useScreenState({ isLoading: items.isLoading, error: items.error, data: items.data, isEmpty: () => false });
  const waiting = unmatchedTransactions(transactions.data ?? []);
  const summary = items.data?.summary;
  const rows = items.data?.items ?? [];

  const matched = (settlement: Settlement | undefined): void => {
    setDone(settlement === undefined ? t('pay.recon.done.matched') : t('pay.recon.done.settled', { day: settlement.treasuryPaidOn }));
    setMatching(undefined);
  };

  const pendingColumns: DataTableColumn<Transaction>[] = [
    {
      key: 'voucher',
      header: t('pay.recon.pending.column.voucher'),
      pinned: true,
      render: (transaction) => (
        <span data-testid="voucher">
          {transaction.documentNo ?? transaction.id}
        </span>
      ),
    },
    { key: 'project', header: t('pay.recon.pending.column.project'), render: (transaction) => <span data-testid="project">{transaction.projectCode}</span> },
    { key: 'amount', header: t('pay.recon.pending.column.amount'), align: 'right', render: (transaction) => <span data-testid="amount">{vndText(transaction.amountVnd, locale)}</span> },
    { key: 'confirmedAt', header: t('pay.recon.pending.column.confirmedAt'), render: (transaction) => <span data-testid="confirmed-at">{instantText(transaction.confirmedAt, locale)}</span> },
    {
      key: 'actions',
      header: t('pay.recon.column.actions'),
      render: (transaction) =>
        mayMatch ? (
          <button type="button" className="ui-button ui-button--outline ui-button--small" data-action="match" onClick={() => setMatching(transaction)}>
            {t('pay.recon.action.match')}
          </button>
        ) : null,
    },
  ];
  const figures = t('w2pay.pay.recon.group.figures');
  const itemColumns: DataTableColumn<ReconItem>[] = [
    {
      key: 'kind',
      header: t('pay.recon.column.kind'),
      pinned: true,
      render: (item) => (
        <span data-testid="kind" data-item={item.id} data-status={item.status} data-overdue={item.overdue ? 'yes' : 'no'}>
          {kindLabel(t, item.kind)}
        </span>
      ),
    },
    {
      key: 'request',
      header: t('pay.recon.column.request'),
      render: (item) => <span data-testid="request">{item.paymentRequestId === null ? '' : <Link to={paymentLink(item.paymentRequestId)}>{item.requestNo ?? item.paymentRequestId}</Link>}</span>,
    },
    { key: 'voucher', header: t('pay.recon.column.voucher'), render: (item) => <span data-testid="voucher">{item.documentNo ?? ''}</span> },
    { key: 'internal', header: t('pay.recon.column.internal'), group: figures, align: 'right', render: (item) => <span data-testid="internal">{item.internalVnd === null ? '' : vndText(item.internalVnd, locale)}</span> },
    { key: 'confirmed', header: t('pay.recon.column.confirmed'), group: figures, align: 'right', render: (item) => <span data-testid="confirmed">{item.confirmedVnd === null ? '' : vndText(item.confirmedVnd, locale)}</span> },
    { key: 'difference', header: t('pay.recon.column.difference'), group: figures, align: 'right', render: (item) => <span data-testid="difference">{item.differenceVnd === null ? '' : differenceText(item.differenceVnd, locale)}</span> },
    {
      key: 'source',
      header: t('pay.recon.column.source'),
      render: (item) => (
        <>
          <span data-testid="file">{item.sourceFileName ?? ''}</span>
          {item.sourceFileSha256 === null ? null : (
            <span className="pay-key" data-testid="hash" title={item.sourceFileSha256}>
              {' '}
              {item.sourceFileSha256.slice(0, SHORT_HASH)}
            </span>
          )}
        </>
      ),
    },
    { key: 'owner', header: t('pay.recon.column.owner'), render: (item) => <span data-testid="owner">{item.ownerName ?? item.ownerMembershipId}</span> },
    {
      key: 'due',
      header: t('pay.recon.column.due'),
      render: (item) => (
        <>
          <span data-testid="due">{instantText(item.dueAt, locale)}</span>
          {item.overdue ? (
            <span data-testid="overdue">
              {' '}
              <StatusPill tone="warning">{t('pay.recon.overdue')}</StatusPill>
            </span>
          ) : null}
        </>
      ),
    },
    {
      key: 'status',
      header: t('pay.recon.column.status'),
      render: (item) => (
        <span data-testid="status">
          <StatusPill tone={itemTone(item.status)}>{itemStatusLabel(t, item.status)}</StatusPill>
        </span>
      ),
    },
    {
      key: 'actions',
      header: t('pay.recon.column.actions'),
      render: (item) => (
        <Link to={itemLink(item.id)} data-testid="open">
          {t('pay.recon.action.open')}
        </Link>
      ),
    },
  ];

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('pay.recon.title')}</h1>
          <p>{t('pay.recon.subtitle')}</p>
        </div>
      </div>
      <ScopeBar
        money
        extra={[{ label: t('w2pay.pay.recon.ctx.status'), value: ITEM_STATUSES.find((candidate) => candidate === status) === undefined ? t('w2pay.pay.ctx.all') : itemStatusLabel(t, status as ItemStatus) }]}
        updatedAt={items.dataUpdatedAt}
        stale={items.isRefetchError}
      />
      {done === undefined ? null : (
        <p className="callout" role="status" data-testid="done">
          {done}
        </p>
      )}
      {mayRead && (state === 'default' || state === 'loading') ? (
        <KpiStrip label={t('w2pay.pay.recon.kpi.label')}>
          <KpiTile label={t('pay.recon.summary.waiting')} value={String(summary?.waiting ?? 0)} tone="info" state={state === 'loading' ? 'loading' : 'ready'} />
          <KpiTile label={t('pay.recon.summary.overdue')} value={String(summary?.overdue ?? 0)} tone={(summary?.overdue ?? 0) > 0 ? 'warning' : 'neutral'} state={state === 'loading' ? 'loading' : 'ready'} />
          <KpiTile label={t('pay.recon.summary.difference')} value={differenceText(summary?.waitingDifferenceVnd ?? '0', locale)} unit={t('w2pay.ctx.unit')} state={state === 'loading' ? 'loading' : 'ready'} />
        </KpiStrip>
      ) : null}
      {mayReadTransactions ? (
        <SectionCard title={t('pay.recon.pending.title')} unit={t('w2pay.ctx.unit')}>
          {transactions.isError ? (
            <div className="pay-row-actions">
              <p className="callout warning" role="alert" data-testid="transactions-failed">
                {t('pay.recon.pending.failed')}
              </p>
              <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => void transactions.refetch()}>
                {t('ui.common.retry')}
              </button>
            </div>
          ) : waiting.length === 0 ? (
            <p className="sub" data-testid="nothing-pending">
              {t('pay.recon.pending.empty')}
            </p>
          ) : (
            <div data-testid="pending">
              <DataTable caption={t('pay.recon.pending.title')} columns={pendingColumns} rows={waiting} rowKey={(transaction) => transaction.id} rowAttrs={(transaction) => ({ 'data-transaction': transaction.id })} />
            </div>
          )}
        </SectionCard>
      ) : null}

      {!mayRead ? (
        <p className="callout" role="status" data-testid="no-read">
          {t('pay.recon.read.denied')}
        </p>
      ) : (
        <StateBoundary state={state} onRetry={() => void items.refetch()}>
          <FilterPanel applied={status === '' ? 0 : 1} unitLabel={t('w2pay.ctx.unit')}>
            <div className="field">
              <label htmlFor="recon-status">{t('pay.recon.filter.status')}</label>
              <select id="recon-status" value={status} onChange={(event) => setStatus(event.target.value)}>
                <option value="">{t('pay.recon.filter.all')}</option>
                {ITEM_STATUSES.map((candidate) => (
                  <option key={candidate} value={candidate}>
                    {itemStatusLabel(t, candidate)}
                  </option>
                ))}
              </select>
            </div>
          </FilterPanel>
          <SectionCard title={t('pay.recon.items.title')} unit={t('w2pay.ctx.unit')}>
            {rows.length === 0 && status === '' ? (
              <p className="sub" data-testid="nothing">
                {t('pay.recon.items.empty')}
              </p>
            ) : (
              <div data-testid="items">
                <DataTable caption={t('pay.recon.items.title')} columns={itemColumns} rows={rows} rowKey={(item) => item.id} rowAttrs={(item) => ({ 'data-item': item.id, 'data-status': item.status, 'data-overdue': item.overdue ? 'yes' : 'no' })} emptyKind={status === '' ? 'none' : 'filtered'} onClearFilters={() => setStatus('')} />
              </div>
            )}
          </SectionCard>
        </StateBoundary>
      )}
      {matching === undefined ? null : <MatchDialog transaction={matching} requests={requests.data ?? []} onDone={matched} onClose={() => setMatching(undefined)} />}
      <p className="prototype-note">{t('pay.recon.footer', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
