import { useState } from 'react';
import type { FormEvent } from 'react';
import { ApiError } from '@machvon/api-client';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { Field } from '../mne/components';
import '../dis/dis.css';
import { useModels, usePrices, useRegisterPrice } from './hooks';
import { cachedSemanticsLabel, financeProblemMessage, refusalMessage } from './labels';
import { CACHED_SEMANTICS, EMPTY_PRICE, FINOPS, describeLlmProblem, validatePrice, vietnamDay } from './llm-model';
import type { CachedSemantics, ModelEntry, PriceEntry, PriceErrors, PriceValues } from './llm-model';
import './llm-kit.css';

/**
 * LLM-08: the price versions of the models and their exchange rates (ST-LLM-003, LLM BR-LLM-04, BR-LLM-13): for each model the price per million tokens of the input, the cached input and the output, whether the cached tokens
 * are counted in the input or apart, the exchange rate to dong, the period it was in force, the source of the figures and whether a second person has verified them. A new version ends the one in force where it begins; two never
 * overlap, and a price without its source is not accepted. A price nobody has verified says so: it is the figure the declarer gave, not a market price.
 */
export default function PricesScreen({ route }: ScreenProps) {
  const tenant = useSession().tenant;
  // What is open belongs to one member of one tenant: a switch starts the screen over.
  return <PricesContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

const day = (iso: string | null): string => (iso === null ? '' : vietnamDay(iso));

function PricesContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions, mode } = useSession();
  const may = (permissions === undefined || permissions.includes(FINOPS)) && mode !== 'READ_ONLY';
  const prices = usePrices();
  const models = useModels();
  const state = useScreenState({ isLoading: prices.isLoading, error: prices.error, data: prices.data === undefined ? undefined : { rows: prices.data } });
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('llm.prices.page.title')}</h1>
          <p>{t('llm.prices.page.subtitle')}</p>
        </div>
      </div>
      <StateBoundary state={state} onRetry={() => void prices.refetch()}>
        <p className="callout" data-testid="prices-note">
          {t('llm.prices.note')}
        </p>
        <table className="table" data-testid="price-table" aria-label={t('llm.prices.table.aria')}>
          <thead>
            <tr>
              <th scope="col">{t('llm.prices.column.model')}</th>
              <th scope="col">{t('llm.prices.column.input')}</th>
              <th scope="col">{t('llm.prices.column.cached')}</th>
              <th scope="col">{t('llm.prices.column.output')}</th>
              <th scope="col">{t('llm.prices.column.semantics')}</th>
              <th scope="col">{t('llm.prices.column.fx')}</th>
              <th scope="col">{t('llm.prices.column.period')}</th>
              <th scope="col">{t('llm.prices.column.source')}</th>
            </tr>
          </thead>
          <tbody>
            {(prices.data ?? []).map((price) => (
              <PriceRow key={price.id} price={price} />
            ))}
          </tbody>
        </table>
        {(prices.data ?? []).length === 0 ? <p data-testid="prices-none">{t('llm.prices.none')}</p> : null}
        {may ? <PriceForm models={models.data ?? []} modelsError={models.error} /> : null}
      </StateBoundary>
    </section>
  );
}

/** Whether a version is the one charged now, one that waits for its day, or one that has ended: both boundaries of its period are looked at. */
export function stateOfPrice(price: PriceEntry, now: number): 'scheduled' | 'inForce' | 'ended' {
  if (Date.parse(price.effectiveFrom) > now) return 'scheduled';
  if (price.effectiveUntil !== null && Date.parse(price.effectiveUntil) <= now) return 'ended';
  return 'inForce';
}

function PriceRow({ price }: { price: PriceEntry }) {
  const { t } = useTranslation();
  const state = stateOfPrice(price, Date.now());
  return (
    <tr data-price-id={price.id} data-state={state} data-in-force={state === 'inForce' ? 'true' : 'false'}>
      <td>
        {price.modelId} <span className="sub">{price.provider}</span>
      </td>
      <td>
        {price.inputPerMillion} {price.currency}
      </td>
      <td>
        {price.cachedPerMillion} {price.currency}
      </td>
      <td>
        {price.outputPerMillion} {price.currency}
      </td>
      <td>{price.cachedSemantics === null ? '' : cachedSemanticsLabel(t, price.cachedSemantics)}</td>
      <td>{price.fxRateToVnd ?? ''}</td>
      <td>
        {day(price.effectiveFrom)} → {price.effectiveUntil === null ? t('llm.prices.open') : day(price.effectiveUntil)}{' '}
        <span className={state === 'inForce' ? 'sub' : 'callout'} data-testid="price-state">
          {state === 'inForce' ? t('llm.prices.inForce') : state === 'scheduled' ? t('llm.prices.scheduled') : t('llm.prices.ended')}
        </span>
      </td>
      <td>
        <a href={price.sourceUrl} target="_blank" rel="noreferrer noopener">
          {price.sourceUrl}
        </a>{' '}
        <span className={price.verified ? 'sub' : 'callout warning'} data-testid="price-verified" data-verified={price.verified ? 'true' : 'false'}>
          {price.verified ? t('llm.prices.verified') : t('llm.prices.unverified')}
        </span>
      </td>
    </tr>
  );
}

function PriceForm({ models, modelsError }: { models: readonly ModelEntry[]; modelsError: unknown }) {
  const modelsFailed = modelsError !== null && modelsError !== undefined;
  const { t } = useTranslation();
  const register = useRegisterPrice();
  const [values, setValues] = useState<PriceValues>({ ...EMPTY_PRICE, effectiveFrom: vietnamDay(new Date().toISOString()) });
  const [errors, setErrors] = useState<PriceErrors>({});
  const refused = register.isError ? describeLlmProblem(register.error) : undefined;
  const current = { ...values, modelRefId: values.modelRefId === '' ? (models[0]?.id ?? '') : values.modelRefId };
  const set = <K extends keyof PriceValues>(field: K, value: PriceValues[K]): void => {
    setValues((previous) => ({ ...previous, [field]: value }));
    setErrors({});
  };
  const message = (field: keyof PriceErrors): string | undefined => (errors[field] === undefined ? undefined : financeProblemMessage(t, errors[field]));
  const chosen = models.find((model) => model.id === current.modelRefId);
  const send = (event: FormEvent): void => {
    event.preventDefault();
    if (register.isPending || chosen === undefined) return;
    const found = validatePrice(current);
    setErrors(found);
    if (Object.keys(found).length === 0) register.mutate({ values: current, modelId: chosen.modelId });
  };
  return (
    <form className="card" onSubmit={send} noValidate aria-label={t('llm.prices.form.title')}>
      <h2>{t('llm.prices.form.title')}</h2>
      <p className="sub">{t('llm.prices.form.hint')}</p>
      {modelsFailed ? (
        <p className="callout warning" role="alert" data-testid="price-models-failed">
          {modelsError instanceof ApiError && modelsError.status === 403 ? t('llm.prices.form.modelsDenied') : t('llm.prices.form.modelsFailed')}
        </p>
      ) : null}
      {refused === undefined ? null : (
        <p className="callout warning" role="alert" data-testid="price-refused">
          {refusalMessage(t, refused.reason, refused.detail)}
        </p>
      )}
      {register.isSuccess ? (
        <p className="callout" role="status" data-testid="price-saved">
          {t('llm.prices.form.saved')}
        </p>
      ) : null}
      <div className="mne-filters">
        <Field id="price-model" label={t('llm.prices.form.model')} error={message('modelRefId')}>
          <select id="price-model" value={current.modelRefId} onChange={(event) => set('modelRefId', event.target.value)}>
            {models.map((model) => (
              <option key={model.id} value={model.id}>
                {model.modelId}
                {model.modelVersion === null ? '' : ` ${model.modelVersion}`}
              </option>
            ))}
          </select>
        </Field>
        <Field id="price-provider" label={t('llm.prices.form.provider')} error={message('provider')}>
          <input id="price-provider" value={values.provider} onChange={(event) => set('provider', event.target.value)} maxLength={60} />
        </Field>
        <Field id="price-currency" label={t('llm.prices.form.currency')} error={message('currency')}>
          <input id="price-currency" value={values.currency} onChange={(event) => set('currency', event.target.value.toUpperCase())} maxLength={3} />
        </Field>
        <Field id="price-input" label={t('llm.prices.form.input')} error={message('inputPerMillion')}>
          <input id="price-input" inputMode="decimal" value={values.inputPerMillion} onChange={(event) => set('inputPerMillion', event.target.value)} />
        </Field>
        <Field id="price-cached" label={t('llm.prices.form.cached')} error={message('cachedPerMillion')}>
          <input id="price-cached" inputMode="decimal" value={values.cachedPerMillion} onChange={(event) => set('cachedPerMillion', event.target.value)} />
        </Field>
        <Field id="price-output" label={t('llm.prices.form.output')} error={message('outputPerMillion')}>
          <input id="price-output" inputMode="decimal" value={values.outputPerMillion} onChange={(event) => set('outputPerMillion', event.target.value)} />
        </Field>
        <Field id="price-semantics" label={t('llm.prices.form.semantics')} error={undefined}>
          <select id="price-semantics" value={values.cachedSemantics} onChange={(event) => set('cachedSemantics', event.target.value as CachedSemantics)}>
            {CACHED_SEMANTICS.map((semantics) => (
              <option key={semantics} value={semantics}>
                {cachedSemanticsLabel(t, semantics)}
              </option>
            ))}
          </select>
        </Field>
        <Field id="price-fx" label={t('llm.prices.form.fx')} error={message('fxRateToVnd')}>
          <input id="price-fx" inputMode="decimal" value={values.fxRateToVnd} onChange={(event) => set('fxRateToVnd', event.target.value)} />
        </Field>
        <Field id="price-fx-source" label={t('llm.prices.form.fxSource')} error={message('fxSource')}>
          <input id="price-fx-source" value={values.fxSource} onChange={(event) => set('fxSource', event.target.value)} maxLength={200} />
        </Field>
        <Field id="price-from" label={t('llm.prices.form.from')} error={message('effectiveFrom')}>
          <input id="price-from" type="date" value={values.effectiveFrom} onChange={(event) => set('effectiveFrom', event.target.value)} />
        </Field>
        <Field id="price-source" label={t('llm.prices.form.source')} error={message('sourceUrl')}>
          <input id="price-source" value={values.sourceUrl} onChange={(event) => set('sourceUrl', event.target.value)} maxLength={500} />
        </Field>
      </div>
      <label className="field" htmlFor="price-reasoning">
        <input id="price-reasoning" type="checkbox" checked={values.reasoningInOutput} onChange={(event) => set('reasoningInOutput', event.target.checked)} /> {t('llm.prices.form.reasoning')}
      </label>
      <div className="mne-actions">
        <button type="submit" className="ui-button ui-button--primary" disabled={register.isPending || chosen === undefined}>
          {t('llm.prices.form.submit')}
        </button>
      </div>
    </form>
  );
}
