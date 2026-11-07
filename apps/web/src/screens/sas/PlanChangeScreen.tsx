import { useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import { routeById } from '../../routes/registry';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { usePlans } from './plan/hooks';
import { planName } from './plan/labels';
import { featureLabel, toneClass } from './tenants/labels';
import { TenantPicker } from './subscription/TenantPicker';
import { useChangePlan, usePreviewPlanChange, useTenantChoice, useTenantSubscription } from './subscription/hooks';
import { effectiveLabel, problemMessage, statusLabel, statusTone } from './subscription/labels';
import { MANAGE_SUBSCRIPTION_PERMISSION, MAX_REASON, describeProblem, formatVnd, isReasonValid, mayChangeNow } from './subscription/model';
import type { Effective, PreviewResult } from './subscription/model';
import { SectionCard, StatusPill } from '../../ui';
import { KitTable } from '../adm/KitTable';
import '../adm/adm-kit.css';
import './tenants/sas.css';
import './subscription/subscription.css';
import { toneOfPill } from '../adm/kit-tone';

type Context = 'preview' | 'change';

/**
 * SAS-08: the change of plan of a tenant. The billing operator picks the plan the subscription moves to and when (now, for a plan that costs more; at the next cycle for any
 * other), asks for the preview (the proration in whole VND, the quotas of the new plan that the tenant is already over, the day it takes effect and a token) and applies the
 * change against that preview with a reason. A preview that no longer matches (the entitlements or the day changed) is refused and must be made again; a downgrade takes
 * nothing away and gives no money back, it only keeps the next addition out.
 */
export default function PlanChangeScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The choice, the preview and the notices belong to one membership: a switch starts the screen over.
  return <PlanChangeContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function PlanChangeContent({ route }: ScreenProps) {
  const { t, locale } = useTranslation();
  const { permissions } = useSession();
  const canManage = permissions === undefined || permissions.includes(MANAGE_SUBSCRIPTION_PERMISSION);
  const choice = useTenantChoice();
  const subscription = useTenantSubscription(choice.chosen);
  const plans = usePlans(canManage);
  const previewing = usePreviewPlanChange();
  const changing = useChangePlan();
  const [target, setTarget] = useState('');
  const [wanted, setWanted] = useState<Effective>('NOW');
  const [preview, setPreview] = useState<PreviewResult | undefined>(undefined);
  const [reason, setReason] = useState('');
  const [tooShort, setTooShort] = useState(false);
  const [notice, setNotice] = useState(false);
  const [context, setContext] = useState<Context>('preview');

  const data = subscription.data;
  const live = data?.subscription;
  const current = data?.plan;
  const published = (plans.data ?? []).filter((plan) => plan.status === 'Published' && plan.id !== live?.planVersionId);
  const names = useMemo(() => new Map((plans.data ?? []).map((plan) => [plan.id, t('sas.planChange.plan.text', { name: planName(t, plan.name), code: plan.planCode, revision: plan.revision })])), [plans.data, t]);
  const targetPlan = published.find((plan) => plan.id === target);
  const allowNow = current !== undefined && targetPlan !== undefined && mayChangeNow(current.basePriceVnd, targetPlan.basePriceVnd);
  const effective: Effective = allowNow ? wanted : 'NEXT_CYCLE';
  const waiting = choice.chosen === undefined && choice.isLoading;
  const state = useScreenState({
    isLoading: subscription.isLoading || waiting,
    error: choice.chosen === undefined ? choice.error : subscription.error,
    data: choice.chosen === undefined ? undefined : subscription.data,
    isEmpty: () => false,
  });
  const failure = context === 'preview' ? previewing : changing;
  const problem = failure.isError ? describeProblem(failure.error) : undefined;
  const subscriptionRoute = routeById('SAS-07');
  const billing = routeById('SAS-09');
  const date = (value: string): string => new Date(value).toLocaleDateString(locale, { timeZone: 'UTC' });
  const dateTime = (value: string): string => new Date(value).toLocaleString(locale, { timeZone: 'UTC' });
  const nameOf = (id: string): string => names.get(id) ?? id;

  const pick = (planVersionId: string): void => {
    setTarget(planVersionId);
    setPreview(undefined);
    setNotice(false);
    previewing.reset();
    changing.reset();
  };
  const wantEffective = (value: Effective): void => {
    setWanted(value);
    setPreview(undefined);
    setNotice(false);
  };

  const ask = (): void => {
    if (previewing.isPending || live === undefined || targetPlan === undefined) return;
    setContext('preview');
    setNotice(false);
    previewing.mutate({ subscriptionId: live.id, targetPlanVersionId: targetPlan.id, effective }, { onSuccess: setPreview });
  };

  const apply = (event: FormEvent): void => {
    event.preventDefault();
    if (changing.isPending || live === undefined || targetPlan === undefined || preview === undefined) return;
    if (!isReasonValid(reason)) {
      setTooShort(true);
      return;
    }
    setContext('change');
    changing.mutate(
      { subscriptionId: live.id, targetPlanVersionId: targetPlan.id, effective, previewHash: preview.previewHash, reason: reason.trim(), version: live.version },
      {
        onSuccess: () => {
          setNotice(true);
          setPreview(undefined);
          setReason('');
          setTarget('');
        },
        // A preview the server refused (stale, a conflict) is not good for another try: the person asks again.
        onError: () => setPreview(undefined),
      },
    );
  };

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title" className="sas-subscription sas-plan-change">
      {billing === undefined ? null : (
        <p className="sas-back-link">
          <Link to={billing.path}>
            <span aria-hidden="true">← </span>
            {t('sas.planChange.back.link')}
          </Link>
        </p>
      )}
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('sas.planChange.page.title')}</h1>
          <p>{t('sas.planChange.page.subtitle')}</p>
        </div>
      </div>
      <TenantPicker id="plan-change-tenant" label={t('sas.subscription.tenant.label')} moreLabel={t('sas.subscription.tenant.more.action')} choice={choice} />
      <StateBoundary state={state} onRetry={() => void (choice.chosen === undefined ? choice.refetch() : subscription.refetch())}>
        {live === undefined || data === undefined ? (
          <div className="card">
            <p className="callout" role="status">
              {t('sas.planChange.none.notice')}{' '}
              {subscriptionRoute === undefined || choice.chosen === undefined ? null : <Link to={`${subscriptionRoute.path}?tenant=${encodeURIComponent(choice.chosen)}`}>{t('sas.planChange.none.link')}</Link>}
            </p>
          </div>
        ) : (
          <>
            <SectionCard title={t('sas.planChange.current.title')}>
              <div data-subscription-id={live.id} data-version={live.version}>
              <dl className="sas-detail-fields">
                <div className="sas-detail-row">
                  <dt>{t('sas.planChange.field.current')}</dt>
                  <dd>
                    {current === undefined ? live.planVersionId : t('sas.planChange.plan.text', { name: planName(t, current.name), code: current.planCode, revision: current.revision })}
                    {current === undefined ? null : <small className="sub"> {t('sas.subscription.price.text', { amount: formatVnd(current.basePriceVnd, locale) })}</small>}
                  </dd>
                </div>
                <div className="sas-detail-row">
                  <dt>{t('sas.subscription.field.status')}</dt>
                  <dd>
                    <StatusPill tone={toneOfPill(toneClass(statusTone(live.status)))}>{statusLabel(t, live.status)}</StatusPill>
                  </dd>
                </div>
                <div className="sas-detail-row">
                  <dt>{t('sas.subscription.field.period')}</dt>
                  <dd>{t('sas.subscription.period.text', { from: date(`${live.currentPeriodStart}T00:00:00Z`), until: date(`${live.currentPeriodEnd}T00:00:00Z`) })}</dd>
                </div>
                {data.pendingPlan === undefined || live.pendingEffectiveAt === undefined ? null : (
                  <div className="sas-detail-row" data-pending-plan={data.pendingPlan.id}>
                    <dt>{t('sas.subscription.field.pending')}</dt>
                    <dd>{t('sas.subscription.pending.text', { name: planName(t, data.pendingPlan.name), code: data.pendingPlan.planCode, revision: data.pendingPlan.revision, day: date(live.pendingEffectiveAt) })}</dd>
                  </div>
                )}
              </dl>
              </div>
            </SectionCard>

            {canManage ? (
              <SectionCard title={t('sas.planChange.form.title')}>
                <div className="formgrid">
                  <div className="field">
                    <label htmlFor="plan-change-target">{t('sas.planChange.field.target')}</label>
                    <select id="plan-change-target" value={target} onChange={(event) => pick(event.target.value)}>
                      <option value="">{t('sas.planChange.target.choose')}</option>
                      {published.map((plan) => (
                        <option key={plan.id} value={plan.id}>
                          {t('sas.planChange.target.option', { name: planName(t, plan.name), code: plan.planCode, revision: plan.revision, amount: formatVnd(plan.basePriceVnd, locale) })}
                        </option>
                      ))}
                    </select>
                  </div>
                  <fieldset className="field plan-change-effective">
                    <legend>{t('sas.planChange.field.effective')}</legend>
                    <label className="check">
                      <input type="radio" name="plan-change-effective" value="NOW" checked={effective === 'NOW'} disabled={!allowNow} onChange={() => wantEffective('NOW')} />
                      {effectiveLabel(t, 'NOW')}
                    </label>
                    <label className="check">
                      <input type="radio" name="plan-change-effective" value="NEXT_CYCLE" checked={effective === 'NEXT_CYCLE'} onChange={() => wantEffective('NEXT_CYCLE')} />
                      {effectiveLabel(t, 'NEXT_CYCLE')}
                    </label>
                    {targetPlan !== undefined && !allowNow ? <small className="sub">{t('sas.planChange.effective.onlyNext')}</small> : null}
                  </fieldset>
                </div>
                <div className="row gap">
                  <button type="button" className="ui-button ui-button--primary" disabled={targetPlan === undefined || previewing.isPending} onClick={ask}>
                    {t('sas.planChange.preview.action')}
                  </button>
                </div>
              </SectionCard>
            ) : (
              <p className="callout warning" role="status">
                {t('sas.planChange.form.denied')}
              </p>
            )}

            {preview === undefined || targetPlan === undefined || current === undefined ? null : (
              <SectionCard title={t('sas.planChange.preview.title')}>
                <div data-testid="preview" data-preview-hash={preview.previewHash}>
                <dl className="sas-detail-fields">
                  <div className="sas-detail-row">
                    <dt>{t('sas.planChange.field.current')}</dt>
                    <dd>{nameOf(current.id)}</dd>
                  </div>
                  <div className="sas-detail-row">
                    <dt>{t('sas.planChange.field.new')}</dt>
                    <dd>{nameOf(targetPlan.id)}</dd>
                  </div>
                  <div className="sas-detail-row">
                    <dt>{t('sas.planChange.field.effective')}</dt>
                    <dd>{t('sas.planChange.effective.text', { when: effectiveLabel(t, effective), day: dateTime(preview.effectiveAt) })}</dd>
                  </div>
                  <div className="sas-detail-row">
                    <dt>{t('sas.planChange.field.proration')}</dt>
                    <dd data-proration={preview.prorationVnd}>{t('sas.subscription.price.text', { amount: formatVnd(preview.prorationVnd, locale) })}</dd>
                  </div>
                  <div className="sas-detail-row">
                    <dt>{t('sas.planChange.field.hash')}</dt>
                    <dd>
                      <code>{preview.previewHash}</code>
                    </dd>
                  </div>
                </dl>
                <h3>{t('sas.planChange.violations.title')}</h3>
                {preview.violations.length === 0 ? (
                  <p className="sub">{t('sas.planChange.violations.none')}</p>
                ) : (
                  <>
                    <p className="callout warning">{t('sas.planChange.violations.rule')}</p>
                      <KitTable caption={t('w2sas.planChange.table.violations')} aria-label={t('sas.planChange.violations.title')}>
                        <thead>
                          <tr>
                            <th>{t('sas.planChange.violations.col.feature')}</th>
                            <th>{t('sas.planChange.violations.col.used')}</th>
                            <th>{t('sas.planChange.violations.col.limit')}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {preview.violations.map((violation) => (
                            <tr key={violation.featureCode} data-feature={violation.featureCode}>
                              <td>
                                <b>{featureLabel(t, violation.featureCode)}</b>
                                <div className="sub">{violation.featureCode}</div>
                              </td>
                              <td>{violation.used}</td>
                              <td>{violation.newLimit}</td>
                            </tr>
                          ))}
                        </tbody>
                      </KitTable>
                  </>
                )}
                {canManage ? (
                  <form onSubmit={apply} noValidate aria-label={t('sas.planChange.apply.aria')} className="plan-change-apply">
                    <div className="field">
                      <label htmlFor="plan-change-reason">{t('sas.planChange.reason.label')}</label>
                      <textarea
                        id="plan-change-reason"
                        rows={2}
                        maxLength={MAX_REASON}
                        value={reason}
                        aria-invalid={tooShort}
                        onChange={(event) => {
                          setReason(event.target.value);
                          setTooShort(false);
                        }}
                      />
                      {tooShort ? (
                        <small role="alert" className="field-error">
                          {t('sas.planChange.reason.tooShort')}
                        </small>
                      ) : null}
                    </div>
                    <button type="submit" className="ui-button ui-button--primary" disabled={changing.isPending}>
                      {t('sas.planChange.apply.action')}
                    </button>
                  </form>
                ) : null}
                </div>
              </SectionCard>
            )}

            {notice ? (
              <p className="callout" role="status">
                {t('sas.planChange.done.notice')}
              </p>
            ) : null}
            {problem === undefined ? null : (
              <div className="callout warning" role="alert">
                <p>{problemMessage(t, problem)}</p>
              </div>
            )}

            <SectionCard title={t('sas.planChange.history.title')}>
              {data.changes.length === 0 ? (
                <p className="sub" role="status">
                  {t('sas.planChange.history.empty')}
                </p>
              ) : (
                  <KitTable caption={t('w2sas.planChange.table.history')} aria-label={t('sas.planChange.history.title')}>
                    <thead>
                      <tr>
                        <th>{t('sas.planChange.history.col.requested')}</th>
                        <th>{t('sas.planChange.history.col.change')}</th>
                        <th>{t('sas.planChange.history.col.effective')}</th>
                        <th>{t('sas.planChange.history.col.proration')}</th>
                        <th>{t('sas.planChange.history.col.state')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.changes.map((change) => (
                        <tr key={change.id} data-change-id={change.id}>
                          <td>{dateTime(change.requestedAt)}</td>
                          <td>
                            {nameOf(change.fromPlanVersionId)} → {nameOf(change.toPlanVersionId)}
                            <div className="sub">{change.reason}</div>
                          </td>
                          <td>
                            {effectiveLabel(t, change.effective)}, {date(change.effectiveAt)}
                          </td>
                          <td>{t('sas.subscription.price.text', { amount: formatVnd(change.prorationVnd, locale) })}</td>
                          <td>{change.appliedAt !== undefined ? t('sas.planChange.history.applied') : change.supersededAt !== undefined ? t('sas.planChange.history.superseded') : t('sas.planChange.history.waiting')}</td>
                        </tr>
                      ))}
                    </tbody>
                  </KitTable>
              )}
            </SectionCard>
          </>
        )}
      </StateBoundary>
      <p className="prototype-note">{t('sas.planChange.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
