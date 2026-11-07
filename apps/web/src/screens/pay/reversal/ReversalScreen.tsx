import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { BackLink, Fact } from '../../ctr/components';
import { useLedger } from '../ledger/hooks';
import { entryKindLabel } from '../ledger/labels';
import { ledgerLink } from '../ledger/model';
import { instantText } from '../model';
import { usePayment } from '../payment/hooks';
import { statusLabel } from '../payment/labels';
import { paymentLink } from '../payment/model';
import { useTransactions } from '../recon/hooks';
import { boardLink, differenceText, vndText } from '../recon/model';
import { ReverseDialog } from './ReverseDialog';
import { LEDGER_PERMISSION, REVERSE_PERMISSION, TRANSACTION_READ_PERMISSION, entryPairs, figureOf, refundsFor } from './model';
import type { Reversal } from './model';
import '../pay.css';
import { SectionCard } from '../../../ui';

/**
 * PAY-08: reversing a payment that was settled (ST-PAY-008, PAY 3.4). The entries the payment put on the ledger are shown side by side with the entries that undid them, so a reversal can be read as
 * what it is: new lines against old ones, nothing changed and nothing deleted. A settled payment is reversed against one of the refunds the Treasury confirmed for it, with a reason and the
 * document that approves it, by someone other than whoever matched the payment; afterwards the acceptance can be claimed again.
 */
export default function ReversalScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The entries and the dialog belong to one membership: a switch of tenant or of membership starts the screen over.
  return <ReversalContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function ReversalContent({ route }: ScreenProps) {
  const { t, locale } = useTranslation();
  const { permissions, mode } = useSession();
  const holds = (permission: string): boolean => permissions === undefined || permissions.includes(permission);
  const [search] = useSearchParams();
  const id = search.get('request');
  const payment = usePayment(id);
  const request = payment.data;
  const mayReadLedger = holds(LEDGER_PERMISSION);
  const ledger = useLedger(mayReadLedger ? request?.contract.id : undefined, { itemId: null, acceptanceId: null });
  const transactions = useTransactions(holds(TRANSACTION_READ_PERMISSION) && request?.status === 'SETTLED');
  const [open, setOpen] = useState(false);
  const [done, setDone] = useState<string | undefined>(undefined);
  const state = useScreenState({
    isLoading: payment.isLoading,
    error: payment.error,
    data: id === null ? null : payment.data,
    isEmpty: (data) => data === null || data === undefined,
  });
  const pairs = request === null || request === undefined ? [] : entryPairs(ledger.ledger?.items ?? [], request.id);
  const refunds = request === null || request === undefined ? [] : refundsFor(transactions.data ?? [], request);
  const mayReverse = request?.status === 'SETTLED' && holds(REVERSE_PERMISSION) && mode !== 'READ_ONLY';
  const reversed = (reversal: Reversal | undefined): void => {
    setDone(reversal === undefined ? t('pay.reversal.done.plain') : t('pay.reversal.done.reversed', { entries: reversal.paymentEntries }));
    setOpen(false);
  };

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <BackLink to={boardLink()}>{t('pay.reversal.back')}</BackLink>
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('pay.reversal.title')}</h1>
          <p>{t('pay.reversal.subtitle')}</p>
        </div>
      </div>
      {done === undefined ? null : (
        <p className="callout" role="status" data-testid="done">
          {done}
        </p>
      )}
      {id === null ? (
        <p className="callout" role="status" data-testid="no-request">
          {t('pay.reversal.none')}
        </p>
      ) : (
        <StateBoundary state={state} onRetry={() => void payment.refetch()}>
          {request === null || request === undefined ? null : (
            <>
              <SectionCard title={t('pay.reversal.request')}>
                <h2>
                  <Link to={paymentLink(request.id)} data-testid="request-no">
                    {request.requestNo ?? request.id}
                  </Link>{' '}
                  <span className="pay-badge" data-testid="status">
                    {statusLabel(t, request.status)}
                  </span>
                </h2>
                <dl className="pay-facts">
                  <Fact label={t('pay.reversal.fact.contract')}>
                    <Link to={ledgerLink(request.contract.id)} data-testid="contract">
                      {request.contract.code}
                    </Link>
                  </Fact>
                  <Fact label={t('pay.reversal.fact.gross')}>
                    <span data-testid="gross">{vndText(request.grossVnd, locale)}</span>
                  </Fact>
                  <Fact label={t('pay.reversal.fact.net')}>
                    <strong data-testid="net">{vndText(request.netVnd, locale)}</strong>
                  </Fact>
                  {request.treasuryPaidOn === null ? null : (
                    <Fact label={t('pay.reversal.fact.paidOn')}>
                      <span data-testid="paid-on">{request.treasuryPaidOn}</span>
                    </Fact>
                  )}
                  {request.reversedAt === null ? null : (
                    <Fact label={t('pay.reversal.fact.reversedAt')}>
                      <span data-testid="reversed-at">{instantText(request.reversedAt, locale)}</span>
                    </Fact>
                  )}
                </dl>
                {request.status === 'SETTLED' || request.status === 'REVERSED' ? null : (
                  <p className="callout" role="status" data-testid="not-settled">
                    {t('pay.reversal.notSettled')}
                  </p>
                )}
                {mayReverse ? (
                  <div className="pay-row-actions">
                    <button type="button" data-action="reverse" onClick={() => setOpen(true)}>
                      {t('pay.reversal.action.reverse')}
                    </button>
                  </div>
                ) : null}
              </SectionCard>

              <SectionCard title={t('pay.reversal.entries.title')}>
                {!mayReadLedger ? (
                  <p className="callout" role="status" data-testid="no-ledger">
                    {t('pay.reversal.entries.denied')}
                  </p>
                ) : ledger.isError ? (
                  <p className="callout warning" role="alert" data-testid="ledger-failed">
                    {t('pay.reversal.entries.failed')}
                  </p>
                ) : pairs.length === 0 ? (
                  <p className="sub" data-testid="no-entries">
                    {t('pay.reversal.entries.empty')}
                  </p>
                ) : (
                  <table className="table" data-testid="entries">
                    <thead>
                      <tr>
                        <th scope="col">{t('pay.reversal.entries.column.item')}</th>
                        <th scope="col">{t('pay.reversal.entries.column.original')}</th>
                        <th scope="col" className="pay-amount">
                          {t('pay.reversal.entries.column.originalAmount')}
                        </th>
                        <th scope="col">{t('pay.reversal.entries.column.reversal')}</th>
                        <th scope="col" className="pay-amount">
                          {t('pay.reversal.entries.column.reversalAmount')}
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {pairs.map((pair) => (
                        <tr key={pair.original.id} data-entry={pair.original.id} data-undone={pair.reversal === null ? 'no' : 'yes'}>
                          <td data-testid="item">{pair.item}</td>
                          <td data-testid="original-kind">{entryKindLabel(t, pair.original.kind)}</td>
                          <td className="pay-amount" data-testid="original-amount">
                            {differenceText(figureOf(pair.original), locale)}
                          </td>
                          <td data-testid="reversal-kind">{pair.reversal === null ? '' : entryKindLabel(t, pair.reversal.kind)}</td>
                          <td className="pay-amount" data-testid="reversal-amount">
                            {pair.reversal === null ? '' : differenceText(figureOf(pair.reversal), locale)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </SectionCard>
              {open ? <ReverseDialog request={request} refunds={refunds} onDone={reversed} onClose={() => setOpen(false)} /> : null}
            </>
          )}
        </StateBoundary>
      )}
      <p className="prototype-note">{t('pay.reversal.footer', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
