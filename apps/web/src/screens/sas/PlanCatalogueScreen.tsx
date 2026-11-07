import { useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { useCreatePlan, usePlans, usePublishPlan } from './plan/hooks';
import { cycleLabel, expiredLabel, featureProblemMessage, fieldProblemMessage, graceLabel, limitKindLabel, limitText, planName, problemMessage, statusLabel, vatLabel } from './plan/labels';
import {
  BILLING_CYCLES,
  EMPTY_FORM,
  EXPIRED_BEHAVIORS,
  FEATURE_CODES,
  GRACE_BEHAVIORS,
  LIMIT_KINDS,
  MANAGE_PLANS_PERMISSION,
  MAX_REASON,
  VAT_CATEGORIES,
  createBody,
  describeProblem,
  emptyFeature,
  formOfRevision,
  formatPrice,
  hasProblems,
  isReasonValid,
  validateForm,
} from './plan/model';
import type { BillingCycle, ExpiredBehavior, FeatureField, FeatureForm, FormField, FormProblems, GraceBehavior, LimitKind, PlanForm, PlanRow, VatCategory } from './plan/model';
import { featureLabel, toneClass } from './tenants/labels';
import { SectionCard, StatusPill } from '../../ui';
import { KitTable } from '../adm/KitTable';
import '../adm/adm-kit.css';
import './tenants/sas.css';
import './plan/plan.css';
import { toneOfPill } from '../adm/kit-tone';

type Context = 'create' | 'publish';
interface Notice {
  kind: Context;
  code: string;
  /** Of a publication: the revision that was published. */
  revision?: number;
}
interface Publishing {
  plan: PlanRow;
  reason: string;
  tooShort: boolean;
}

/**
 * SAS-06: the plan catalogue. The billing operator drafts a plan version with its price, cycles, VAT and features (a limit kind, a limit and what
 * each feature does in the grace window and after the end) and publishes it with a reason; a Published version never changes, a change is the next
 * revision of the plan, so a subscription keeps what it was sold. The feature matrix of the chosen version is drawn beside the list.
 */
export default function PlanCatalogueScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The form, the choice of the matrix and the notices belong to one membership: a switch starts the screen over.
  return <PlanContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function PlanContent({ route }: ScreenProps) {
  const { t, locale } = useTranslation();
  const { permissions } = useSession();
  const canManage = permissions === undefined || permissions.includes(MANAGE_PLANS_PERMISSION);
  const plans = usePlans(true);
  const create = useCreatePlan();
  const publish = usePublishPlan();
  const [form, setForm] = useState<PlanForm>(EMPTY_FORM);
  const [nextKey, setNextKey] = useState(1);
  const [attempted, setAttempted] = useState(false);
  const [chosen, setChosen] = useState<string | undefined>(undefined);
  const [publishing, setPublishing] = useState<Publishing | undefined>(undefined);
  const [notice, setNotice] = useState<Notice | undefined>(undefined);
  const [context, setContext] = useState<Context>('create');

  const rows = plans.data ?? [];
  const matrixOf = rows.find((row) => row.id === chosen) ?? rows[0];
  const problems = validateForm(form);
  const shown: FormProblems = attempted ? problems : { fields: {}, features: new Map() };
  const failure = context === 'create' ? create : publish;
  const problem = failure.isError ? describeProblem(failure.error) : undefined;
  const state = useScreenState({ isLoading: plans.isLoading, error: plans.error, data: plans.isLoading ? undefined : rows });

  const change = <K extends keyof PlanForm>(field: K, value: PlanForm[K]): void => {
    setForm((current) => ({ ...current, [field]: value }));
    setNotice(undefined);
  };
  const changeFeature = (key: number, patch: Partial<FeatureForm>): void => {
    setForm((current) => ({ ...current, features: current.features.map((feature) => (feature.key === key ? { ...feature, ...patch } : feature)) }));
    setNotice(undefined);
  };
  const toggleCycle = (cycle: BillingCycle): void => change('billingCycles', form.billingCycles.includes(cycle) ? form.billingCycles.filter((candidate) => candidate !== cycle) : [...form.billingCycles, cycle]);
  const addFeature = (): void => {
    setForm((current) => ({ ...current, features: [...current.features, emptyFeature(nextKey)] }));
    setNextKey((key) => key + 1);
  };
  const removeFeature = (key: number): void => setForm((current) => ({ ...current, features: current.features.filter((feature) => feature.key !== key) }));
  const reset = (): void => {
    setForm(EMPTY_FORM);
    setAttempted(false);
    create.reset();
  };

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (create.isPending || !canManage) return;
    if (hasProblems(problems)) {
      setAttempted(true);
      return;
    }
    setContext('create');
    create.mutate(createBody(form), {
      onSuccess: (done) => {
        const body = done as { resource_id?: string };
        setNotice({ kind: 'create', code: form.planCode.trim() });
        if (body.resource_id !== undefined) setChosen(body.resource_id);
        setForm(EMPTY_FORM);
        setAttempted(false);
      },
    });
  };

  const revise = (row: PlanRow): void => {
    const revision = formOfRevision(row);
    setForm(revision);
    setNextKey(revision.features.length);
    setAttempted(false);
    setNotice(undefined);
    create.reset();
  };

  const confirmPublish = (event: FormEvent): void => {
    event.preventDefault();
    if (publishing === undefined || publish.isPending) return;
    if (!isReasonValid(publishing.reason)) {
      setPublishing({ ...publishing, tooShort: true });
      return;
    }
    setContext('publish');
    const { plan, reason } = publishing;
    publish.mutate(
      { id: plan.id, version: plan.version, reason: reason.trim() },
      {
        onSuccess: () => {
          setNotice({ kind: 'publish', code: plan.planCode, revision: plan.revision });
          setPublishing(undefined);
        },
      },
    );
  };

  const fieldError = (field: FormField): string | undefined => {
    const found = shown.fields[field];
    return found === undefined ? undefined : fieldProblemMessage(t, found);
  };
  const featureError = (feature: FeatureForm, field: FeatureField): string | undefined => {
    const found = shown.features.get(feature.key)?.[field];
    return found === undefined ? undefined : featureProblemMessage(t, found);
  };

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title" className="sas-plans">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('sas.plan.page.title')}</h1>
          <p>{t('sas.plan.page.subtitle')}</p>
        </div>
      </div>
      <div className="plan-grid">
        <SectionCard title={t('sas.plan.list.title')} unit={t('dis.wr.unit')}>
          <StateBoundary state={state} onRetry={() => void plans.refetch()}>
              <KitTable caption={t('w2sas.plan.table.list')} aria-label={t('sas.plan.list.title')}>
                <thead>
                  <tr>
                    <th>{t('sas.plan.col.plan')}</th>
                    <th>{t('sas.plan.col.price')}</th>
                    <th>{t('sas.plan.col.cycles')}</th>
                    <th>{t('sas.plan.col.vat')}</th>
                    <th>{t('sas.plan.col.status')}</th>
                    <th>{t('sas.plan.col.actions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.id} data-plan-id={row.id} data-status={row.status}>
                      <td>
                        <b>{planName(t, row.name)}</b>
                        <div className="sub">{t('sas.plan.row.code', { code: row.planCode, revision: row.revision })}</div>
                      </td>
                      <td>{t('sas.plan.row.price', { amount: formatPrice(row.basePriceVnd, locale) })}</td>
                      <td>{row.billingCycles.map((cycle) => cycleLabel(t, cycle)).join(', ')}</td>
                      <td>{vatLabel(t, row.vatCategory)}</td>
                      <td>
                        <StatusPill tone={toneOfPill(toneClass(row.status === 'Published' ? 'ok' : row.status === 'Draft' ? 'warn' : 'gray'))}>{statusLabel(t, row.status)}</StatusPill>
                      </td>
                      <td className="plan-actions">
                        <button type="button" aria-pressed={matrixOf?.id === row.id} onClick={() => setChosen(row.id)}>
                          {t('sas.plan.row.features.action')}
                        </button>
                        {canManage ? (
                          <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => revise(row)}>
                            {t('sas.plan.row.revise.action')}
                          </button>
                        ) : null}
                        {canManage && row.status === 'Draft' ? (
                          <button type="button" className="ui-button ui-button--primary" disabled={publish.isPending} onClick={() => setPublishing({ plan: row, reason: '', tooShort: false })}>
                            {t('sas.plan.row.publish.action')}
                          </button>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </KitTable>
          </StateBoundary>
          {notice === undefined ? null : (
            <p className="callout" role="status">
              {notice.kind === 'create' ? t('sas.plan.done.created', { code: notice.code }) : t('sas.plan.done.published', { code: notice.code, revision: notice.revision ?? 0 })}
            </p>
          )}
          {problem === undefined ? null : (
            <div className="callout warning" role="alert">
              <p>{problemMessage(t, problem)}</p>
            </div>
          )}
          {publishing === undefined ? null : (
            <form onSubmit={confirmPublish} noValidate aria-label={t('sas.plan.publish.aria')} className="plan-publish" data-publishing={publishing.plan.id}>
              <h3>{t('sas.plan.publish.title', { code: publishing.plan.planCode, revision: publishing.plan.revision })}</h3>
              <p className="callout">{t('sas.plan.publish.rule')}</p>
              <div className="field">
                <label htmlFor="plan-publish-reason">{t('sas.plan.publish.reason.label')}</label>
                <textarea
                  id="plan-publish-reason"
                  rows={2}
                  maxLength={MAX_REASON}
                  value={publishing.reason}
                  aria-invalid={publishing.tooShort}
                  onChange={(event) => setPublishing({ ...publishing, reason: event.target.value, tooShort: false })}
                />
                {publishing.tooShort ? (
                  <small role="alert" className="field-error">
                    {t('sas.plan.publish.reason.tooShort')}
                  </small>
                ) : null}
              </div>
              <div className="row gap">
                <button type="submit" className="ui-button ui-button--primary" disabled={publish.isPending}>
                  {t('sas.plan.publish.confirm.action')}
                </button>
                <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => setPublishing(undefined)}>
                  {t('sas.plan.publish.cancel.action')}
                </button>
              </div>
            </form>
          )}

          {canManage ? (
            <form onSubmit={submit} noValidate aria-label={t('sas.plan.form.aria')} className="plan-form">
              <h3>{t('sas.plan.form.title')}</h3>
              <p className="sub">{t('sas.plan.form.hint')}</p>
              <div className="formgrid">
                <div className="field">
                  <label htmlFor="plan-code">{t('sas.plan.form.code.label')}</label>
                  <input id="plan-code" value={form.planCode} aria-invalid={shown.fields.planCode !== undefined} onChange={(event) => change('planCode', event.target.value)} />
                  <small className="sub">{t('sas.plan.form.code.hint')}</small>
                  {fieldError('planCode') === undefined ? null : (
                    <small role="alert" className="field-error">
                      {fieldError('planCode')}
                    </small>
                  )}
                </div>
                <div className="field">
                  <label htmlFor="plan-name">{t('sas.plan.form.name.label')}</label>
                  <input id="plan-name" value={form.name} aria-invalid={shown.fields.name !== undefined} onChange={(event) => change('name', event.target.value)} />
                  {fieldError('name') === undefined ? null : (
                    <small role="alert" className="field-error">
                      {fieldError('name')}
                    </small>
                  )}
                </div>
                <div className="field">
                  <label htmlFor="plan-price">{t('sas.plan.form.price.label')}</label>
                  <input id="plan-price" inputMode="numeric" value={form.basePriceVnd} aria-invalid={shown.fields.basePriceVnd !== undefined} onChange={(event) => change('basePriceVnd', event.target.value)} />
                  {fieldError('basePriceVnd') === undefined ? null : (
                    <small role="alert" className="field-error">
                      {fieldError('basePriceVnd')}
                    </small>
                  )}
                </div>
                <div className="field">
                  <label htmlFor="plan-vat">{t('sas.plan.form.vat.label')}</label>
                  <select id="plan-vat" value={form.vatCategory} onChange={(event) => change('vatCategory', event.target.value as VatCategory)}>
                    {VAT_CATEGORIES.map((vat) => (
                      <option key={vat} value={vat}>
                        {vatLabel(t, vat)}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="plan-terms">{t('sas.plan.form.terms.label')}</label>
                  <input id="plan-terms" value={form.legalTermsRef} aria-invalid={shown.fields.legalTermsRef !== undefined} onChange={(event) => change('legalTermsRef', event.target.value)} />
                  {fieldError('legalTermsRef') === undefined ? null : (
                    <small role="alert" className="field-error">
                      {fieldError('legalTermsRef')}
                    </small>
                  )}
                </div>
              </div>
              <fieldset className="plan-cycles">
                <legend>{t('sas.plan.form.cycles.label')}</legend>
                {BILLING_CYCLES.map((cycle) => (
                  <label key={cycle} className="check">
                    <input type="checkbox" checked={form.billingCycles.includes(cycle)} onChange={() => toggleCycle(cycle)} />
                    {cycleLabel(t, cycle)}
                  </label>
                ))}
                {fieldError('billingCycles') === undefined ? null : (
                  <small role="alert" className="field-error">
                    {fieldError('billingCycles')}
                  </small>
                )}
              </fieldset>

              <h4>{t('sas.plan.form.features.title')}</h4>
              {fieldError('features') === undefined ? null : (
                <small role="alert" className="field-error">
                  {fieldError('features')}
                </small>
              )}
                <KitTable caption={t('w2sas.plan.table.features')} aria-label={t('sas.plan.form.features.title')} className="plan-feature-editor">
                  <thead>
                    <tr>
                      <th>{t('sas.plan.matrix.col.feature')}</th>
                      <th>{t('sas.plan.matrix.col.kind')}</th>
                      <th>{t('sas.plan.matrix.col.limit')}</th>
                      <th>{t('sas.plan.matrix.col.meter')}</th>
                      <th>{t('sas.plan.matrix.col.grace')}</th>
                      <th>{t('sas.plan.matrix.col.expired')}</th>
                      <th>{t('sas.plan.col.actions')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {form.features.map((feature, index) => (
                      <tr key={feature.key} data-feature-row={index + 1}>
                        <td>
                          <select aria-label={t('sas.plan.edit.code.aria', { row: index + 1 })} value={feature.featureCode} aria-invalid={featureError(feature, 'featureCode') !== undefined} onChange={(event) => changeFeature(feature.key, { featureCode: event.target.value })}>
                            {FEATURE_CODES.map((code) => (
                              <option key={code} value={code}>
                                {featureLabel(t, code)}
                              </option>
                            ))}
                          </select>
                          {featureError(feature, 'featureCode') === undefined ? null : (
                            <small role="alert" className="field-error">
                              {featureError(feature, 'featureCode')}
                            </small>
                          )}
                        </td>
                        <td>
                          <select aria-label={t('sas.plan.edit.kind.aria', { row: index + 1 })} value={feature.limitKind} onChange={(event) => changeFeature(feature.key, { limitKind: event.target.value as LimitKind })}>
                            {LIMIT_KINDS.map((kind) => (
                              <option key={kind} value={kind}>
                                {limitKindLabel(t, kind)}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td>
                          <input aria-label={t('sas.plan.edit.limit.aria', { row: index + 1 })} inputMode="decimal" value={feature.limitValue} aria-invalid={featureError(feature, 'limitValue') !== undefined} onChange={(event) => changeFeature(feature.key, { limitValue: event.target.value })} />
                          {featureError(feature, 'limitValue') === undefined ? null : (
                            <small role="alert" className="field-error">
                              {featureError(feature, 'limitValue')}
                            </small>
                          )}
                        </td>
                        <td>
                          <input aria-label={t('sas.plan.edit.meter.aria', { row: index + 1 })} value={feature.meter} disabled={feature.limitKind !== 'METERED'} aria-invalid={featureError(feature, 'meter') !== undefined} onChange={(event) => changeFeature(feature.key, { meter: event.target.value })} />
                          {featureError(feature, 'meter') === undefined ? null : (
                            <small role="alert" className="field-error">
                              {featureError(feature, 'meter')}
                            </small>
                          )}
                        </td>
                        <td>
                          <select aria-label={t('sas.plan.edit.grace.aria', { row: index + 1 })} value={feature.graceBehavior} onChange={(event) => changeFeature(feature.key, { graceBehavior: event.target.value as GraceBehavior })}>
                            {GRACE_BEHAVIORS.map((behavior) => (
                              <option key={behavior} value={behavior}>
                                {graceLabel(t, behavior)}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td>
                          <select aria-label={t('sas.plan.edit.expired.aria', { row: index + 1 })} value={feature.expiredBehavior} aria-invalid={featureError(feature, 'expiredBehavior') !== undefined} onChange={(event) => changeFeature(feature.key, { expiredBehavior: event.target.value as ExpiredBehavior })}>
                            {EXPIRED_BEHAVIORS.map((behavior) => (
                              <option key={behavior} value={behavior}>
                                {expiredLabel(t, behavior)}
                              </option>
                            ))}
                          </select>
                          {featureError(feature, 'expiredBehavior') === undefined ? null : (
                            <small role="alert" className="field-error">
                              {featureError(feature, 'expiredBehavior')}
                            </small>
                          )}
                        </td>
                        <td>
                          <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => removeFeature(feature.key)}>
                            {t('sas.plan.edit.remove.action', { row: index + 1 })}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </KitTable>
              <div className="row gap">
                <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={addFeature}>
                  {t('sas.plan.edit.add.action')}
                </button>
                <button type="submit" className="ui-button ui-button--primary" disabled={create.isPending}>
                  {t('sas.plan.form.submit.action')}
                </button>
                <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={reset}>
                  {t('sas.plan.form.reset.action')}
                </button>
              </div>
            </form>
          ) : (
            <p className="callout warning" role="status">
              {t('sas.plan.form.denied')}
            </p>
          )}
        </SectionCard>

        <SectionCard title={t('sas.plan.matrix.title')}>
          {matrixOf === undefined ? (
            <p className="sub">{t('sas.plan.matrix.none')}</p>
          ) : (
            <div data-testid="matrix" data-plan-id={matrixOf.id}>
              <p className="sub">{t('sas.plan.matrix.of', { name: planName(t, matrixOf.name), code: matrixOf.planCode, revision: matrixOf.revision })}</p>
                <KitTable caption={t('w2sas.plan.table.matrix')} aria-label={t('sas.plan.matrix.title')}>
                  <thead>
                    <tr>
                      <th>{t('sas.plan.matrix.col.feature')}</th>
                      <th>{t('sas.plan.matrix.col.kind')}</th>
                      <th>{t('sas.plan.matrix.col.limit')}</th>
                      <th>{t('sas.plan.matrix.col.grace')}</th>
                      <th>{t('sas.plan.matrix.col.expired')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {matrixOf.features.map((feature) => (
                      <tr key={feature.featureCode} data-feature={feature.featureCode}>
                        <td>
                          <b>{featureLabel(t, feature.featureCode)}</b>
                          <div className="sub">{feature.featureCode}</div>
                        </td>
                        <td>{limitKindLabel(t, feature.limitKind)}</td>
                        <td>{limitText(t, feature)}</td>
                        <td>{graceLabel(t, feature.graceBehavior)}</td>
                        <td>{expiredLabel(t, feature.expiredBehavior)}</td>
                      </tr>
                    ))}
                  </tbody>
                </KitTable>
            </div>
          )}
        </SectionCard>
      </div>
      <p className="prototype-note">{t('sas.plan.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
