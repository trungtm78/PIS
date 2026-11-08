import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { BackLink, Fact } from '../../ctr/components';
import { ManualConfirmDialog } from './ManualConfirmDialog';
import type { ManualOutcome } from './manual-confirm-model';
import { itemLink } from '../recon/model';
import { MANUAL_CONFIRM_PERMISSION } from './manual-confirm-model';
import { AttachDialog, CancelDialog, ReturnDialog, ReviseDialog, SubmitDialog, VerifyDialog } from './PaymentDialogs';
import { usePayment } from './hooks';
import { docKindLabel, kindLabel, statusLabel, statusTone, warningMessage } from './labels';
import { listLink, signedAmountText, valuationLink } from './model';
import { formsLink } from '../forms/model';
import { reversalLink } from '../reversal/model';
import type { PaymentAnswer, PaymentRequest, WarningCode } from './model';
import '../pay.css';
import { SectionCard, StatusPill } from '../../../ui';
import { IntegrityPanel } from '../integrity/IntegrityPanel';

/**
 * PAY-03: a payment request and its documents (ST-PAY-002, PAY 3.1 step 2). The figures are the server's and read-only; a draft can be revised, given documents and cancelled by those who hold
 * the right, and a person the contract trusts with exceptions lets a duplicate invoice through with a reason. How the amount is made up, line by line, is CTR-13.
 */
export default function PaymentDetailScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The request and the dialogs belong to one membership: a switch of tenant or of membership starts the screen over.
  return <PaymentDetailContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

type Dialog = 'revise' | 'attach' | 'cancel' | 'submit' | 'verify' | 'return' | 'manual';

function PaymentDetailContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const [search] = useSearchParams();
  const id = search.get('request');
  const payment = usePayment(id);
  const state = useScreenState({ isLoading: payment.isLoading, error: payment.error, data: id === null ? null : payment.data, isEmpty: (data) => data === null });
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <BackLink to={listLink()}>{t('pay.payment.detail.back')}</BackLink>
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('pay.payment.detail.title')}</h1>
          <p>{t('pay.payment.detail.subtitle')}</p>
        </div>
      </div>
      {id === null ? (
        <p className="callout" role="status" data-testid="no-request">
          {t('pay.payment.detail.none')}
        </p>
      ) : (
        <StateBoundary state={state} onRetry={() => void payment.refetch()}>
          {payment.data === null || payment.data === undefined ? null : <Detail request={payment.data} />}
        </StateBoundary>
      )}
      <p className="prototype-note">{t('pay.payment.detail.footer', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

function Detail({ request }: { request: PaymentRequest }) {
  const { t, locale } = useTranslation();
  const { mode, permissions } = useSession();
  const [dialog, setDialog] = useState<Dialog | undefined>(undefined);
  const [done, setDone] = useState<{ message: string; warnings: WarningCode[] } | undefined>(undefined);
  const [manual, setManual] = useState<ManualOutcome | undefined>(undefined);
  const money = (value: string): string => signedAmountText(value, locale) ?? value;
  const close = (): void => setDialog(undefined);
  const finished =
    (message: string) =>
    (answer: PaymentAnswer | undefined): void => {
      setDone({ message, warnings: answer?.warnings ?? [] });
      close();
    };
  const writable = mode !== 'READ_ONLY';
  const mayConfirmManually = writable && request.status === 'SENT_TREASURY' && (permissions === undefined || permissions.includes(MANUAL_CONFIRM_PERMISSION));

  return (
    <>
      <SectionCard title={t('pay.payment.detail.facts')} unit={t('w2pay.ctx.unit')}>
        <h2>
          <span data-testid="request-no">{request.requestNo ?? request.id}</span>{' '}
          <span data-testid="status">
            <StatusPill tone={statusTone(request.status)}>{statusLabel(t, request.status)}</StatusPill>
          </span>
        </h2>
        <dl className="pay-facts">
          <Fact label={t('pay.payment.fact.contract')}>
            <span data-testid="contract">{request.contract.code}</span>
          </Fact>
          <Fact label={t('pay.payment.fact.kind')}>{kindLabel(t, request.requestKind)}</Fact>
          <Fact label={t('pay.payment.fact.acceptance')}>
            <span data-testid="acceptance">{request.acceptance === null ? '' : t('pay.payment.fact.acceptance.value', { no: request.acceptance.acceptanceNo, date: request.acceptance.acceptedOn })}</span>
          </Fact>
          <Fact label={t('pay.payment.fact.planYear')}>
            <span data-testid="plan-year">{request.planYear ?? ''}</span>
          </Fact>
          <Fact label={t('pay.payment.fact.gross')}>
            <span data-testid="gross">{money(request.grossVnd)}</span>
          </Fact>
          <Fact label={t('pay.payment.fact.recovery')}>
            <span data-testid="recovery">{money(request.advanceRecoveryVnd)}</span>
          </Fact>
          <Fact label={t('pay.payment.fact.retention')}>
            <span data-testid="retention">{money(request.retentionVnd)}</span>
          </Fact>
          <Fact label={t('pay.payment.fact.tax')}>
            <span data-testid="tax">{money(request.taxAdjustmentVnd)}</span>
          </Fact>
          {request.taxAdjustmentBasis === null ? null : (
            <Fact label={t('pay.payment.fact.taxBasis')}>
              <span data-testid="tax-basis">{request.taxAdjustmentBasis}</span>
            </Fact>
          )}
          <Fact label={t('pay.payment.fact.net')}>
            <strong data-testid="net">{money(request.netVnd)}</strong>
          </Fact>
          {request.returnReason === null ? null : (
            <Fact label={t('pay.payment.fact.returnReason')}>
              <span data-testid="return-reason">{request.returnReason}</span>
            </Fact>
          )}
          {request.verificationNote === null ? null : (
            <Fact label={t('pay.payment.fact.verificationNote')}>
              <span data-testid="verification-note">{request.verificationNote}</span>
            </Fact>
          )}
          {request.cancelReason === null ? null : (
            <Fact label={t('pay.payment.fact.cancelReason')}>
              <span data-testid="cancel-reason">{request.cancelReason}</span>
            </Fact>
          )}
        </dl>
        {request.otherDrafts !== null && request.otherDrafts > 0 ? (
          <p className="callout warning" role="status" data-testid="other-drafts">
            {t('pay.payment.detail.otherDrafts', { count: request.otherDrafts })}
          </p>
        ) : null}
        <div className="pay-row-actions">
          <Link className="ui-button ui-button--outline" to={valuationLink(request.id)} data-testid="valuation">
            {t('pay.payment.detail.valuation')}
          </Link>
          {request.status === 'VERIFIED' || request.status === 'SENT_TREASURY' ? (
            <Link className="ui-button ui-button--outline" to={formsLink(request.id)} data-testid="forms">
              {t('pay.payment.detail.forms')}
            </Link>
          ) : null}
          {request.status === 'SETTLED' || request.status === 'REVERSED' ? (
            <Link className="ui-button ui-button--outline" to={reversalLink(request.id)} data-testid="reversal">
              {t('pay.payment.detail.reversal')}
            </Link>
          ) : null}
          {writable && request.actions.revise ? (
            <button type="button" className="ui-button ui-button--outline" onClick={() => setDialog('revise')} data-action="revise">
              {t('pay.payment.detail.revise')}
            </button>
          ) : null}
          {writable && request.actions.attachDocument ? (
            <button type="button" className="ui-button ui-button--outline" onClick={() => setDialog('attach')} data-action="attach">
              {t('pay.payment.detail.attach')}
            </button>
          ) : null}
          {writable && request.actions.submit ? (
            <button type="button" className="ui-button ui-button--primary" onClick={() => setDialog('submit')} data-action="submit">
              {t('pay.payment.detail.submit')}
            </button>
          ) : null}
          {writable && request.actions.verify ? (
            <button type="button" className="ui-button ui-button--primary" onClick={() => setDialog('verify')} data-action="verify">
              {t('pay.payment.detail.verify')}
            </button>
          ) : null}
          {writable && request.actions.return ? (
            <button type="button" className="ui-button ui-button--outline" onClick={() => setDialog('return')} data-action="return">
              {t('pay.payment.detail.return')}
            </button>
          ) : null}
          {mayConfirmManually ? (
            <button type="button" className="ui-button ui-button--outline" onClick={() => setDialog('manual')} data-action="manual-confirm">
              {t('pay.manual.open')}
            </button>
          ) : null}
          {writable && request.actions.cancel ? (
            <button type="button" className="ui-button ui-button--outline" onClick={() => setDialog('cancel')} data-action="cancel">
              {t('pay.payment.detail.cancel')}
            </button>
          ) : null}
        </div>
      </SectionCard>
      {manual === undefined ? null : manual.exception ? (
        <div className="callout warning" role="alert" data-testid="manual-exception">
          <p>{t('pay.manual.done.exception')}</p>
          {manual.reconciliationItemId === null ? null : (
            <p>
              <Link to={itemLink(manual.reconciliationItemId)} data-testid="manual-item">
                {t('pay.manual.done.item', { id: manual.reconciliationItemId.slice(0, 8) })}
              </Link>
            </p>
          )}
        </div>
      ) : (
        <div className="callout" role="status" data-testid="manual-done">
          <p>{t('pay.manual.done')}</p>
        </div>
      )}
      {done === undefined ? null : (
        <div className="callout" role="status" data-testid="done">
          <p>{done.message}</p>
          {done.warnings.length === 0 ? null : (
            <ul className="pay-warnings" data-testid="warnings">
              {done.warnings.map((warning) => (
                <li key={warning}>{warningMessage(t, warning)}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      <SectionCard title={t('pay.payment.documents.title')}>
        {request.documents.length === 0 ? (
          <p className="sub" data-testid="no-documents">
            {t('pay.payment.documents.empty')}
          </p>
        ) : (
          <table className="table" data-testid="documents">
            <thead>
              <tr>
                <th scope="col">{t('pay.payment.documents.kind')}</th>
                <th scope="col">{t('pay.payment.documents.invoice')}</th>
                <th scope="col">{t('pay.payment.documents.signed')}</th>
                <th scope="col">{t('pay.payment.documents.checksum')}</th>
                <th scope="col">{t('pay.payment.documents.override')}</th>
              </tr>
            </thead>
            <tbody>
              {request.documents.map((document) => (
                <tr key={document.id} data-document={document.id}>
                  <td data-testid="doc-kind">{docKindLabel(t, document.docKind)}</td>
                  <td data-testid="doc-invoice">{document.invoiceNo === null ? '' : `${document.invoiceNo} · ${document.invoiceDate ?? ''}`}</td>
                  <td>{document.signed ? t('pay.payment.documents.yes') : t('pay.payment.documents.no')}</td>
                  <td>
                    <code data-testid="doc-checksum">{document.checksum.slice(0, 12)}</code>
                  </td>
                  <td data-testid="doc-override">{document.duplicateOverrideReason ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </SectionCard>
      <IntegrityPanel requestId={request.id} />
      {dialog === 'revise' ? <ReviseDialog request={request} onDone={finished(t('pay.payment.done.revised'))} onClose={close} /> : null}
      {dialog === 'attach' ? <AttachDialog request={request} onDone={finished(t('pay.payment.done.attached'))} onClose={close} /> : null}
      {dialog === 'cancel' ? <CancelDialog request={request} onDone={finished(t('pay.payment.done.cancelled'))} onClose={close} /> : null}
      {dialog === 'submit' ? <SubmitDialog request={request} onDone={finished(t('pay.payment.done.submitted'))} onClose={close} /> : null}
      {dialog === 'verify' ? <VerifyDialog request={request} onDone={finished(t('pay.payment.done.verified'))} onClose={close} /> : null}
      {dialog === 'manual' ? <ManualConfirmDialog request={request} onDone={(outcome) => { setManual(outcome); setDone(undefined); close(); }} onClose={close} /> : null}
      {dialog === 'return' ? <ReturnDialog request={request} onDone={finished(t('pay.payment.done.returned'))} onClose={close} /> : null}
    </>
  );
}
