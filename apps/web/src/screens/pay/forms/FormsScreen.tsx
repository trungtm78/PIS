import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { BackLink, Fact } from '../../ctr/components';
import { usePayment } from '../payment/hooks';
import { statusLabel } from '../payment/labels';
import { paymentLink, signedAmountText } from '../payment/model';
import { GenerateDialog, SendDialog } from './FormsDialogs';
import { useForms } from './hooks';
import { formName, formStatusLabel } from './labels';
import { FORM_CODES, boardLink, formsMissing, standingForms } from './model';
import type { FormCode } from './model';
import '../pay.css';

/** The day in Vietnam, for the check that the day the file was sent is not to come. */
const vietnamToday = (): string => new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 10);

/**
 * PAY-14: the Treasury forms of a payment request (ST-PAY-005, PAY 3.3). For each of the four forms: the one that stands, with the template revision it was drawn from, the legal basis of that
 * revision and the hash of the file; the ones it replaced; and the commands to draw it again. A form is drawn only from a template that is confirmed and in force; when the four stand, the
 * day the file was sent and the number the Treasury gave it are recorded by hand. Nothing here calls the Treasury.
 */
export default function FormsScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The forms and the dialogs belong to one membership: a switch of tenant or of membership starts the screen over.
  return <FormsContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

type Dialog = { kind: 'generate'; codes: readonly FormCode[] } | { kind: 'send' };

function FormsContent({ route }: ScreenProps) {
  const { t, locale } = useTranslation();
  const { mode } = useSession();
  const [search] = useSearchParams();
  const id = search.get('request');
  const payment = usePayment(id);
  const forms = useForms(id);
  const [dialog, setDialog] = useState<Dialog | undefined>(undefined);
  const [done, setDone] = useState<string | undefined>(undefined);
  const state = useScreenState({
    isLoading: payment.isLoading || forms.isLoading,
    error: payment.error ?? forms.error,
    data: id === null ? null : payment.data === null || forms.data === null ? null : payment.data,
    isEmpty: (data) => data === null || data === undefined,
  });
  const request = payment.data;
  const all = forms.data ?? [];
  const standing = standingForms(all);
  const missing = formsMissing(all);
  const history = all.filter((form) => form.status !== 'GENERATED');
  const writable = mode !== 'READ_ONLY';
  const finished = (message: string) => (): void => {
    setDone(message);
    setDialog(undefined);
  };

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      {id === null ? null : <BackLink to={boardLink()}>{t('pay.forms.back')}</BackLink>}
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('pay.forms.title')}</h1>
          <p>{t('pay.forms.subtitle')}</p>
        </div>
      </div>
      {id === null ? (
        <p className="callout" role="status" data-testid="no-request">
          {t('pay.forms.none')}
        </p>
      ) : (
        <StateBoundary state={state} onRetry={() => void Promise.all([payment.refetch(), forms.refetch()])}>
          {request === null || request === undefined ? null : (
            <>
              <article className="card" aria-label={t('pay.forms.request')}>
                <h2>
                  <Link to={paymentLink(request.id)} data-testid="request-no">
                    {request.requestNo ?? request.id}
                  </Link>{' '}
                  <span className="pay-badge" data-testid="status">
                    {statusLabel(t, request.status)}
                  </span>
                </h2>
                <dl className="pay-facts">
                  <Fact label={t('pay.forms.fact.contract')}>
                    <span data-testid="contract">{request.contract.code}</span>
                  </Fact>
                  <Fact label={t('pay.forms.fact.net')}>
                    <strong data-testid="net">{signedAmountText(request.netVnd, locale) ?? request.netVnd}</strong>
                  </Fact>
                  {request.treasurySubmittedOn === null ? null : (
                    <Fact label={t('pay.forms.fact.sentOn')}>
                      <span data-testid="sent-on">{request.treasurySubmittedOn}</span>
                    </Fact>
                  )}
                  {request.treasuryPaidOn === null ? null : (
                    <Fact label={t('pay.forms.fact.paidOn')}>
                      <span data-testid="paid-on">{request.treasuryPaidOn}</span>
                    </Fact>
                  )}
                  {request.treasuryRef === null ? null : (
                    <Fact label={t('pay.forms.fact.ref')}>
                      <span data-testid="ref">{request.treasuryRef}</span>
                    </Fact>
                  )}
                </dl>
                <div className="pay-row-actions">
                  {writable && request.actions.generateForms ? (
                    <>
                      <button type="button" onClick={() => setDialog({ kind: 'generate', codes: FORM_CODES })} data-action="generate-all">
                        {t('pay.forms.action.generateAll')}
                      </button>
                      {missing.length > 0 && missing.length < FORM_CODES.length ? (
                        <button type="button" onClick={() => setDialog({ kind: 'generate', codes: missing })} data-action="generate-missing">
                          {t('pay.forms.action.generateMissing')}
                        </button>
                      ) : null}
                    </>
                  ) : null}
                  {writable && request.actions.sendTreasury ? (
                    <button type="button" className="primary" onClick={() => setDialog({ kind: 'send' })} data-action="send">
                      {t('pay.forms.action.send')}
                    </button>
                  ) : null}
                </div>
                {request.status === 'VERIFIED' && missing.length > 0 ? (
                  <p className="callout" role="status" data-testid="missing">
                    {t('pay.forms.missing', { forms: missing.join(', ') })}
                  </p>
                ) : null}
              </article>
              {done === undefined ? null : (
                <p className="callout" role="status" data-testid="done">
                  {done}
                </p>
              )}
              <article className="card" aria-label={t('pay.forms.forms')}>
                <table className="table" data-testid="forms">
                  <thead>
                    <tr>
                      <th scope="col">{t('pay.forms.column.form')}</th>
                      <th scope="col">{t('pay.forms.column.template')}</th>
                      <th scope="col">{t('pay.forms.column.basis')}</th>
                      <th scope="col">{t('pay.forms.column.file')}</th>
                      <th scope="col">{t('pay.forms.column.generatedAt')}</th>
                      <th scope="col">{t('pay.forms.column.actions')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {FORM_CODES.map((code) => {
                      const form = standing.get(code);
                      return (
                        <tr key={code} data-form={code} data-state={form === undefined ? 'missing' : 'standing'}>
                          <td>
                            <strong>{code}</strong> <span className="sub">{formName(t, code)}</span>
                          </td>
                          <td data-testid="template">{form === undefined ? t('pay.forms.notDrawn') : t('pay.forms.template', { code: form.templateCode ?? '', revision: form.templateRevision ?? '' })}</td>
                          <td data-testid="basis">{form?.legalBasis ?? ''}</td>
                          <td>
                            <code className="pay-key" data-testid="hash">
                              {form?.fileSha256?.slice(0, 16) ?? ''}
                            </code>
                          </td>
                          <td data-testid="generated-at">{form?.generatedAt ?? ''}</td>
                          <td>
                            {writable && request.actions.generateForms ? (
                              <button type="button" onClick={() => setDialog({ kind: 'generate', codes: [code] })} data-action="generate">
                                {form === undefined ? t('pay.forms.action.generate') : t('pay.forms.action.regenerate')}
                              </button>
                            ) : null}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </article>
              {history.length === 0 ? null : (
                <article className="card" aria-label={t('pay.forms.history')}>
                  <h2>{t('pay.forms.history')}</h2>
                  <ul data-testid="history">
                    {history.map((form) => (
                      <li key={form.id} data-form-id={form.id}>
                        {form.formCode} · {formStatusLabel(t, form.status)} · {t('pay.forms.template', { code: form.templateCode ?? '', revision: form.templateRevision ?? '' })} · {form.generatedAt ?? ''}
                      </li>
                    ))}
                  </ul>
                </article>
              )}
              {dialog?.kind === 'generate' ? <GenerateDialog request={request} codes={dialog.codes} onDone={finished(t('pay.forms.done.generated'))} onClose={() => setDialog(undefined)} /> : null}
              {dialog?.kind === 'send' ? <SendDialog request={request} forms={all} today={vietnamToday()} onDone={finished(t('pay.forms.done.sent'))} onClose={() => setDialog(undefined)} /> : null}
            </>
          )}
        </StateBoundary>
      )}
      <p className="prototype-note">{t('pay.forms.footer', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
