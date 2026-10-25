import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import { routeById } from '../../routes/registry';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { usePlans } from './plan/hooks';
import { cycleLabel, planName } from './plan/labels';
import { toneClass } from './tenants/labels';
import { TenantPicker } from './subscription/TenantPicker';
import { useCancelSubscription, useCreateSubscription, useTenantChoice, useTenantSubscription } from './subscription/hooks';
import { fieldProblemMessage, methodLabel, problemMessage, statusLabel, statusTone } from './subscription/labels';
import {
  CYCLES,
  EMPTY_FORM,
  MANAGE_SUBSCRIPTION_PERMISSION,
  MAX_CONTRACT_REF,
  MAX_DUE_DAYS,
  MAX_REASON,
  MAX_TRIAL_DAYS,
  PAYMENT_METHODS,
  createBody,
  describeProblem,
  formatVnd,
  isReasonValid,
  validateForm,
} from './subscription/model';
import type { FormField, PaymentMethod, SubscriptionForm } from './subscription/model';
import './tenants/sas.css';
import './subscription/subscription.css';

type Context = 'create' | 'cancel';

/**
 * SAS-07: the subscription of a tenant. The billing operator picks a tenant and sees its live subscription (plan, cycle, period, trial, contract, payment terms, what waits);
 * a tenant with none gets a form that starts one on a published plan (a trial when it has days) and records the entitlements of the plan; one that is live can be cancelled
 * with a reason (a trial ends at once, a paid subscription at the end of its period). A change of plan is SAS-08.
 */
export default function SubscriptionScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The form and the notices belong to one membership: a switch starts the screen over.
  return <SubscriptionContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function SubscriptionContent({ route }: ScreenProps) {
  const { t, locale } = useTranslation();
  const { permissions } = useSession();
  const canManage = permissions === undefined || permissions.includes(MANAGE_SUBSCRIPTION_PERMISSION);
  const choice = useTenantChoice();
  const subscription = useTenantSubscription(choice.chosen);
  const plans = usePlans(canManage);
  const create = useCreateSubscription();
  const cancel = useCancelSubscription();
  const [form, setForm] = useState<SubscriptionForm>(EMPTY_FORM);
  const [attempted, setAttempted] = useState(false);
  const [cancelling, setCancelling] = useState<{ reason: string; tooShort: boolean } | undefined>(undefined);
  const [notice, setNotice] = useState<Context | undefined>(undefined);
  const [context, setContext] = useState<Context>('create');

  const waiting = choice.chosen === undefined && choice.isLoading;
  const state = useScreenState({
    isLoading: subscription.isLoading || waiting,
    error: choice.chosen === undefined ? choice.error : subscription.error,
    data: choice.chosen === undefined ? undefined : subscription.data,
    isEmpty: () => false,
  });
  const data = subscription.data;
  const live = data?.subscription;
  const published = (plans.data ?? []).filter((plan) => plan.status === 'Published');
  const chosenPlan = published.find((plan) => plan.id === form.planVersionId);
  const problems = validateForm(form);
  const shown = attempted ? problems : {};
  const failure = context === 'create' ? create : cancel;
  const problem = failure.isError ? describeProblem(failure.error) : undefined;
  const changeRoute = routeById('SAS-08');
  const billing = routeById('SAS-09');
  const date = (value: string): string => new Date(`${value}T00:00:00Z`).toLocaleDateString(locale, { timeZone: 'UTC' });
  const instant = (value: string): string => new Date(value).toLocaleDateString(locale, { timeZone: 'UTC' });

  const change = <K extends keyof SubscriptionForm>(field: K, value: SubscriptionForm[K]): void => {
    setForm((current) => ({ ...current, [field]: value }));
    setNotice(undefined);
  };
  const pickPlan = (planVersionId: string): void => {
    const plan = published.find((candidate) => candidate.id === planVersionId);
    setForm((current) => ({ ...current, planVersionId, cycle: plan === undefined || (current.cycle !== '' && plan.billingCycles.includes(current.cycle)) ? current.cycle : (plan.billingCycles[0] ?? '') }));
    setNotice(undefined);
  };

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (create.isPending || !canManage || choice.chosen === undefined) return;
    if (Object.keys(problems).length > 0) {
      setAttempted(true);
      return;
    }
    setContext('create');
    create.mutate(
      { tenantId: choice.chosen, body: createBody(form) },
      {
        onSuccess: () => {
          setNotice('create');
          setForm(EMPTY_FORM);
          setAttempted(false);
        },
      },
    );
  };

  const confirmCancel = (event: FormEvent): void => {
    event.preventDefault();
    if (cancelling === undefined || live === undefined || cancel.isPending) return;
    if (!isReasonValid(cancelling.reason)) {
      setCancelling({ ...cancelling, tooShort: true });
      return;
    }
    setContext('cancel');
    cancel.mutate(
      { subscriptionId: live.id, version: live.version, reason: cancelling.reason.trim() },
      {
        onSuccess: () => {
          setNotice('cancel');
          setCancelling(undefined);
        },
      },
    );
  };

  const errorOf = (field: FormField): string | undefined => {
    const found = shown[field];
    return found === undefined ? undefined : fieldProblemMessage(t, found);
  };
  const error = (field: FormField) =>
    errorOf(field) === undefined ? null : (
      <small role="alert" className="field-error">
        {errorOf(field)}
      </small>
    );

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title" className="sas-subscription">
      {billing === undefined ? null : (
        <p className="sas-back-link">
          <Link to={billing.path}>
            <span aria-hidden="true">← </span>
            {t('sas.subscription.back.link')}
          </Link>
        </p>
      )}
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('sas.subscription.page.title')}</h1>
          <p>{t('sas.subscription.page.subtitle')}</p>
        </div>
      </div>
      <TenantPicker id="subscription-tenant" label={t('sas.subscription.tenant.label')} moreLabel={t('sas.subscription.tenant.more.action')} choice={choice} />
      <StateBoundary state={state} onRetry={() => void (choice.chosen === undefined ? choice.refetch() : subscription.refetch())}>
        <div className="card">
          <h2>{t('sas.subscription.current.title')}</h2>
          {live === undefined || data === undefined ? (
            <p className="sub" role="status">
              {t('sas.subscription.current.none')}
            </p>
          ) : (
            <dl className="sas-detail-fields" data-subscription-id={live.id} data-status={live.status}>
              <div className="sas-detail-row">
                <dt>{t('sas.subscription.field.plan')}</dt>
                <dd>{data.plan === undefined ? live.planVersionId : t('sas.subscription.plan.text', { name: planName(t, data.plan.name), code: data.plan.planCode, revision: data.plan.revision })}</dd>
              </div>
              <div className="sas-detail-row">
                <dt>{t('sas.subscription.field.price')}</dt>
                <dd>{data.plan === undefined ? '—' : t('sas.subscription.price.text', { amount: formatVnd(data.plan.basePriceVnd, locale) })}</dd>
              </div>
              <div className="sas-detail-row">
                <dt>{t('sas.subscription.field.status')}</dt>
                <dd>
                  <span className={toneClass(statusTone(live.status))}>{statusLabel(t, live.status)}</span>
                  {live.cancelAtPeriodEnd ? <small className="sub"> {t('sas.subscription.cancelAtEnd.text', { day: date(live.currentPeriodEnd) })}</small> : null}
                </dd>
              </div>
              <div className="sas-detail-row">
                <dt>{t('sas.subscription.field.cycle')}</dt>
                <dd>{cycleLabel(t, live.cycle)}</dd>
              </div>
              <div className="sas-detail-row">
                <dt>{t('sas.subscription.field.period')}</dt>
                <dd>{t('sas.subscription.period.text', { from: date(live.currentPeriodStart), until: date(live.currentPeriodEnd) })}</dd>
              </div>
              {live.trialEndsAt === undefined ? null : (
                <div className="sas-detail-row">
                  <dt>{t('sas.subscription.field.trialEnds')}</dt>
                  <dd>{instant(live.trialEndsAt)}</dd>
                </div>
              )}
              <div className="sas-detail-row">
                <dt>{t('sas.subscription.field.contract')}</dt>
                <dd>{live.procurementContractRef ?? t('sas.subscription.contract.none')}</dd>
              </div>
              <div className="sas-detail-row">
                <dt>{t('sas.subscription.field.terms')}</dt>
                <dd>{live.dueDays === undefined || live.method === undefined ? '—' : t('sas.subscription.terms.text', { days: live.dueDays, method: methodLabel(t, live.method) })}</dd>
              </div>
              {data.pendingPlan === undefined || live.pendingEffectiveAt === undefined ? null : (
                <div className="sas-detail-row" data-pending-plan={data.pendingPlan.id}>
                  <dt>{t('sas.subscription.field.pending')}</dt>
                  <dd>{t('sas.subscription.pending.text', { name: planName(t, data.pendingPlan.name), code: data.pendingPlan.planCode, revision: data.pendingPlan.revision, day: instant(live.pendingEffectiveAt) })}</dd>
                </div>
              )}
            </dl>
          )}
          {notice === undefined ? null : (
            <p className="callout" role="status">
              {notice === 'create' ? t('sas.subscription.done.created') : t('sas.subscription.done.cancelled')}
            </p>
          )}
          {problem === undefined ? null : (
            <div className="callout warning" role="alert">
              <p>{problemMessage(t, problem)}</p>
            </div>
          )}
          {live === undefined ? null : (
            <div className="row gap subscription-actions">
              {changeRoute === undefined || choice.chosen === undefined ? null : (
                <Link className="button-link" to={`${changeRoute.path}?tenant=${encodeURIComponent(choice.chosen)}`}>
                  {t('sas.subscription.change.link')}
                </Link>
              )}
              {canManage && !live.cancelAtPeriodEnd && cancelling === undefined ? (
                <button type="button" onClick={() => setCancelling({ reason: '', tooShort: false })}>
                  {t('sas.subscription.cancel.action')}
                </button>
              ) : null}
            </div>
          )}
          {cancelling === undefined ? null : (
            <form onSubmit={confirmCancel} noValidate aria-label={t('sas.subscription.cancel.aria')} className="subscription-cancel">
              <p className="callout">{live?.status === 'Trialing' ? t('sas.subscription.cancel.rule.trial') : t('sas.subscription.cancel.rule.paid')}</p>
              <div className="field">
                <label htmlFor="subscription-cancel-reason">{t('sas.subscription.cancel.reason.label')}</label>
                <textarea
                  id="subscription-cancel-reason"
                  rows={2}
                  maxLength={MAX_REASON}
                  value={cancelling.reason}
                  aria-invalid={cancelling.tooShort}
                  onChange={(event) => setCancelling({ reason: event.target.value, tooShort: false })}
                />
                {cancelling.tooShort ? (
                  <small role="alert" className="field-error">
                    {t('sas.subscription.cancel.reason.tooShort')}
                  </small>
                ) : null}
              </div>
              <div className="row gap">
                <button type="submit" className="primary" disabled={cancel.isPending}>
                  {t('sas.subscription.cancel.confirm.action')}
                </button>
                <button type="button" onClick={() => setCancelling(undefined)}>
                  {t('sas.subscription.cancel.abort.action')}
                </button>
              </div>
            </form>
          )}
        </div>

        {live !== undefined ? null : canManage ? (
          <div className="card">
            <form onSubmit={submit} noValidate aria-label={t('sas.subscription.form.aria')} className="subscription-form">
              <h2>{t('sas.subscription.form.title')}</h2>
              <p className="sub">{t('sas.subscription.form.hint')}</p>
              <div className="formgrid">
                <div className="field">
                  <label htmlFor="subscription-plan">{t('sas.subscription.form.plan.label')}</label>
                  <select id="subscription-plan" value={form.planVersionId} aria-invalid={shown.planVersionId !== undefined} onChange={(event) => pickPlan(event.target.value)}>
                    <option value="">{t('sas.subscription.form.choose.option')}</option>
                    {published.map((plan) => (
                      <option key={plan.id} value={plan.id}>
                        {t('sas.subscription.plan.option', { name: planName(t, plan.name), code: plan.planCode, revision: plan.revision, amount: formatVnd(plan.basePriceVnd, locale) })}
                      </option>
                    ))}
                  </select>
                  {error('planVersionId')}
                </div>
                <div className="field">
                  <label htmlFor="subscription-cycle">{t('sas.subscription.form.cycle.label')}</label>
                  <select id="subscription-cycle" value={form.cycle} aria-invalid={shown.cycle !== undefined} onChange={(event) => change('cycle', event.target.value as SubscriptionForm['cycle'])}>
                    <option value="">{t('sas.subscription.form.choose.option')}</option>
                    {CYCLES.filter((cycle) => chosenPlan === undefined || chosenPlan.billingCycles.includes(cycle)).map((cycle) => (
                      <option key={cycle} value={cycle}>
                        {cycleLabel(t, cycle)}
                      </option>
                    ))}
                  </select>
                  {error('cycle')}
                </div>
                <div className="field">
                  <label htmlFor="subscription-anchor">{t('sas.subscription.form.anchor.label')}</label>
                  <input id="subscription-anchor" type="date" value={form.billingAnchor} aria-invalid={shown.billingAnchor !== undefined} onChange={(event) => change('billingAnchor', event.target.value)} />
                  {error('billingAnchor')}
                </div>
                <div className="field">
                  <label htmlFor="subscription-trial">{t('sas.subscription.form.trial.label', { max: MAX_TRIAL_DAYS })}</label>
                  <input id="subscription-trial" inputMode="numeric" value={form.trialDays} aria-invalid={shown.trialDays !== undefined} onChange={(event) => change('trialDays', event.target.value)} />
                  {error('trialDays')}
                </div>
                <div className="field">
                  <label htmlFor="subscription-contract">{t('sas.subscription.form.contract.label')}</label>
                  <input id="subscription-contract" maxLength={MAX_CONTRACT_REF + 1} value={form.contractRef} aria-invalid={shown.contractRef !== undefined} onChange={(event) => change('contractRef', event.target.value)} />
                  {error('contractRef')}
                </div>
                <div className="field">
                  <label htmlFor="subscription-due">{t('sas.subscription.form.due.label', { max: MAX_DUE_DAYS })}</label>
                  <input id="subscription-due" inputMode="numeric" value={form.dueDays} aria-invalid={shown.dueDays !== undefined} onChange={(event) => change('dueDays', event.target.value)} />
                  {error('dueDays')}
                </div>
                <div className="field">
                  <label htmlFor="subscription-method">{t('sas.subscription.form.method.label')}</label>
                  <select id="subscription-method" value={form.method} onChange={(event) => change('method', event.target.value as PaymentMethod)}>
                    {PAYMENT_METHODS.map((method) => (
                      <option key={method} value={method}>
                        {methodLabel(t, method)}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="row gap">
                <button type="submit" className="primary" disabled={create.isPending}>
                  {t('sas.subscription.form.submit.action')}
                </button>
                <button type="button" onClick={() => setForm(EMPTY_FORM)}>
                  {t('sas.subscription.form.reset.action')}
                </button>
              </div>
            </form>
          </div>
        ) : (
          <p className="callout warning" role="status">
            {t('sas.subscription.form.denied')}
          </p>
        )}
      </StateBoundary>
      <p className="prototype-note">{t('sas.subscription.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
