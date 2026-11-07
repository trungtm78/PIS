import { Link } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { DataTable, StatusPill } from '../../../ui';
import type { DataTableColumn } from '../../../ui';
import { ScopeBar } from '../../ctr/kit';
import { usePayments } from '../payment/hooks';
import { kindLabel, statusLabel, statusTone } from '../payment/labels';
import { paymentLink, signedAmountText } from '../payment/model';
import type { PaymentRequest } from '../payment/model';
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

  const columns: DataTableColumn<PaymentRequest>[] = [
    {
      key: 'no',
      header: t('pay.board.column.no'),
      pinned: true,
      render: (request) => (
        <>
          <Link to={formsLink(request.id)} data-testid="open">
            {request.requestNo ?? request.id}
          </Link>{' '}
          <Link to={paymentLink(request.id)} className="sub" data-testid="detail">
            {t('pay.board.detail')}
          </Link>
        </>
      ),
    },
    { key: 'contract', header: t('pay.board.column.contract'), render: (request) => <span data-testid="contract">{request.contract.code}</span> },
    { key: 'kind', header: t('pay.board.column.kind'), render: (request) => <span data-testid="kind">{kindLabel(t, request.requestKind)}</span> },
    { key: 'net', header: t('pay.board.column.net'), align: 'right', render: (request) => <span data-testid="net">{money(request.netVnd)}</span> },
    {
      key: 'status',
      header: t('pay.board.column.status'),
      render: (request) => (
        <span data-testid="status" data-request={request.id} data-status={request.status}>
          <StatusPill tone={statusTone(request.status)}>{statusLabel(t, request.status)}</StatusPill>
        </span>
      ),
    },
    {
      key: 'forms',
      header: t('pay.board.column.forms'),
      align: 'right',
      render: (request) => <span data-testid="forms">{t('pay.board.forms', { count: standingCount(request), total: FORM_CODES.length })}</span>,
    },
    { key: 'sentOn', header: t('pay.board.column.sentOn'), render: (request) => <span data-testid="sent-on">{request.treasurySubmittedOn ?? ''}</span> },
    { key: 'ref', header: t('pay.board.column.ref'), render: (request) => <span data-testid="ref">{request.treasuryRef ?? ''}</span> },
  ];

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('pay.board.title')}</h1>
          <p>{t('pay.board.subtitle')}</p>
        </div>
      </div>
      <ScopeBar
        money
        updatedAt={payments.dataUpdatedAt}
        stale={payments.isRefetchError}
        extra={[{ label: t('w2pay.pay.board.ctx.on'), value: t('w2pay.pay.board.ctx.count', { count: onTheWay.length }) }]}
      />
      <StateBoundary state={state} onRetry={() => void payments.refetch()}>
        {onTheWay.length === 0 ? (
          <p className="sub" data-testid="nothing">
            {t('pay.board.empty')}
          </p>
        ) : (
          <div data-testid="board">
            <DataTable caption={t('pay.board.title')} columns={columns} rows={onTheWay} rowKey={(request) => request.id} />
          </div>
        )}
      </StateBoundary>
      <p className="prototype-note">{t('pay.board.footer', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
