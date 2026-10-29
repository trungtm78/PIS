import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import { routeById } from '../../routes/registry';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { TenantPicker } from './subscription/TenantPicker';
import { useTenantChoice } from './subscription/hooks';
import { useIssueInvoice, useRunBilling, useTenantInvoices } from './billing/hooks';
import { fieldProblemMessage, kindLabel, problemMessage, statusLabel, statusTone } from './billing/labels';
import { EMPTY_RUN, MANAGE_BILLING_PERMISSION, MAX_REASON, describeProblem, formatVnd, isReasonValid, validateRun } from './billing/model';
import type { InvoiceView, RunField, RunForm } from './billing/model';
import { toneClass } from './tenants/labels';
import './tenants/sas.css';
import './billing/billing.css';

type Context = 'run' | 'issue';
type IssueNotice = 'ISSUED' | 'PENDING_ISSUE' | 'ISSUE_FAILED';

/**
 * SAS-09: the billing and the e-invoices of a tenant. The billing operator picks a tenant, runs the billing for a period (one Draft original invoice for each subscription whose billing period is that one,
 * and none more when it is run again) and issues a Draft, or an invoice that could not be issued, to the buyer through the provider of e-invoices. An invoice that the provider has not answered for waits, and
 * the page follows it. A tenant past due is told so, and so is a proposal to suspend it: the screen only says it, and only a System Admin decides a suspension. There is nothing here to cancel an invoice: a
 * mistake in an issued invoice is corrected by an adjustment or a replacement (SAS-24).
 */
export default function BillingScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The form and the notices belong to one membership: a switch starts the screen over.
  return <BillingContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function BillingContent({ route }: ScreenProps) {
  const { t, locale } = useTranslation();
  const { permissions } = useSession();
  const canManage = permissions === undefined || permissions.includes(MANAGE_BILLING_PERMISSION);
  const choice = useTenantChoice();
  const invoices = useTenantInvoices(choice.chosen);
  const run = useRunBilling();
  const issue = useIssueInvoice();
  const [form, setForm] = useState<RunForm>(EMPTY_RUN);
  const [attempted, setAttempted] = useState(false);
  const [chosenIssue, setIssuing] = useState<{ tenantId: string | undefined; invoice: InvoiceView; reason: string; tooShort: boolean } | undefined>(undefined);
  // The invoice picked for issue belongs to the tenant that was shown when it was picked: another tenant on the screen never inherits it.
  const issuing = chosenIssue !== undefined && chosenIssue.tenantId === choice.chosen ? chosenIssue : undefined;
  const [notice, setNotice] = useState<'run' | IssueNotice | undefined>(undefined);
  const [context, setContext] = useState<Context>('run');

  const waiting = choice.chosen === undefined && choice.isLoading;
  const state = useScreenState({
    isLoading: invoices.isLoading || waiting,
    error: choice.chosen === undefined ? choice.error : invoices.error,
    data: choice.chosen === undefined ? undefined : invoices.data,
    isEmpty: () => false,
  });
  // The first page says how the subscription stands; the pages together are the invoices, the latest period first.
  const first = invoices.data?.pages[0];
  const data = first === undefined ? undefined : { ...first, items: (invoices.data?.pages ?? []).flatMap((page) => page.items) };
  const problems = validateRun(form);
  const shown = attempted ? problems : {};
  const failure = context === 'run' ? run : issue;
  const problem = failure.isError ? describeProblem(failure.error) : undefined;
  const subscriptionRoute = routeById('SAS-07');
  const day = (value: string): string => new Date(`${value}T00:00:00Z`).toLocaleDateString(locale, { timeZone: 'UTC' });
  const instant = (value: string): string => new Date(value).toLocaleString(locale, { timeZone: 'UTC' });

  const change = (field: RunField, value: string): void => {
    setForm((current) => ({ ...current, [field]: value }));
    setNotice(undefined);
  };

  const submitRun = (event: FormEvent): void => {
    event.preventDefault();
    if (run.isPending || !canManage || choice.chosen === undefined) return;
    if (Object.keys(problems).length > 0) {
      setAttempted(true);
      return;
    }
    setContext('run');
    run.mutate(
      { tenantId: choice.chosen, periodStart: form.periodStart, periodEnd: form.periodEnd },
      {
        onSuccess: () => {
          setNotice('run');
          setAttempted(false);
        },
      },
    );
  };

  const confirmIssue = (event: FormEvent): void => {
    event.preventDefault();
    if (issuing === undefined || issue.isPending) return;
    if (!isReasonValid(issuing.reason)) {
      setIssuing({ ...issuing, tooShort: true });
      return;
    }
    setContext('issue');
    issue.mutate(
      { invoiceId: issuing.invoice.id, version: issuing.invoice.version, reason: issuing.reason.trim() },
      {
        onSuccess: (result) => {
          const status = (result as { status?: string } | undefined)?.status;
          setNotice(status === 'PENDING_ISSUE' || status === 'ISSUE_FAILED' ? status : 'ISSUED');
          setIssuing(undefined);
        },
      },
    );
  };

  const fieldError = (field: RunField) => {
    const found = shown[field];
    return found === undefined ? null : (
      <small role="alert" className="field-error">
        {fieldProblemMessage(t, found)}
      </small>
    );
  };

  const noticeText = (): string | undefined => {
    switch (notice) {
      case 'run':
        return t('sas.billing.run.done');
      case 'ISSUED':
        return t('sas.billing.issue.done.issued');
      case 'PENDING_ISSUE':
        return t('sas.billing.issue.done.pending');
      case 'ISSUE_FAILED':
        return t('sas.billing.issue.done.failed');
      case undefined:
        return undefined;
    }
  };

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title" className="sas-billing">
      {subscriptionRoute === undefined ? null : (
        <p className="sas-back-link">
          <Link to={choice.chosen === undefined ? subscriptionRoute.path : `${subscriptionRoute.path}?tenant=${encodeURIComponent(choice.chosen)}`}>
            <span aria-hidden="true">← </span>
            {t('sas.billing.back.link')}
          </Link>
        </p>
      )}
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('sas.billing.page.title')}</h1>
          <p>{t('sas.billing.page.subtitle')}</p>
        </div>
      </div>
      <TenantPicker id="billing-tenant" label={t('sas.billing.tenant.label')} moreLabel={t('sas.billing.tenant.more.action')} choice={choice} />
      <StateBoundary state={state} onRetry={() => void (choice.chosen === undefined ? choice.refetch() : invoices.refetch())}>
        {data?.pastDueSince === undefined ? null : (
          <div className="callout warning" role="status" data-past-due>
            <p>{t('sas.billing.notice.pastDue', { day: instant(data.pastDueSince) })}</p>
            {data.suspensionProposedAt === undefined ? null : <p data-suspension-proposed>{t('sas.billing.notice.suspension', { day: instant(data.suspensionProposedAt) })}</p>}
          </div>
        )}
        {canManage ? (
          <div className="card">
            <form onSubmit={submitRun} noValidate aria-label={t('sas.billing.run.aria')} className="billing-run">
              <h2>{t('sas.billing.run.title')}</h2>
              <p className="sub">{t('sas.billing.run.hint')}</p>
              <div className="formgrid">
                <div className="field">
                  <label htmlFor="billing-start">{t('sas.billing.run.start.label')}</label>
                  <input id="billing-start" type="date" value={form.periodStart} aria-invalid={shown.periodStart !== undefined} onChange={(event) => change('periodStart', event.target.value)} />
                  {fieldError('periodStart')}
                </div>
                <div className="field">
                  <label htmlFor="billing-end">{t('sas.billing.run.end.label')}</label>
                  <input id="billing-end" type="date" value={form.periodEnd} aria-invalid={shown.periodEnd !== undefined} onChange={(event) => change('periodEnd', event.target.value)} />
                  {fieldError('periodEnd')}
                </div>
              </div>
              <div className="row gap">
                <button type="submit" className="primary" disabled={run.isPending || choice.chosen === undefined}>
                  {t('sas.billing.run.submit.action')}
                </button>
              </div>
            </form>
          </div>
        ) : null}
        {noticeText() === undefined ? null : (
          <p className="callout" role="status">
            {noticeText()}
          </p>
        )}
        {problem === undefined ? null : (
          <div className="callout warning" role="alert">
            <p>{problemMessage(t, problem)}</p>
          </div>
        )}
        <div className="card">
          <h2>{t('sas.billing.invoices.title')}</h2>
          {data === undefined || data.items.length === 0 ? (
            <p className="sub" role="status">
              {t('sas.billing.invoices.none')}
            </p>
          ) : (
            <table className="table" data-invoices>
              <thead>
                <tr>
                  <th scope="col">{t('sas.billing.column.period')}</th>
                  <th scope="col">{t('sas.billing.column.code')}</th>
                  <th scope="col">{t('sas.billing.column.status')}</th>
                  <th scope="col" className="amount">
                    {t('sas.billing.column.total')}
                  </th>
                  <th scope="col">{t('sas.billing.column.due')}</th>
                  <th scope="col">{t('sas.billing.column.number')}</th>
                  <th scope="col">
                    <span className="visually-hidden">{t('sas.billing.column.actions')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((invoice) => (
                  <tr key={invoice.id} data-invoice-id={invoice.id} data-status={invoice.status}>
                    <td>{t('sas.billing.period.text', { from: day(invoice.periodStart), until: day(invoice.periodEnd) })}</td>
                    <td>
                      <code>{invoice.invoiceCode}</code>
                    </td>
                    <td>
                      <span className={toneClass(statusTone(invoice.status))}>{statusLabel(t, invoice.status)}</span>
                      {invoice.status === 'PendingIssue' || invoice.status === 'IssueFailed' ? (
                        <small className="sub" data-attempts>
                          {' '}
                          {t('sas.billing.attempts.text', { count: invoice.issueAttempts })}
                          {invoice.nextAttemptAt === undefined ? '' : ` · ${t('sas.billing.next.text', { at: instant(invoice.nextAttemptAt) })}`}
                        </small>
                      ) : null}
                    </td>
                    <td className="amount">
                      {formatVnd(invoice.totalVnd, locale)}
                      <small className="sub"> {t('sas.billing.vat.text', { amount: formatVnd(invoice.vatVnd, locale) })}</small>
                    </td>
                    <td>{invoice.dueAt === undefined ? '—' : day(invoice.dueAt)}</td>
                    <td>{invoice.number === undefined ? '—' : t('sas.billing.number.text', { series: invoice.series ?? '', number: invoice.number })}</td>
                    <td>
                      {canManage && invoice.canIssue ? (
                        <button type="button" onClick={() => setIssuing({ tenantId: choice.chosen, invoice, reason: '', tooShort: false })}>
                          {t('sas.billing.issue.action')}
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {invoices.hasNextPage ? (
            <div className="row gap">
              <button type="button" disabled={invoices.isFetchingNextPage} onClick={() => void invoices.fetchNextPage()}>
                {t('sas.billing.invoices.more.action')}
              </button>
            </div>
          ) : null}
          {data?.items.map((invoice) => (
            <details key={invoice.id} className="billing-lines" data-lines-of={invoice.id}>
              <summary>{t('sas.billing.lines.summary', { code: invoice.invoiceCode, count: invoice.lines.length })}</summary>
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">{t('sas.billing.line.kind')}</th>
                    <th scope="col">{t('sas.billing.line.description')}</th>
                    <th scope="col" className="amount">
                      {t('sas.billing.line.amount')}
                    </th>
                    <th scope="col" className="amount">
                      {t('sas.billing.line.vat')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {invoice.lines.map((line) => (
                    <tr key={line.id}>
                      <td>{kindLabel(t, line.kind)}</td>
                      <td>{line.description}</td>
                      <td className="amount">{formatVnd(line.amountVnd, locale)}</td>
                      <td className="amount">{formatVnd(line.vatVnd, locale)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          ))}
          {issuing === undefined ? null : (
            <form onSubmit={confirmIssue} noValidate aria-label={t('sas.billing.issue.aria')} className="billing-issue">
              <p className="callout">{t('sas.billing.issue.rule', { code: issuing.invoice.invoiceCode })}</p>
              <div className="field">
                <label htmlFor="billing-issue-reason">{t('sas.billing.issue.reason.label')}</label>
                <textarea id="billing-issue-reason" rows={2} maxLength={MAX_REASON} value={issuing.reason} aria-invalid={issuing.tooShort} onChange={(event) => setIssuing({ ...issuing, reason: event.target.value, tooShort: false })} />
                {issuing.tooShort ? (
                  <small role="alert" className="field-error">
                    {t('sas.billing.issue.reason.tooShort')}
                  </small>
                ) : null}
              </div>
              <div className="row gap">
                <button type="submit" className="primary" disabled={issue.isPending}>
                  {t('sas.billing.issue.confirm.action')}
                </button>
                <button type="button" onClick={() => setIssuing(undefined)}>
                  {t('sas.billing.issue.abort.action')}
                </button>
              </div>
            </form>
          )}
        </div>
      </StateBoundary>
    </section>
  );
}
