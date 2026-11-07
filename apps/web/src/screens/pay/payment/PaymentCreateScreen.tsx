import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { SectionCard, StickyActions } from '../../../ui';
import { useLineChoices } from '../../bid/plan-hooks';
import { useAcceptances } from '../../ctr/acceptance/hooks';
import { BackLink, Field } from '../../ctr/components';
import { useContracts } from '../../ctr/hooks';
import { useCreatePayment } from './hooks';
import { formProblemMessage, problemMessage, warningMessage } from './labels';
import { EMPTY_CREATE, canCreate, createBody, describeProblem, listLink, paymentLink, signedAmountText, validateCreate, valuationLink } from './model';
import type { CreateForm, PaymentAnswer } from './model';
import '../pay.css';

/**
 * PAY-02: draw up a payment request from an approved acceptance (ST-PAY-002, PAY 3.1 step 1). The person chooses the contract, the acceptance, the line of capital and gives the number of the
 * file, a tax adjustment with its basis and, if wanted, an extra recovery of the advance. Gross, recovery, retention and net are not asked for: the server computes them from the acceptance and
 * the ledger, and the screen shows them once the request is drawn up. A draft takes no claim on the acceptance; sending it is a later step.
 */
export default function PaymentCreateScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The form belongs to one membership: a switch of tenant or of membership starts the screen over.
  return <PaymentCreateContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function PaymentCreateContent({ route }: ScreenProps) {
  const { t, locale } = useTranslation();
  const { permissions, mode } = useSession();
  const [search] = useSearchParams();
  const [form, setForm] = useState<CreateForm>({
    ...EMPTY_CREATE,
    contractId: search.get('contract') ?? '',
  });
  const [submitted, setSubmitted] = useState(false);
  const [done, setDone] = useState<PaymentAnswer | undefined>(undefined);
  const create = useCreatePayment();
  const contracts = useContracts();
  const acceptances = useAcceptances(form.contractId === '' ? null : form.contractId);
  const lines = useLineChoices();
  const contract = (contracts.data ?? []).find((candidate) => candidate.id === form.contractId);
  const approved = (acceptances.data ?? []).filter((acceptance) => acceptance.status === 'APPROVED');
  const ofProject = (lines.data ?? []).filter((line) => contract !== undefined && line.projectId === contract.projectId);
  const problems = validateCreate(form);
  const shown = (field: keyof CreateForm): string | undefined => {
    const problem = problems[field];
    return submitted && problem !== undefined ? formProblemMessage(t, problem) : undefined;
  };
  const money = (value: string): string => signedAmountText(value, locale) ?? value;
  const set = (patch: Partial<CreateForm>): void => setForm({ ...form, ...patch });
  const send = (event: FormEvent): void => {
    event.preventDefault();
    setSubmitted(true);
    if (create.isPending || Object.keys(problems).length > 0) return;
    create.mutate(createBody(form), { onSuccess: (answer) => setDone(answer) });
  };

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <BackLink to={listLink()}>{t('pay.payment.create.back')}</BackLink>
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('pay.payment.create.title')}</h1>
          <p>{t('pay.payment.create.subtitle')}</p>
        </div>
      </div>
      {!canCreate(permissions, mode) ? (
        <p className="callout" role="status" data-testid="no-right">
          {t('pay.payment.create.noRight')}
        </p>
      ) : done !== undefined ? (
        <div data-testid="result">
          <SectionCard title={t('pay.payment.create.result')} unit={t('w2pay.ctx.unit')}>
            <dl className="pay-facts">
              <dt>{t('pay.payment.fact.gross')}</dt>
              <dd data-testid="result-gross">{money(done.grossVnd)}</dd>
              <dt>{t('pay.payment.fact.recovery')}</dt>
              <dd data-testid="result-recovery">{money(done.advanceRecoveryVnd)}</dd>
              <dt>{t('pay.payment.fact.retention')}</dt>
              <dd data-testid="result-retention">{money(done.retentionVnd)}</dd>
              <dt>{t('pay.payment.fact.tax')}</dt>
              <dd data-testid="result-tax">{money(done.taxAdjustmentVnd)}</dd>
              <dt>{t('pay.payment.fact.net')}</dt>
              <dd data-testid="result-net">{money(done.netVnd)}</dd>
            </dl>
            {done.warnings.length === 0 ? null : (
              <ul className="pay-warnings" data-testid="warnings">
                {done.warnings.map((warning) => (
                  <li key={warning} role="status">
                    {warningMessage(t, warning)}
                  </li>
                ))}
              </ul>
            )}
            <div className="pay-row-actions">
              <Link className="ui-button ui-button--primary" to={paymentLink(done.id)} data-testid="open-request">
                {t('pay.payment.create.open')}
              </Link>
              <Link className="ui-button ui-button--outline" to={valuationLink(done.id)}>
                {t('pay.payment.create.valuation')}
              </Link>
              <Link className="ui-button ui-button--outline" to={listLink(form.contractId === '' ? undefined : form.contractId)}>
                {t('pay.payment.create.list')}
              </Link>
            </div>
          </SectionCard>
        </div>
      ) : (
        <form onSubmit={send} noValidate data-testid="form">
          {create.isError ? (
            <p className="callout warning" role="alert" data-testid="refusal">
              {problemMessage(t, describeProblem(create.error))}
            </p>
          ) : null}
          <SectionCard title={t('w2pay.pay.create.section.source')}>
            <div className="pay-form-grid">
              <Field id="payment-contract" label={t('pay.payment.field.contract')} error={shown('contractId')}>
                <select
                  id="payment-contract"
                  value={form.contractId}
                  onChange={(event) =>
                    set({
                      contractId: event.target.value,
                      acceptanceId: '',
                      allocationLineId: '',
                    })
                  }
                >
                  <option value="">{t('pay.payment.field.choose')}</option>
                  {(contracts.data ?? []).map((candidate) => (
                    <option key={candidate.id} value={candidate.id}>
                      {candidate.code}
                    </option>
                  ))}
                </select>
              </Field>
              <Field
                id="payment-acceptance"
                label={t('pay.payment.field.acceptance')}
                error={shown('acceptanceId')}
                hint={form.contractId !== '' && approved.length === 0 ? t('pay.payment.field.acceptance.none') : undefined}
              >
                <select id="payment-acceptance" value={form.acceptanceId} onChange={(event) => set({ acceptanceId: event.target.value })}>
                  <option value="">{t('pay.payment.field.choose')}</option>
                  {approved.map((acceptance) => (
                    <option key={acceptance.id} value={acceptance.id}>
                      {t('pay.payment.field.acceptance.option', {
                        no: acceptance.acceptanceNo,
                        amount: money(acceptance.amountVnd),
                      })}
                    </option>
                  ))}
                </select>
              </Field>
              <Field id="payment-line" label={t('pay.payment.field.line')} error={shown('allocationLineId')} hint={t('pay.payment.field.line.hint')}>
                <select id="payment-line" value={form.allocationLineId} onChange={(event) => set({ allocationLineId: event.target.value })}>
                  <option value="">{t('pay.payment.field.choose')}</option>
                  {ofProject.map((line) => (
                    <option key={line.id} value={line.id}>
                      {line.label}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
          </SectionCard>
          <SectionCard title={t('w2pay.pay.create.section.adjust')} unit={t('w2pay.ctx.unit')}>
            <div className="pay-form-grid">
              <Field id="payment-no" label={t('pay.payment.field.requestNo')} error={shown('requestNo')} hint={t('pay.payment.field.requestNo.hint')}>
                <input id="payment-no" autoComplete="off" value={form.requestNo} onChange={(event) => set({ requestNo: event.target.value })} />
              </Field>
              <Field id="payment-tax" label={t('pay.payment.field.tax')} error={shown('taxAdjustment')} hint={t('pay.payment.field.tax.hint')}>
                <input id="payment-tax" inputMode="numeric" autoComplete="off" value={form.taxAdjustment} onChange={(event) => set({ taxAdjustment: event.target.value })} />
              </Field>
              <Field id="payment-tax-basis" label={t('pay.payment.field.taxBasis')} error={shown('taxBasis')}>
                <input id="payment-tax-basis" autoComplete="off" value={form.taxBasis} onChange={(event) => set({ taxBasis: event.target.value })} />
              </Field>
              <Field id="payment-extra" label={t('pay.payment.field.extra')} error={shown('extraRecovery')} hint={t('pay.payment.field.extra.hint')}>
                <input id="payment-extra" inputMode="numeric" autoComplete="off" value={form.extraRecovery} onChange={(event) => set({ extraRecovery: event.target.value })} />
              </Field>
            </div>
            <p className="sub">{t('pay.payment.create.serverNumbers')}</p>
          </SectionCard>
          <StickyActions
            primary={
              <button type="submit" className="ui-button ui-button--primary" disabled={create.isPending}>
                {create.isPending ? t('pay.payment.create.pending') : t('pay.payment.create.submit')}
              </button>
            }
            secondary={[
              <Link key="cancel" className="ui-button ui-button--outline" to={listLink(form.contractId === '' ? undefined : form.contractId)}>
                {t('pay.payment.create.cancel')}
              </Link>,
            ]}
          />
        </form>
      )}
      <p className="prototype-note">{t('pay.payment.create.footer', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
