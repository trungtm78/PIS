import { useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { Field } from '../mne/components';
import '../dis/dis.css';
import { useActivateProvider, useProviders, useRegisterProvider } from './hooks';
import { classificationLabel, problemMessage, providerStatusLabel, refusalMessage, routeLabel } from './labels';
import { CLASSIFICATIONS, EMPTY_PROVIDER, PROVIDER_APPROVE, PROVIDER_MANAGE, ROUTES, describeLlmProblem, validateProvider } from './llm-model';
import type { Classification, Provider, ProviderErrors, ProviderValues, Route } from './llm-model';
import { providerStatusTone } from './tones';
import { ContextBar, StatusPill } from '../../ui';
import './llm-kit.css';

/**
 * LLM-02: the providers of the AI models (ST-LLM-001, LLM F2): where each one is, which route it is (a domestic service, one the tenant hosts, or an international one), the most sensitive class of data it may be sent,
 * its data agreement and the approval of D07, and its status. A provider is registered by one person and activated by another; an international provider takes public data only and becomes active only with D07.
 */
export default function ProvidersScreen({ route }: ScreenProps) {
  const tenant = useSession().tenant;
  // What is open belongs to one member of one tenant: a switch starts the screen over.
  return <ProvidersContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function ProvidersContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions, mode, tenant } = useSession();
  const can = (permission: string): boolean => (permissions === undefined || permissions.includes(permission)) && mode !== 'READ_ONLY';
  const providers = useProviders();
  const state = useScreenState({ isLoading: providers.isLoading, error: providers.error, data: providers.data === undefined ? undefined : { rows: providers.data } });
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('llm.providers.page.title')}</h1>
          <p>{t('llm.providers.page.subtitle')}</p>
        </div>
      </div>
      <ContextBar
        items={[
          { label: t('llm.providers.ctx.scope'), value: tenant?.name ?? t('llm.providers.ctx.scope.all') },
          { label: t('llm.providers.ctx.count'), value: String((providers.data ?? []).length) },
        ]}
        {...(providers.dataUpdatedAt > 0 ? { asOf: new Date(providers.dataUpdatedAt).toLocaleString('vi-VN') } : {})}
      />
      <StateBoundary state={state} onRetry={() => void providers.refetch()}>
        <p className="callout" data-testid="providers-international-note">
          {t('llm.providers.internationalNote')}
        </p>
        <div data-testid="provider-cards">
          {(providers.data ?? []).map((provider) => (
            <ProviderCard key={provider.id} provider={provider} mayApprove={can(PROVIDER_APPROVE)} />
          ))}
        </div>
        {(providers.data ?? []).length === 0 ? <p data-testid="providers-none">{t('llm.providers.none')}</p> : null}
        {can(PROVIDER_MANAGE) ? <ProviderForm /> : null}
      </StateBoundary>
    </section>
  );
}

function ProviderCard({ provider, mayApprove }: { provider: Provider; mayApprove: boolean }) {
  const { t } = useTranslation();
  const activate = useActivateProvider();
  const [d07, setD07] = useState('');
  const refused = activate.isError ? describeLlmProblem(activate.error) : undefined;
  const international = provider.route === 'INTERNATIONAL';
  const send = (event: FormEvent): void => {
    event.preventDefault();
    if (activate.isPending) return;
    activate.mutate({ providerId: provider.id, version: provider.version, d07Ref: d07 });
  };
  return (
    <article className="card" data-provider-id={provider.id} data-status={provider.status} data-route={provider.route} aria-label={provider.name}>
      <h2>{provider.name}</h2>
      <p className="sub">
        {provider.code} · {provider.region}
      </p>
      <dl>
        <dt>{t('llm.providers.card.route')}</dt>
        <dd>{routeLabel(t, provider.route)}</dd>
        <dt>{t('llm.providers.card.max')}</dt>
        <dd>{classificationLabel(t, provider.maxClassification)}</dd>
        <dt>{t('llm.providers.card.agreement')}</dt>
        <dd>{provider.hasAgreement ? t('llm.providers.card.agreementYes') : t('llm.providers.card.agreementNo')}</dd>
        <dt>{t('llm.providers.card.d07')}</dt>
        <dd>{provider.d07Ref ?? t('llm.providers.card.d07None')}</dd>
        <dt>{t('llm.providers.card.status')}</dt>
        <dd data-testid="provider-status">
          <StatusPill tone={providerStatusTone(provider.status)}>{providerStatusLabel(t, provider.status)}</StatusPill>
        </dd>
      </dl>
      {mayApprove && provider.status === 'PROPOSED' ? (
        <form onSubmit={send} noValidate aria-label={t('llm.providers.activate.title', { name: provider.name })}>
          {international ? (
            <Field id={`d07-${provider.id}`} label={t('llm.providers.activate.d07')} error={undefined}>
              <input id={`d07-${provider.id}`} value={d07} onChange={(event) => setD07(event.target.value)} maxLength={80} />
            </Field>
          ) : null}
          {refused === undefined ? null : (
            <p className="callout warning" role="alert" data-testid="activate-refused">
              {refusalMessage(t, refused.reason, refused.detail)}
            </p>
          )}
          <div className="mne-actions">
            <button type="submit" className="ui-button ui-button--primary" disabled={activate.isPending}>
              {t('llm.providers.activate.submit')}
            </button>
          </div>
        </form>
      ) : null}
    </article>
  );
}

function ProviderForm() {
  const { t } = useTranslation();
  const register = useRegisterProvider();
  const [values, setValues] = useState<ProviderValues>(EMPTY_PROVIDER);
  const [errors, setErrors] = useState<ProviderErrors>({});
  const refused = register.isError ? describeLlmProblem(register.error) : undefined;
  const set = <K extends keyof ProviderValues>(field: K, value: ProviderValues[K]): void => {
    setValues((previous) => ({ ...previous, [field]: value }));
    setErrors({});
  };
  const message = (field: keyof ProviderErrors): string | undefined => (errors[field] === undefined ? undefined : problemMessage(t, errors[field]));
  const send = (event: FormEvent): void => {
    event.preventDefault();
    if (register.isPending) return;
    const found = validateProvider(values);
    setErrors(found);
    if (Object.keys(found).length === 0) register.mutate(values);
  };
  return (
    <form className="card" onSubmit={send} noValidate aria-label={t('llm.providers.form.title')}>
      <h2>{t('llm.providers.form.title')}</h2>
      <p className="sub">{t('llm.providers.form.hint')}</p>
      {refused === undefined ? null : (
        <p className="callout warning" role="alert" data-testid="provider-refused">
          {refusalMessage(t, refused.reason, refused.detail)}
        </p>
      )}
      {register.isSuccess ? (
        <p className="callout" role="status" data-testid="provider-saved">
          {t('llm.providers.form.saved')}
        </p>
      ) : null}
      <div className="mne-filters">
        <Field id="provider-code" label={t('llm.providers.form.code')} error={message('code')}>
          <input id="provider-code" value={values.code} onChange={(event) => set('code', event.target.value)} maxLength={40} />
        </Field>
        <Field id="provider-name" label={t('llm.providers.form.name')} error={message('name')}>
          <input id="provider-name" value={values.name} onChange={(event) => set('name', event.target.value)} maxLength={200} />
        </Field>
        <Field id="provider-region" label={t('llm.providers.form.region')} error={message('region')}>
          <input id="provider-region" value={values.region} onChange={(event) => set('region', event.target.value)} maxLength={2} />
        </Field>
        <Field id="provider-route" label={t('llm.providers.form.route')} error={undefined}>
          <select id="provider-route" value={values.route} onChange={(event) => set('route', event.target.value as Route)}>
            {ROUTES.map((route) => (
              <option key={route} value={route}>
                {routeLabel(t, route)}
              </option>
            ))}
          </select>
        </Field>
        <Field id="provider-max" label={t('llm.providers.form.max')} error={message('maxClassification')}>
          <select id="provider-max" value={values.maxClassification} onChange={(event) => set('maxClassification', event.target.value as Classification)}>
            {CLASSIFICATIONS.map((level) => (
              <option key={level} value={level}>
                {classificationLabel(t, level)}
              </option>
            ))}
          </select>
        </Field>
        <Field id="provider-agreement" label={t('llm.providers.form.agreement')} error={message('agreementDocumentId')}>
          <input id="provider-agreement" value={values.agreementDocumentId} onChange={(event) => set('agreementDocumentId', event.target.value)} />
        </Field>
      </div>
      <div className="mne-actions">
        <button type="submit" className="ui-button ui-button--primary" disabled={register.isPending}>
          {t('llm.providers.form.submit')}
        </button>
      </div>
    </form>
  );
}
