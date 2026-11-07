import { useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { Field } from '../mne/components';
import '../dis/dis.css';
import { useCreateKey, useKeys, useModels, useRevokeKey, useRotateKey } from './hooks';
import { keyScopeLabel, keyStatusLabel, problemMessage, refusalMessage } from './labels';
import { ApiError } from '@machvon/api-client';
import { EMPTY_KEY, KEY_MANAGE, KEY_SCOPES, MIN_REVOKE_REASON, describeLlmProblem, validateKey, vietnamDay } from './llm-model';
import type { KeyEntry, KeyErrors, KeyScope, KeyValues, ModelEntry } from './llm-model';
import './llm-kit.css';

/**
 * LLM-06: the virtual keys of the AI gateway (ST-LLM-002, LLM F5, BR-LLM-09): for each key its alias, its scope, the number of models it reaches, its end, its fingerprint and its state (a key that is being rotated
 * says when it stops). The secret is in the vault and is never here: no field, button or message of this screen can show it, and the fingerprint is all that tells one key from another. A key is rotated (the old one
 * goes on for a day) or revoked (it stops at once, with a reason).
 */
export default function KeysScreen({ route }: ScreenProps) {
  const tenant = useSession().tenant;
  // What is open belongs to one member of one tenant: a switch starts the screen over.
  return <KeysContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

const day = (iso: string): string => vietnamDay(iso);

function KeysContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions, mode } = useSession();
  const may = (permissions === undefined || permissions.includes(KEY_MANAGE)) && mode !== 'READ_ONLY';
  const keys = useKeys();
  const models = useModels();
  const state = useScreenState({ isLoading: keys.isLoading, error: keys.error, data: keys.data === undefined ? undefined : { rows: keys.data } });
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('llm.keys.page.title')}</h1>
          <p>{t('llm.keys.page.subtitle')}</p>
        </div>
      </div>
      <StateBoundary state={state} onRetry={() => void keys.refetch()}>
        <p className="callout" data-testid="keys-vault-note">
          {t('llm.keys.vaultNote')}
        </p>
        <table className="table" data-testid="key-table" aria-label={t('llm.keys.table.aria')}>
          <thead>
            <tr>
              <th scope="col">{t('llm.keys.column.alias')}</th>
              <th scope="col">{t('llm.keys.column.scope')}</th>
              <th scope="col">{t('llm.keys.column.models')}</th>
              <th scope="col">{t('llm.keys.column.expires')}</th>
              <th scope="col">{t('llm.keys.column.fingerprint')}</th>
              <th scope="col">{t('llm.keys.column.status')}</th>
              <th scope="col">{t('llm.keys.column.action')}</th>
            </tr>
          </thead>
          <tbody>
            {(keys.data ?? []).map((key) => (
              <KeyRow key={key.id} entry={key} may={may} />
            ))}
          </tbody>
        </table>
        {(keys.data ?? []).length === 0 ? <p data-testid="keys-none">{t('llm.keys.none')}</p> : null}
        {may ? (
          <KeyForm models={(models.data ?? []).filter((model) => model.status === 'APPROVED')} modelsLoading={models.isLoading} modelsError={models.error} onRetry={() => void models.refetch()} />
        ) : null}
      </StateBoundary>
    </section>
  );
}

function KeyRow({ entry, may }: { entry: KeyEntry; may: boolean }) {
  const { t } = useTranslation();
  const rotate = useRotateKey();
  const revoke = useRevokeKey();
  const [reason, setReason] = useState('');
  const [asking, setAsking] = useState(false);
  const [short, setShort] = useState(false);
  const refused = rotate.isError ? describeLlmProblem(rotate.error) : revoke.isError ? describeLlmProblem(revoke.error) : undefined;
  const live = entry.status !== 'REVOKED';
  const send = (event: FormEvent): void => {
    event.preventDefault();
    if (revoke.isPending) return;
    if (reason.trim().length < MIN_REVOKE_REASON) {
      setShort(true);
      return;
    }
    revoke.mutate({ keyId: entry.id, version: entry.version, reason });
  };
  return (
    <>
      <tr data-key-id={entry.id} data-status={entry.status}>
        <td>{entry.alias}</td>
        <td>{keyScopeLabel(t, entry.scope)}</td>
        <td>{entry.modelIds.length}</td>
        <td>{day(entry.expiresAt)}</td>
        <td>
          <code>{entry.fingerprint}</code>
        </td>
        <td>
          {keyStatusLabel(t, entry.status)}
          {entry.status === 'ROTATING' ? <span className="sub"> · {t('llm.keys.rotatingUntil', { date: day(entry.expiresAt) })}</span> : null}
          {entry.status === 'REVOKED' && entry.revokedReason !== null ? <span className="sub"> · {entry.revokedReason}</span> : null}
        </td>
        <td>
          {may && live ? (
            <div className="mne-actions">
              {entry.status === 'ACTIVE' ? (
                <button type="button" className="ui-button ui-button--outline ui-button--small" disabled={rotate.isPending} onClick={() => rotate.mutate({ keyId: entry.id, version: entry.version })}>
                  {t('llm.keys.rotate')}
                </button>
              ) : null}
              <button type="button" className="ui-button ui-button--outline ui-button--small" aria-expanded={asking} onClick={() => setAsking(!asking)}>
                {t('llm.keys.revoke')}
              </button>
            </div>
          ) : null}
          {refused === undefined ? null : (
            <p className="callout warning" role="alert" data-testid="key-refused">
              {refusalMessage(t, refused.reason, refused.detail)}
            </p>
          )}
        </td>
      </tr>
      {asking && live ? (
        <tr data-revoke-for={entry.id}>
          <td colSpan={7}>
            <form onSubmit={send} noValidate aria-label={t('llm.keys.revoke.title', { alias: entry.alias })}>
              <Field id={`reason-${entry.id}`} label={t('llm.keys.revoke.reason')} error={short ? t('llm.keys.revoke.short', { count: MIN_REVOKE_REASON }) : undefined}>
                <input
                  id={`reason-${entry.id}`}
                  value={reason}
                  onChange={(event) => {
                    setReason(event.target.value);
                    setShort(false);
                  }}
                  maxLength={500}
                />
              </Field>
              <p className="sub">{t('llm.keys.revoke.hint')}</p>
              <div className="mne-actions">
                <button type="submit" className="ui-button ui-button--primary" disabled={revoke.isPending}>
                  {t('llm.keys.revoke.submit')}
                </button>
              </div>
            </form>
          </td>
        </tr>
      ) : null}
    </>
  );
}

function KeyForm({ models, modelsLoading, modelsError, onRetry }: { models: readonly ModelEntry[]; modelsLoading: boolean; modelsError: unknown; onRetry: () => void }) {
  const { t } = useTranslation();
  const create = useCreateKey();
  const today = vietnamDay(new Date().toISOString());
  const [values, setValues] = useState<KeyValues>(EMPTY_KEY);
  const [errors, setErrors] = useState<KeyErrors>({});
  const refused = create.isError ? describeLlmProblem(create.error) : undefined;
  const set = <K extends keyof KeyValues>(field: K, value: KeyValues[K]): void => {
    setValues((previous) => ({ ...previous, [field]: value }));
    setErrors({});
  };
  const toggle = (id: string): void => set('modelIds', values.modelIds.includes(id) ? values.modelIds.filter((entry) => entry !== id) : [...values.modelIds, id]);
  const message = (field: keyof KeyErrors): string | undefined => (errors[field] === undefined ? undefined : problemMessage(t, errors[field]));
  const send = (event: FormEvent): void => {
    event.preventDefault();
    // The models are what a key is for: it is not made while the catalogue is loading or could not be read.
    if (create.isPending || modelsLoading || (modelsError !== undefined && modelsError !== null)) return;
    const found = validateKey(values, today);
    setErrors(found);
    if (Object.keys(found).length === 0) create.mutate(values);
  };
  return (
    <form className="card" onSubmit={send} noValidate aria-label={t('llm.keys.form.title')}>
      <h2>{t('llm.keys.form.title')}</h2>
      <p className="sub">{t('llm.keys.form.hint')}</p>
      {refused === undefined ? null : (
        <p className="callout warning" role="alert" data-testid="key-create-refused">
          {refusalMessage(t, refused.reason, refused.detail)}
        </p>
      )}
      {create.isSuccess ? (
        <p className="callout" role="status" data-testid="key-saved">
          {t('llm.keys.form.saved')}
        </p>
      ) : null}
      <div className="mne-filters">
        <Field id="key-alias" label={t('llm.keys.form.alias')} error={message('alias')}>
          <input id="key-alias" value={values.alias} onChange={(event) => set('alias', event.target.value)} maxLength={80} />
        </Field>
        <Field id="key-scope" label={t('llm.keys.form.scope')} error={undefined}>
          <select id="key-scope" value={values.scope} onChange={(event) => set('scope', event.target.value as KeyScope)}>
            {KEY_SCOPES.map((scope) => (
              <option key={scope} value={scope}>
                {keyScopeLabel(t, scope)}
              </option>
            ))}
          </select>
        </Field>
        <Field id="key-expires" label={t('llm.keys.form.expires')} error={message('expiresOn')}>
          <input id="key-expires" type="date" value={values.expiresOn} onChange={(event) => set('expiresOn', event.target.value)} />
        </Field>
        <Field id="key-rpm" label={t('llm.keys.form.rpm')} error={message('rpmLimit')}>
          <input id="key-rpm" inputMode="numeric" value={values.rpmLimit} onChange={(event) => set('rpmLimit', event.target.value)} />
        </Field>
        <Field id="key-tpm" label={t('llm.keys.form.tpm')} error={message('tpmLimit')}>
          <input id="key-tpm" inputMode="numeric" value={values.tpmLimit} onChange={(event) => set('tpmLimit', event.target.value)} />
        </Field>
      </div>
      <fieldset>
        <legend>{t('llm.keys.form.models')}</legend>
        {message('modelIds') === undefined ? null : (
          <p className="callout warning" role="alert">
            {message('modelIds')}
          </p>
        )}
        {modelsError === undefined || modelsError === null ? null : (
          <p className="callout warning" role="alert" data-testid="key-models-failed">
            {modelsError instanceof ApiError && modelsError.status === 403 ? t('llm.keys.form.modelsDenied') : t('llm.keys.form.modelsFailed')}{' '}
            <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={onRetry}>
              {t('llm.keys.form.modelsRetry')}
            </button>
          </p>
        )}
        {modelsLoading ? <p className="sub">{t('llm.keys.form.modelsLoading')}</p> : null}
        {!modelsLoading && (modelsError === undefined || modelsError === null) && models.length === 0 ? <p className="sub">{t('llm.keys.form.noModels')}</p> : null}
        {models.map((model) => (
          <label key={model.id} className="field" htmlFor={`key-model-${model.id}`}>
            <input id={`key-model-${model.id}`} type="checkbox" checked={values.modelIds.includes(model.id)} onChange={() => toggle(model.id)} /> {model.modelId}
            {model.modelVersion === null ? '' : ` ${model.modelVersion}`}
          </label>
        ))}
      </fieldset>
      <div className="mne-actions">
        <button type="submit" className="ui-button ui-button--primary" disabled={create.isPending || modelsLoading || (modelsError !== undefined && modelsError !== null)}>
          {t('llm.keys.form.submit')}
        </button>
      </div>
    </form>
  );
}
