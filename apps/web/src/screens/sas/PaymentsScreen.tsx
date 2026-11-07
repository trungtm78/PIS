import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import { routeById } from '../../routes/registry';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { useTenantInvoices } from './billing/hooks';
import { statusLabel as invoiceStatusLabel, statusTone as invoiceStatusTone } from './billing/labels';
import { formatVnd } from './billing/model';
import type { PaymentView } from './billing/model';
import { useMatchPayment, usePaymentQueue } from './payments/hooks';
import { methodLabel, paymentStatusLabel, paymentStatusTone, problemMessage } from './payments/labels';
import { MATCH_PAYMENT_PERMISSION, MAX_REASON, describeProblem, isReasonValid, outstandingOf, payableInvoices } from './payments/model';
import { TenantPicker } from './subscription/TenantPicker';
import { useTenantChoice } from './subscription/hooks';
import { toneClass } from './tenants/labels';
import { SectionCard, StatusPill } from '../../ui';
import { KitTable } from '../adm/KitTable';
import '../adm/adm-kit.css';
import './tenants/sas.css';
import './billing/billing.css';
import { toneOfPill } from '../adm/kit-tone';

interface Matching {
  payment: PaymentView;
  invoiceId: string;
  reason: string;
  tooShort: boolean;
  noInvoice: boolean;
}

/**
 * SAS-10: the invoices and the reconciliation of the payments that come in. The billing operator sees the payments that wait for a person (the transfer note names no invoice, or one that the amount does not fit) and matches one
 * with an invoice of the tenant they pick, with a reason; the platform moves the payment to the tenant and settles the invoice, and only for exactly what is still to be paid (anything else is refused with the amount that is
 * outstanding). Below, the invoices of the tenant show the number the provider issued, the code of the tax authority and whether a payment has matched. A payment is never edited and the screen has no way to delete one.
 */
export default function PaymentsScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The form and the notices belong to one membership: a switch starts the screen over.
  return <PaymentsContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function PaymentsContent({ route }: ScreenProps) {
  const { t, locale } = useTranslation();
  const { permissions } = useSession();
  const canMatch = permissions === undefined || permissions.includes(MATCH_PAYMENT_PERMISSION);
  const choice = useTenantChoice();
  const queue = usePaymentQueue();
  const invoices = useTenantInvoices(choice.chosen);
  const match = useMatchPayment();
  const [chosenMatch, setMatching] = useState<(Matching & { tenantId: string | undefined }) | undefined>(undefined);
  const [done, setDone] = useState(false);

  const state = useScreenState({ isLoading: queue.isLoading, error: queue.error, data: queue.data, isEmpty: () => false });
  const waiting = (queue.data?.pages ?? []).flatMap((page) => page.items);
  const invoiceItems = (invoices.data?.pages ?? []).flatMap((page) => page.items);
  const payable = payableInvoices(invoiceItems);
  // The invoice picked belongs to the tenant that was shown when the payment was picked: another tenant on the screen never inherits it.
  const matching = chosenMatch !== undefined && chosenMatch.tenantId === choice.chosen ? chosenMatch : undefined;
  const problem = match.isError ? describeProblem(match.error) : undefined;
  const settingsRoute = routeById('SAS-09');
  const money = (amount: string): string => formatVnd(amount, locale);
  const day = (value: string): string => new Date(value).toLocaleString(locale, { timeZone: 'UTC' });
  const date = (value: string): string => new Date(`${value}T00:00:00Z`).toLocaleDateString(locale, { timeZone: 'UTC' });

  const open = (payment: PaymentView): void => {
    setDone(false);
    match.reset();
    setMatching({ tenantId: choice.chosen, payment, invoiceId: '', reason: '', tooShort: false, noInvoice: false });
  };

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (matching === undefined || match.isPending || !canMatch) return;
    const missing = matching.invoiceId === '';
    const short = !isReasonValid(matching.reason);
    if (missing || short) {
      setMatching({ ...matching, noInvoice: missing, tooShort: short });
      return;
    }
    match.mutate(
      { paymentId: matching.payment.id, invoiceId: matching.invoiceId, version: matching.payment.version, reason: matching.reason.trim() },
      {
        onSuccess: () => {
          setDone(true);
          setMatching(undefined);
        },
      },
    );
  };

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title" className="sas-billing">
      {settingsRoute === undefined ? null : (
        <p className="sas-back-link">
          <Link to={choice.chosen === undefined ? settingsRoute.path : `${settingsRoute.path}?tenant=${encodeURIComponent(choice.chosen)}`}>
            <span aria-hidden="true">← </span>
            {t('sas.payments.back.link')}
          </Link>
        </p>
      )}
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('sas.payments.page.title')}</h1>
          <p>{t('sas.payments.page.subtitle')}</p>
        </div>
      </div>
      <StateBoundary state={state} onRetry={() => void queue.refetch()}>
        <SectionCard title={t('sas.payments.queue.title')} unit={t('dis.wr.unit')}>
          {done ? (
            <p className="callout" role="status">
              {t('sas.payments.done')}
            </p>
          ) : null}
          {waiting.length === 0 ? (
            <p className="sub" role="status">
              {t('sas.payments.queue.none')}
            </p>
          ) : (
            <KitTable caption={t('w2sas.payments.table.queue')} data-payments>
              <thead>
                <tr>
                  <th scope="col">{t('sas.payments.column.received')}</th>
                  <th scope="col">{t('sas.payments.column.source')}</th>
                  <th scope="col" className="amount">
                    {t('sas.payments.column.amount')}
                  </th>
                  <th scope="col">{t('sas.payments.column.memo')}</th>
                  <th scope="col">{t('sas.payments.column.status')}</th>
                  <th scope="col">
                    <span className="visually-hidden">{t('sas.payments.column.actions')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {waiting.map((payment) => (
                  <tr key={payment.id} data-payment-id={payment.id} data-status={payment.status}>
                    <td>{day(payment.receivedAt)}</td>
                    <td>
                      {payment.provider} · {methodLabel(t, payment.method)}
                      <br />
                      <small className="sub">
                        <code>{payment.txnRef}</code>
                      </small>
                    </td>
                    <td className="amount">{money(payment.amountVnd)}</td>
                    <td>{payment.memo === '' ? '—' : payment.memo}</td>
                    <td>
                      <StatusPill tone={toneOfPill(toneClass(paymentStatusTone(payment.status)))}>{paymentStatusLabel(t, payment.status)}</StatusPill>
                    </td>
                    <td>
                      {canMatch && payment.canMatch ? (
                        <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => open(payment)}>
                          {t('sas.payments.match.action')}
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </KitTable>
          )}
          {queue.hasNextPage ? (
            <div className="row gap">
              <button type="button" disabled={queue.isFetchingNextPage} onClick={() => void queue.fetchNextPage()}>
                {t('sas.payments.queue.more.action')}
              </button>
            </div>
          ) : null}
          {problem === undefined ? null : (
            <div className="callout warning" role="alert">
              <p>{problemMessage(t, problem, money)}</p>
            </div>
          )}
          {matching === undefined ? null : (
            <form onSubmit={submit} noValidate aria-label={t('sas.payments.match.aria')} className="billing-issue">
              <p className="callout">{t('sas.payments.match.rule', { amount: money(matching.payment.amountVnd) })}</p>
              <TenantPicker id="payments-tenant" label={t('sas.payments.tenant.label')} moreLabel={t('sas.payments.tenant.more.action')} choice={choice} />
              <div className="field">
                <label htmlFor="payments-invoice">{t('sas.payments.match.invoice.label')}</label>
                <select id="payments-invoice" value={matching.invoiceId} aria-invalid={matching.noInvoice} onChange={(event) => setMatching({ ...matching, invoiceId: event.target.value, noInvoice: false })}>
                  <option value="">{t('sas.payments.match.invoice.choose')}</option>
                  {payable.map((invoice) => (
                    <option key={invoice.id} value={invoice.id}>
                      {t('sas.payments.match.invoice.option', { code: invoice.invoiceCode, amount: money(outstandingOf(invoice)) })}
                    </option>
                  ))}
                </select>
                {payable.length === 0 ? <small className="sub">{t('sas.payments.match.invoice.none')}</small> : null}
                {matching.noInvoice ? (
                  <small role="alert" className="field-error">
                    {t('sas.payments.match.invoice.required')}
                  </small>
                ) : null}
              </div>
              <div className="field">
                <label htmlFor="payments-reason">{t('sas.payments.match.reason.label')}</label>
                <textarea id="payments-reason" rows={2} maxLength={MAX_REASON} value={matching.reason} aria-invalid={matching.tooShort} onChange={(event) => setMatching({ ...matching, reason: event.target.value, tooShort: false })} />
                {matching.tooShort ? (
                  <small role="alert" className="field-error">
                    {t('sas.payments.match.reason.tooShort')}
                  </small>
                ) : null}
              </div>
              <div className="row gap">
                <button type="submit" className="ui-button ui-button--primary" disabled={match.isPending}>
                  {t('sas.payments.match.confirm.action')}
                </button>
                <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => setMatching(undefined)}>
                  {t('sas.payments.match.abort.action')}
                </button>
              </div>
            </form>
          )}
        </SectionCard>
        <SectionCard title={t('sas.payments.invoices.title')} unit={t('dis.wr.unit')}>
          {matching === undefined ? <TenantPicker id="payments-tenant" label={t('sas.payments.tenant.label')} moreLabel={t('sas.payments.tenant.more.action')} choice={choice} /> : null}
          {invoices.isError ? (
            <div className="callout warning" role="alert">
              <p>{t('sas.payments.invoices.error')}</p>
              <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => void invoices.refetch()}>
                {t('sas.payments.invoices.retry.action')}
              </button>
            </div>
          ) : invoices.isLoading || choice.chosen === undefined ? (
            <p className="sub" role="status">
              {t('sas.payments.invoices.loading')}
            </p>
          ) : invoiceItems.length === 0 ? (
            <p className="sub" role="status">
              {t('sas.payments.invoices.none')}
            </p>
          ) : (
            <KitTable caption={t('w2sas.payments.table.invoices')} data-invoices>
              <thead>
                <tr>
                  <th scope="col">{t('sas.payments.invoice.column.invoice')}</th>
                  <th scope="col">{t('sas.payments.invoice.column.number')}</th>
                  <th scope="col">{t('sas.payments.invoice.column.authority')}</th>
                  <th scope="col">{t('sas.payments.invoice.column.status')}</th>
                  <th scope="col" className="amount">
                    {t('sas.payments.invoice.column.total')}
                  </th>
                  <th scope="col">{t('sas.payments.invoice.column.payment')}</th>
                </tr>
              </thead>
              <tbody>
                {invoiceItems.map((invoice) => (
                  <tr key={invoice.id} data-invoice-id={invoice.id} data-status={invoice.status}>
                    <td>
                      <code>{invoice.invoiceCode}</code>
                      <br />
                      <small className="sub">{t('sas.payments.invoice.period', { from: date(invoice.periodStart), until: date(invoice.periodEnd) })}</small>
                    </td>
                    <td data-einvoice-number>{invoice.number === undefined ? '—' : t('sas.payments.invoice.number', { series: invoice.series ?? '', number: invoice.number })}</td>
                    <td data-tax-authority-code>
                      {invoice.taxAuthorityCode === undefined ? '—' : <code>{invoice.taxAuthorityCode}</code>}
                      {invoice.lookupCode === undefined ? null : (
                        <>
                          <br />
                          <small className="sub">{t('sas.payments.invoice.lookup', { code: invoice.lookupCode })}</small>
                        </>
                      )}
                    </td>
                    <td>
                      <StatusPill tone={toneOfPill(toneClass(invoiceStatusTone(invoice.status)))}>{invoiceStatusLabel(t, invoice.status)}</StatusPill>
                    </td>
                    <td className="amount">{money(invoice.totalVnd)}</td>
                    <td data-match-status>
                      {invoice.payments.length === 0 ? (
                        <span className="sub">{t('sas.payments.invoice.noPayment')}</span>
                      ) : (
                        invoice.payments.map((payment) => (
                          <div key={payment.id}>
                            <StatusPill tone={toneOfPill(toneClass(paymentStatusTone(payment.status)))}>{paymentStatusLabel(t, payment.status)}</StatusPill> <small className="sub">{money(payment.amountVnd)}</small>
                          </div>
                        ))
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </KitTable>
          )}
          {invoices.hasNextPage ? (
            <div className="row gap">
              <button type="button" disabled={invoices.isFetchingNextPage} onClick={() => void invoices.fetchNextPage()}>
                {t('sas.payments.invoices.more.action')}
              </button>
            </div>
          ) : null}
        </SectionCard>
      </StateBoundary>
    </section>
  );
}
