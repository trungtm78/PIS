import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { usePayments } from '../payment/hooks';
import { paymentLink } from '../payment/model';
import { instantText } from '../model';
import { MatchDialog } from './ReconDialogs';
import { useItems, useTransactions } from './hooks';
import { itemStatusLabel, kindLabel } from './labels';
import { ITEM_STATUSES, MATCH_PERMISSION, READ_PERMISSION, REQUEST_READ_PERMISSION, TRANSACTION_READ_PERMISSION, differenceText, itemLink, unmatchedTransactions, vndText } from './model';
import type { Settlement, Transaction } from './model';
import '../pay.css';

/** The first characters of a hash, enough to tell two files apart on a row. */
const SHORT_HASH = 16;

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

  const matched = (settlement: Settlement | undefined): void => {
    setDone(settlement === undefined ? t('pay.recon.done.matched') : t('pay.recon.done.settled', { day: settlement.treasuryPaidOn }));
    setMatching(undefined);
  };

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('pay.recon.title')}</h1>
          <p>{t('pay.recon.subtitle')}</p>
        </div>
      </div>
      {done === undefined ? null : (
        <p className="callout" role="status" data-testid="done">
          {done}
        </p>
      )}
      {mayReadTransactions ? (
        <article className="card" aria-label={t('pay.recon.pending.title')}>
          <h2>{t('pay.recon.pending.title')}</h2>
          {transactions.isError ? (
            <p className="callout warning" role="alert" data-testid="transactions-failed">
              {t('pay.recon.pending.failed')}
            </p>
          ) : waiting.length === 0 ? (
            <p className="sub" data-testid="nothing-pending">
              {t('pay.recon.pending.empty')}
            </p>
          ) : (
            <table className="table" data-testid="pending">
              <thead>
                <tr>
                  <th scope="col">{t('pay.recon.pending.column.voucher')}</th>
                  <th scope="col">{t('pay.recon.pending.column.project')}</th>
                  <th scope="col" className="pay-amount">
                    {t('pay.recon.pending.column.amount')}
                  </th>
                  <th scope="col">{t('pay.recon.pending.column.confirmedAt')}</th>
                  <th scope="col">{t('pay.recon.column.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {waiting.map((transaction) => (
                  <tr key={transaction.id} data-transaction={transaction.id}>
                    <td data-testid="voucher">{transaction.documentNo ?? transaction.id}</td>
                    <td data-testid="project">{transaction.projectCode}</td>
                    <td className="pay-amount" data-testid="amount">
                      {vndText(transaction.amountVnd, locale)}
                    </td>
                    <td data-testid="confirmed-at">{instantText(transaction.confirmedAt, locale)}</td>
                    <td>
                      {mayMatch ? (
                        <button type="button" data-action="match" onClick={() => setMatching(transaction)}>
                          {t('pay.recon.action.match')}
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </article>
      ) : null}

      {!mayRead ? (
        <p className="callout" role="status" data-testid="no-read">
          {t('pay.recon.read.denied')}
        </p>
      ) : (
        <StateBoundary state={state} onRetry={() => void items.refetch()}>
          <dl className="pay-counts">
            <div>
              <dt>{t('pay.recon.summary.waiting')}</dt>
              <dd data-testid="waiting">{summary?.waiting ?? 0}</dd>
            </div>
            <div>
              <dt>{t('pay.recon.summary.overdue')}</dt>
              <dd data-testid="overdue-count">{summary?.overdue ?? 0}</dd>
            </div>
            <div>
              <dt>{t('pay.recon.summary.difference')}</dt>
              <dd data-testid="difference-sum">{differenceText(summary?.waitingDifferenceVnd ?? '0', locale)}</dd>
            </div>
          </dl>
          <article className="card" aria-label={t('pay.recon.items.title')}>
            <h2>{t('pay.recon.items.title')}</h2>
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
            {(items.data?.items ?? []).length === 0 ? (
              <p className="sub" data-testid="nothing">
                {t('pay.recon.items.empty')}
              </p>
            ) : (
              <table className="table" data-testid="items">
                <thead>
                  <tr>
                    <th scope="col">{t('pay.recon.column.kind')}</th>
                    <th scope="col">{t('pay.recon.column.request')}</th>
                    <th scope="col">{t('pay.recon.column.voucher')}</th>
                    <th scope="col" className="pay-amount">
                      {t('pay.recon.column.internal')}
                    </th>
                    <th scope="col" className="pay-amount">
                      {t('pay.recon.column.confirmed')}
                    </th>
                    <th scope="col" className="pay-amount">
                      {t('pay.recon.column.difference')}
                    </th>
                    <th scope="col">{t('pay.recon.column.source')}</th>
                    <th scope="col">{t('pay.recon.column.owner')}</th>
                    <th scope="col">{t('pay.recon.column.due')}</th>
                    <th scope="col">{t('pay.recon.column.status')}</th>
                    <th scope="col">{t('pay.recon.column.actions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {(items.data?.items ?? []).map((item) => (
                    <tr key={item.id} data-item={item.id} data-status={item.status} data-overdue={item.overdue ? 'yes' : 'no'}>
                      <td data-testid="kind">{kindLabel(t, item.kind)}</td>
                      <td data-testid="request">
                        {item.paymentRequestId === null ? (
                          ''
                        ) : (
                          <Link to={paymentLink(item.paymentRequestId)}>{item.requestNo ?? item.paymentRequestId}</Link>
                        )}
                      </td>
                      <td data-testid="voucher">{item.documentNo ?? ''}</td>
                      <td className="pay-amount" data-testid="internal">
                        {item.internalVnd === null ? '' : vndText(item.internalVnd, locale)}
                      </td>
                      <td className="pay-amount" data-testid="confirmed">
                        {item.confirmedVnd === null ? '' : vndText(item.confirmedVnd, locale)}
                      </td>
                      <td className="pay-amount" data-testid="difference">
                        {item.differenceVnd === null ? '' : differenceText(item.differenceVnd, locale)}
                      </td>
                      <td>
                        <span data-testid="file">{item.sourceFileName ?? ''}</span>
                        {item.sourceFileSha256 === null ? null : (
                          <span className="pay-key" data-testid="hash" title={item.sourceFileSha256}>
                            {' '}
                            {item.sourceFileSha256.slice(0, SHORT_HASH)}
                          </span>
                        )}
                      </td>
                      <td data-testid="owner">{item.ownerName ?? item.ownerMembershipId}</td>
                      <td>
                        <span data-testid="due">{instantText(item.dueAt, locale)}</span>
                        {item.overdue ? (
                          <span className="pay-badge warning" data-testid="overdue">
                            {' '}
                            {t('pay.recon.overdue')}
                          </span>
                        ) : null}
                      </td>
                      <td>
                        <span className="pay-badge" data-testid="status">
                          {itemStatusLabel(t, item.status)}
                        </span>
                      </td>
                      <td>
                        <Link to={itemLink(item.id)} data-testid="open">
                          {t('pay.recon.action.open')}
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </article>
        </StateBoundary>
      )}
      {matching === undefined ? null : <MatchDialog transaction={matching} requests={requests.data ?? []} onDone={matched} onClose={() => setMatching(undefined)} />}
      <p className="prototype-note">{t('pay.recon.footer', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
