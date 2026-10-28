import { useState } from 'react';
import type { FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { Field } from '../mne/components';
import '../dis/dis.css';
import { useApproveModel, useModels, useProviders, useRegisterModel } from './hooks';
import { capabilityLabel, classificationLabel, modelStatusLabel, problemMessage, refusalMessage } from './labels';
import { CAPABILITIES, CLASSIFICATIONS, EMPTY_MODEL, PROVIDER_APPROVE, PROVIDER_MANAGE, describeLlmProblem, validateModel } from './llm-model';
import type { Capability, Classification, ModelEntry, ModelErrors, ModelValues, Provider } from './llm-model';

/**
 * LLM-03: the catalogue of the models (ST-LLM-001, LLM F2): for each model the provider that serves it, the window it reads and the output it gives, the most sensitive class of data it may be sent (never above its
 * provider's) and its status. A model is used only when it is APPROVED, with an evaluation that passed on its own route (ST-LLM-004): a model that was just registered is PROPOSED and the screen says it cannot be used yet.
 */
export default function ModelsScreen({ route }: ScreenProps) {
  const tenant = useSession().tenant;
  // What is open belongs to one member of one tenant: a switch starts the screen over.
  return <ModelsContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function ModelsContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions, mode } = useSession();
  const may = (permissions === undefined || permissions.includes(PROVIDER_MANAGE)) && mode !== 'READ_ONLY';
  const mayApprove = (permissions === undefined || permissions.includes(PROVIDER_APPROVE)) && mode !== 'READ_ONLY';
  const [params, setParams] = useSearchParams();
  const providers = useProviders();
  const models = useModels();
  const asked = params.get('provider') ?? '';
  const providerOf = (id: string): Provider | undefined => (providers.data ?? []).find((provider) => provider.id === id);
  const shown = (models.data ?? []).filter((model) => asked === '' || model.providerId === asked);
  const state = useScreenState({
    isLoading: providers.isLoading || models.isLoading,
    error: providers.error ?? models.error,
    data: models.data === undefined || providers.data === undefined ? undefined : { rows: models.data },
  });
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('llm.models.page.title')}</h1>
          <p>{t('llm.models.page.subtitle')}</p>
        </div>
      </div>
      <StateBoundary
        state={state}
        onRetry={() => {
          void providers.refetch();
          void models.refetch();
        }}
      >
        <div className="card">
          <Field id="models-provider" label={t('llm.models.filter')} error={undefined}>
            <select id="models-provider" value={asked} onChange={(event) => setParams(event.target.value === '' ? {} : { provider: event.target.value }, { replace: true })}>
              <option value="">{t('llm.models.filterAll')}</option>
              {(providers.data ?? []).map((provider) => (
                <option key={provider.id} value={provider.id}>
                  {provider.name} ({provider.code})
                </option>
              ))}
            </select>
          </Field>
          <p className="sub" data-testid="models-usable-note">
            {t('llm.models.usableNote')}
          </p>
        </div>
        <table className="table" data-testid="model-table" aria-label={t('llm.models.table.aria')}>
          <thead>
            <tr>
              <th scope="col">{t('llm.models.column.model')}</th>
              <th scope="col">{t('llm.models.column.provider')}</th>
              <th scope="col">{t('llm.models.column.window')}</th>
              <th scope="col">{t('llm.models.column.output')}</th>
              <th scope="col">{t('llm.models.column.max')}</th>
              <th scope="col">{t('llm.models.column.capabilities')}</th>
              <th scope="col">{t('llm.models.column.status')}</th>
              <th scope="col">{t('llm.models.column.action')}</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((model) => (
              <tr key={model.id} data-model-id={model.id} data-status={model.status}>
                <td>
                  {model.modelId} {model.modelVersion === null ? null : <span className="sub">{model.modelVersion}</span>}
                </td>
                <td>{providerOf(model.providerId)?.name ?? model.providerId.slice(0, 8)}</td>
                <td>{model.contextWindow.toLocaleString('en-US')}</td>
                <td>{model.maxOutput.toLocaleString('en-US')}</td>
                <td>{classificationLabel(t, model.maxClassification)}</td>
                <td>{model.capabilities.length === 0 ? t('llm.models.none') : model.capabilities.map((capability) => capabilityLabel(t, capability)).join(', ')}</td>
                <td>
                  {modelStatusLabel(t, model.status)}
                  {model.status === 'APPROVED' ? null : <span className="sub"> · {t('llm.models.notUsable')}</span>}
                </td>
                <td>{mayApprove && (model.status === 'PROPOSED' || model.status === 'EVAL_PENDING') ? <ApproveModel model={model} /> : null}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {shown.length === 0 ? <p data-testid="models-none">{t('llm.models.empty')}</p> : null}
        {may ? <ModelForm providers={providers.data ?? []} /> : null}
      </StateBoundary>
    </section>
  );
}

function ApproveModel({ model }: { model: ModelEntry }) {
  const { t } = useTranslation();
  const approve = useApproveModel();
  const refused = approve.isError ? describeLlmProblem(approve.error) : undefined;
  return (
    <>
      <button type="button" className="btn" disabled={approve.isPending} onClick={() => approve.mutate({ modelId: model.id, version: model.version })}>
        {t('llm.models.approve')}
      </button>
      {refused === undefined ? null : (
        <p className="callout warning" role="alert" data-testid="model-approve-refused">
          {refusalMessage(t, refused.reason, refused.detail)}
        </p>
      )}
    </>
  );
}

function ModelForm({ providers }: { providers: readonly Provider[] }) {
  const { t } = useTranslation();
  const register = useRegisterModel();
  const [values, setValues] = useState<ModelValues>(EMPTY_MODEL);
  const [errors, setErrors] = useState<ModelErrors>({});
  const refused = register.isError ? describeLlmProblem(register.error) : undefined;
  const current = { ...values, providerId: values.providerId === '' ? (providers[0]?.id ?? '') : values.providerId };
  const set = <K extends keyof ModelValues>(field: K, value: ModelValues[K]): void => {
    setValues((previous) => ({ ...previous, [field]: value }));
    setErrors({});
  };
  const toggle = (capability: Capability): void => set('capabilities', current.capabilities.includes(capability) ? current.capabilities.filter((name) => name !== capability) : [...current.capabilities, capability]);
  const message = (field: keyof ModelErrors): string | undefined => (errors[field] === undefined ? undefined : problemMessage(t, errors[field]));
  const send = (event: FormEvent): void => {
    event.preventDefault();
    if (register.isPending) return;
    const found = validateModel(current, providers);
    setErrors(found);
    if (Object.keys(found).length === 0) register.mutate(current);
  };
  return (
    <form className="card" onSubmit={send} noValidate aria-label={t('llm.models.form.title')}>
      <h2>{t('llm.models.form.title')}</h2>
      <p className="sub">{t('llm.models.form.hint')}</p>
      {refused === undefined ? null : (
        <p className="callout warning" role="alert" data-testid="model-refused">
          {refusalMessage(t, refused.reason, refused.detail)}
        </p>
      )}
      {register.isSuccess ? (
        <p className="callout" role="status" data-testid="model-saved">
          {t('llm.models.form.saved')}
        </p>
      ) : null}
      <div className="mne-filters">
        <Field id="model-provider" label={t('llm.models.form.provider')} error={message('providerId')}>
          <select id="model-provider" value={current.providerId} onChange={(event) => set('providerId', event.target.value)}>
            {providers.map((provider) => (
              <option key={provider.id} value={provider.id}>
                {provider.name} ({provider.code})
              </option>
            ))}
          </select>
        </Field>
        <Field id="model-id" label={t('llm.models.form.modelId')} error={message('modelId')}>
          <input id="model-id" value={values.modelId} onChange={(event) => set('modelId', event.target.value)} maxLength={120} />
        </Field>
        <Field id="model-version" label={t('llm.models.form.version')} error={undefined}>
          <input id="model-version" value={values.modelVersion} onChange={(event) => set('modelVersion', event.target.value)} maxLength={60} />
        </Field>
        <Field id="model-window" label={t('llm.models.form.window')} error={message('contextWindow')}>
          <input id="model-window" inputMode="numeric" value={values.contextWindow} onChange={(event) => set('contextWindow', event.target.value)} />
        </Field>
        <Field id="model-output" label={t('llm.models.form.output')} error={message('maxOutput')}>
          <input id="model-output" inputMode="numeric" value={values.maxOutput} onChange={(event) => set('maxOutput', event.target.value)} />
        </Field>
        <Field id="model-max" label={t('llm.models.form.max')} error={message('maxClassification')}>
          <select id="model-max" value={values.maxClassification} onChange={(event) => set('maxClassification', event.target.value as Classification)}>
            {CLASSIFICATIONS.map((level) => (
              <option key={level} value={level}>
                {classificationLabel(t, level)}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <fieldset>
        <legend>{t('llm.models.form.capabilities')}</legend>
        {CAPABILITIES.map((capability) => (
          <label key={capability} className="field" htmlFor={`capability-${capability}`}>
            <input id={`capability-${capability}`} type="checkbox" checked={current.capabilities.includes(capability)} onChange={() => toggle(capability)} /> {capabilityLabel(t, capability)}
          </label>
        ))}
      </fieldset>
      <div className="mne-actions">
        <button type="submit" className="btn" disabled={register.isPending}>
          {t('llm.models.form.submit')}
        </button>
      </div>
    </form>
  );
}
