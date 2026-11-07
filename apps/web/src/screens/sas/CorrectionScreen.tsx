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
import type { InvoiceView } from './billing/model';
import { useCreateCorrection } from './correction/hooks';
import { kindLabel, linesProblemMessage, lineProblemMessage, problemMessage, totalProblemMessage, vatLabel } from './correction/labels';
import { CORRECTION_KINDS, MANAGE_CORRECTION_PERMISSION, MAX_LINES, MAX_REASON, VAT_CATEGORIES, correctionBody, describeProblem, emptyForm, hasProblems, isCorrectable, newLine, receivableAfter, totalsOf, validateForm } from './correction/model';
import type { CorrectionForm, CorrectionKind, LineForm, VatCategory } from './correction/model';
import { TenantPicker } from './subscription/TenantPicker';
import { useTenantChoice } from './subscription/hooks';
import { toneClass } from './tenants/labels';
import { SectionCard, StatusPill } from '../../ui';
import { KitTable } from '../adm/KitTable';
import '../adm/adm-kit.css';
import './tenants/sas.css';
import './billing/billing.css';
import { toneOfPill } from '../adm/kit-tone';

/**
 * SAS-24: the correction of an issued invoice. There is no way to cancel an invoice: a mistake is corrected by an adjustment (lines that add to or take from what was invoiced, a negative line for a reduction) or by a
 * replacement (the whole invoice again, once), each linked to the invoice it corrects, with the reason and the document in which the buyer agreed. The form shows the totals the lines come to and what the tenant owes once
 * the correction is issued; the correction is made as a Draft and goes out through SAS-09 like any invoice, and only then does the original become Adjusted or Replaced.
 */
export default function CorrectionScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The form and the notices belong to one membership: a switch starts the screen over.
  return <CorrectionContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function CorrectionContent({ route }: ScreenProps) {
  const { t, locale } = useTranslation();
  const { permissions } = useSession();
  const canCorrect = permissions === undefined || permissions.includes(MANAGE_CORRECTION_PERMISSION);
  const choice = useTenantChoice();
  const invoices = useTenantInvoices(choice.chosen);
  const create = useCreateCorrection();
  const [picked, setPicked] = useState<{ tenantId: string | undefined; invoiceId: string; form: CorrectionForm } | undefined>(undefined);
  const [attempted, setAttempted] = useState(false);
  const [done, setDone] = useState<CorrectionKind | undefined>(undefined);

  const state = useScreenState({
    isLoading: invoices.isLoading || (choice.chosen === undefined && choice.isLoading),
    error: choice.chosen === undefined ? choice.error : invoices.error,
    data: choice.chosen === undefined ? undefined : invoices.data,
    isEmpty: () => false,
  });
  const first = invoices.data?.pages[0];
  const items: InvoiceView[] = (invoices.data?.pages ?? []).flatMap((page) => page.items);
  const receivable = first?.receivableVnd ?? '0';
  // The invoice picked belongs to the tenant that was shown when it was picked: another tenant on the screen never inherits it.
  const current = picked !== undefined && picked.tenantId === choice.chosen ? picked : undefined;
  const target = current === undefined ? undefined : items.find((invoice) => invoice.id === current.invoiceId);
  // What the invoice stands for comes from the server, whichever pages of invoices have been read: the adjustments of it may be on a page that was not.
  const standing = target === undefined ? '0' : target.standingVnd;
  const totals = current === undefined ? undefined : totalsOf(current.form.lines);
  const problems = current === undefined ? undefined : validateForm(current.form, standing);
  const shown = attempted ? problems : undefined;
  const problem = create.isError ? describeProblem(create.error) : undefined;
  const billing = routeById('SAS-09');
  const money = (amount: string): string => formatVnd(amount, locale);
  const day = (value: string): string => new Date(`${value}T00:00:00Z`).toLocaleDateString(locale, { timeZone: 'UTC' });

  const open = (invoice: InvoiceView): void => {
    setDone(undefined);
    setAttempted(false);
    create.reset();
    setPicked({ tenantId: choice.chosen, invoiceId: invoice.id, form: emptyForm() });
  };
  const change = (update: Partial<CorrectionForm>): void => {
    if (current === undefined) return;
    setPicked({ ...current, form: { ...current.form, ...update } });
    setDone(undefined);
  };
  const changeLine = (key: number, update: Partial<LineForm>): void => {
    if (current === undefined) return;
    change({ lines: current.form.lines.map((line) => (line.key === key ? { ...line, ...update } : line)) });
  };

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (current === undefined || problems === undefined || create.isPending || !canCorrect) return;
    if (hasProblems(problems)) {
      setAttempted(true);
      return;
    }
    const kind = current.form.kind;
    create.mutate(
      { kind, invoiceId: current.invoiceId, body: correctionBody(current.form) },
      {
        onSuccess: () => {
          setDone(kind);
          setPicked(undefined);
          setAttempted(false);
        },
      },
    );
  };

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title" className="sas-billing">
      {billing === undefined ? null : (
        <p className="sas-back-link">
          <Link to={choice.chosen === undefined ? billing.path : `${billing.path}?tenant=${encodeURIComponent(choice.chosen)}`}>
            <span aria-hidden="true">← </span>
            {t('sas.correction.back.link')}
          </Link>
        </p>
      )}
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('sas.correction.page.title')}</h1>
          <p>{t('sas.correction.page.subtitle')}</p>
        </div>
      </div>
      <TenantPicker id="correction-tenant" label={t('sas.correction.tenant.label')} moreLabel={t('sas.correction.tenant.more.action')} choice={choice} />
      <StateBoundary state={state} onRetry={() => void (choice.chosen === undefined ? choice.refetch() : invoices.refetch())}>
        <SectionCard title={t('sas.correction.invoices.title')} unit={t('dis.wr.unit')}>
          <p className="sub" data-receivable>
            {t('sas.correction.receivable.text', { amount: money(receivable) })}
          </p>
          {done === undefined ? null : (
            <p className="callout" role="status">
              {done === 'ADJUSTMENT' ? t('sas.correction.done.adjustment') : t('sas.correction.done.replacement')}
            </p>
          )}
          {items.length === 0 ? (
            <p className="sub" role="status">
              {t('sas.correction.invoices.none')}
            </p>
          ) : (
            <KitTable caption={t('w2sas.correction.table.invoices')} data-invoices>
              <thead>
                <tr>
                  <th scope="col">{t('sas.correction.column.invoice')}</th>
                  <th scope="col">{t('sas.correction.column.kind')}</th>
                  <th scope="col">{t('sas.correction.column.status')}</th>
                  <th scope="col" className="amount">
                    {t('sas.correction.column.total')}
                  </th>
                  <th scope="col">{t('sas.correction.column.agreement')}</th>
                  <th scope="col">
                    <span className="visually-hidden">{t('sas.correction.column.actions')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {items.map((invoice) => (
                  <tr key={invoice.id} data-invoice-id={invoice.id} data-kind={invoice.kind} data-status={invoice.status}>
                    <td>
                      <code>{invoice.invoiceCode}</code>
                      <br />
                      <small className="sub">{t('sas.correction.period.text', { from: day(invoice.periodStart), until: day(invoice.periodEnd) })}</small>
                    </td>
                    <td>
                      {kindLabel(t, invoice.kind)}
                      {invoice.relatedInvoiceId === undefined ? null : <small className="sub"> {t('sas.correction.of.text', { code: items.find((entry) => entry.id === invoice.relatedInvoiceId)?.invoiceCode ?? '—' })}</small>}
                    </td>
                    <td>
                      <StatusPill tone={toneOfPill(toneClass(invoiceStatusTone(invoice.status)))}>{invoiceStatusLabel(t, invoice.status)}</StatusPill>
                    </td>
                    <td className="amount">{money(invoice.totalVnd)}</td>
                    <td>{invoice.agreementDocumentRef ?? '—'}</td>
                    <td>
                      {canCorrect && isCorrectable(invoice) ? (
                        <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => open(invoice)}>
                          {t('sas.correction.correct.action')}
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </KitTable>
          )}
          {invoices.hasNextPage ? (
            <div className="row gap">
              <button type="button" disabled={invoices.isFetchingNextPage} onClick={() => void invoices.fetchNextPage()}>
                {t('sas.correction.invoices.more.action')}
              </button>
            </div>
          ) : null}
        </SectionCard>
        {problem === undefined ? null : (
          <div className="callout warning" role="alert">
            <p>{problemMessage(t, problem, money)}</p>
          </div>
        )}
        {current === undefined || target === undefined || totals === undefined ? null : (
          <div className="card">
            <form onSubmit={submit} noValidate aria-label={t('sas.correction.form.aria')} className="billing-issue">
              <h2>{t('sas.correction.form.title', { code: target.invoiceCode })}</h2>
              <p className="callout">{t('sas.correction.form.rule')}</p>
              <fieldset className="field">
                <legend>{t('sas.correction.form.kind.label')}</legend>
                {CORRECTION_KINDS.map((kind) => (
                  <label key={kind} className="check">
                    <input type="radio" name="correction-kind" checked={current.form.kind === kind} onChange={() => change({ kind })} /> {kindLabel(t, kind)}
                  </label>
                ))}
              </fieldset>
              <div className="field">
                <label htmlFor="correction-reason">{t('sas.correction.form.reason.label')}</label>
                <textarea id="correction-reason" rows={2} maxLength={MAX_REASON} value={current.form.reason} aria-invalid={shown?.reason !== undefined} onChange={(event) => change({ reason: event.target.value })} />
                {shown?.reason === undefined ? null : (
                  <small role="alert" className="field-error">
                    {t('sas.correction.form.reason.tooShort')}
                  </small>
                )}
              </div>
              <div className="field">
                <label htmlFor="correction-agreement">{t('sas.correction.form.agreement.label')}</label>
                <input id="correction-agreement" value={current.form.agreementRef} aria-invalid={shown?.agreementRef !== undefined} onChange={(event) => change({ agreementRef: event.target.value })} />
                {shown?.agreementRef === undefined ? null : (
                  <small role="alert" className="field-error">
                    {t('sas.correction.form.agreement.tooShort')}
                  </small>
                )}
              </div>
              <KitTable caption={t('w2sas.correction.table.lines')} aria-label={t('sas.correction.lines.aria')}>
                <thead>
                  <tr>
                    <th scope="col">{t('sas.correction.line.description')}</th>
                    <th scope="col" className="amount">
                      {t('sas.correction.line.amount')}
                    </th>
                    <th scope="col">{t('sas.correction.line.vat')}</th>
                    <th scope="col">
                      <span className="visually-hidden">{t('sas.correction.column.actions')}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {current.form.lines.map((line, index) => (
                    <tr key={line.key} data-line={index + 1}>
                      <td>
                        <input aria-label={t('sas.correction.line.description.aria', { n: index + 1 })} value={line.description} aria-invalid={shown?.line[line.key] === 'description'} onChange={(event) => changeLine(line.key, { description: event.target.value })} />
                      </td>
                      <td className="amount">
                        <input
                          aria-label={t('sas.correction.line.amount.aria', { n: index + 1 })}
                          inputMode="numeric"
                          value={line.amount}
                          aria-invalid={shown?.line[line.key] === 'amount' || shown?.line[line.key] === 'zero'}
                          onChange={(event) => changeLine(line.key, { amount: event.target.value })}
                        />
                      </td>
                      <td>
                        <select aria-label={t('sas.correction.line.vat.aria', { n: index + 1 })} value={line.vat} onChange={(event) => changeLine(line.key, { vat: event.target.value as VatCategory })}>
                          {VAT_CATEGORIES.map((category) => (
                            <option key={category} value={category}>
                              {vatLabel(t, category)}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td>
                        {current.form.lines.length > 1 ? (
                          <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => change({ lines: current.form.lines.filter((entry) => entry.key !== line.key) })}>
                            {t('sas.correction.line.remove.action', { n: index + 1 })}
                          </button>
                        ) : null}
                        {shown?.line[line.key] === undefined ? null : (
                          <small role="alert" className="field-error">
                            {lineProblemMessage(t, shown.line[line.key] as NonNullable<(typeof shown.line)[number]>)}
                          </small>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </KitTable>
              {shown?.lines === undefined ? null : (
                <small role="alert" className="field-error">
                  {linesProblemMessage(t, shown.lines)}
                </small>
              )}
              <div className="row gap">
                <button type="button" disabled={current.form.lines.length >= MAX_LINES} onClick={() => change({ lines: [...current.form.lines, newLine()] })}>
                  {t('sas.correction.line.add.action')}
                </button>
              </div>
              <dl className="sas-detail-fields" data-totals>
                <div className="sas-detail-row">
                  <dt>{t('sas.correction.totals.subtotal')}</dt>
                  <dd data-subtotal>{money(totals.subtotal)}</dd>
                </div>
                <div className="sas-detail-row">
                  <dt>{t('sas.correction.totals.vat')}</dt>
                  <dd data-vat>{money(totals.vat)}</dd>
                </div>
                <div className="sas-detail-row">
                  <dt>{t('sas.correction.totals.total')}</dt>
                  <dd data-total>{money(totals.total)}</dd>
                </div>
                <div className="sas-detail-row">
                  <dt>{t('sas.correction.totals.standing')}</dt>
                  <dd data-standing>{money(standing)}</dd>
                </div>
                <div className="sas-detail-row">
                  <dt>{t('sas.correction.totals.receivableAfter')}</dt>
                  <dd data-receivable-after>{money(receivableAfter(current.form.kind, receivable, standing, totals.total))}</dd>
                </div>
              </dl>
              {shown?.total === undefined ? null : (
                <small role="alert" className="field-error">
                  {totalProblemMessage(t, shown.total)}
                </small>
              )}
              <div className="row gap">
                <button type="submit" className="ui-button ui-button--primary" disabled={create.isPending}>
                  {t('sas.correction.form.submit.action')}
                </button>
                <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => setPicked(undefined)}>
                  {t('sas.correction.form.close.action')}
                </button>
              </div>
            </form>
          </div>
        )}
      </StateBoundary>
    </section>
  );
}
