import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { Field } from '../mne/components';
import '../dis/dis.css';
import { effortLabel, evalProblemMessage, profileStatusLabel, toolLabel } from './eval-labels';
import { EFFORTS, EMPTY_PROFILE, PROFILE_MANAGE, READ_ONLY_TOOLS, RELEASE_PATH, validateProfile } from './eval-model';
import type { ProfileEntry, ProfileErrors, ProfileValues } from './eval-model';
import { useDraftProfile, useModels, useProfiles, usePrompts } from './hooks';
import { classificationLabel, refusalMessage, routeLabel } from './labels';
import { CLASSIFICATIONS, ROUTES, describeLlmProblem } from './llm-model';
import type { Classification, ModelEntry, Route } from './llm-model';

/**
 * LLM-04: the model profiles of the AI tasks (ST-LLM-004, LLM F3): for each task the model it uses, the models it may fall back to, the effort and the caps on what it reads and gives, the tools it may call (only tools that
 * read), the most sensitive class of data it takes, the routes it may use and the prompt it runs. A profile is drafted here and does not run until it is released on LLM-17, where every route it may use needs an evaluation that
 * an expert signed.
 */
export default function ProfilesScreen({ route }: ScreenProps) {
  const tenant = useSession().tenant;
  // What is open belongs to one member of one tenant: a switch starts the screen over.
  return <ProfilesContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function ProfilesContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions, mode } = useSession();
  const may = (permissions === undefined || permissions.includes(PROFILE_MANAGE)) && mode !== 'READ_ONLY';
  const profiles = useProfiles();
  const models = useModels();
  const prompts = usePrompts();
  const state = useScreenState({ isLoading: profiles.isLoading, error: profiles.error, data: profiles.data === undefined ? undefined : { rows: profiles.data } });
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('llm.profiles.page.title')}</h1>
          <p>{t('llm.profiles.page.subtitle')}</p>
        </div>
      </div>
      <StateBoundary state={state} onRetry={() => void profiles.refetch()}>
        <table className="table" data-testid="profile-table" aria-label={t('llm.profiles.table.aria')}>
          <thead>
            <tr>
              <th scope="col">{t('llm.profiles.column.task')}</th>
              <th scope="col">{t('llm.profiles.column.revision')}</th>
              <th scope="col">{t('llm.profiles.column.model')}</th>
              <th scope="col">{t('llm.profiles.column.routes')}</th>
              <th scope="col">{t('llm.profiles.column.max')}</th>
              <th scope="col">{t('llm.profiles.column.effort')}</th>
              <th scope="col">{t('llm.profiles.column.status')}</th>
              <th scope="col">{t('llm.profiles.column.action')}</th>
            </tr>
          </thead>
          <tbody>
            {(profiles.data ?? []).map((profile) => (
              <tr key={profile.id} data-profile-id={profile.id} data-status={profile.status}>
                <td>{profile.taskType}</td>
                <td>{profile.revision}</td>
                <td>{profile.modelId}</td>
                <td>{profile.routes.map((entry) => routeLabel(t, entry)).join(', ')}</td>
                <td>{profile.maxClassification === null ? t('llm.profiles.none') : classificationLabel(t, profile.maxClassification)}</td>
                <td>{profile.effort === null ? t('llm.profiles.none') : effortLabel(t, profile.effort)}</td>
                <td>{profileStatusLabel(t, profile.status)}</td>
                <td>
                  <Link to={`${RELEASE_PATH}?profile=${profile.id}`}>{t('llm.profiles.release')}</Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {(profiles.data ?? []).length === 0 ? <p data-testid="profiles-none">{t('llm.profiles.empty')}</p> : null}
        {may ? (
          <ProfileForm
            profiles={profiles.data ?? []}
            models={(models.data ?? []).filter((model) => model.status === 'APPROVED')}
            prompts={(prompts.data ?? []).filter((prompt) => prompt.status === 'APPROVED')}
            loading={models.isLoading || prompts.isLoading}
            failed={models.error ?? prompts.error}
            onRetry={() => {
              void models.refetch();
              void prompts.refetch();
            }}
          />
        ) : null}
      </StateBoundary>
    </section>
  );
}

const toggled = <T,>(list: readonly T[], value: T): T[] => (list.includes(value) ? list.filter((entry) => entry !== value) : [...list, value]);

function ProfileForm({ profiles, models, prompts, loading, failed, onRetry }: { profiles: readonly ProfileEntry[]; models: readonly ModelEntry[]; prompts: ReadonlyArray<{ id: string; taskType: string; name: string; revision: number }>; loading: boolean; failed: unknown; onRetry: () => void }) {
  const { t } = useTranslation();
  const draft = useDraftProfile();
  const [values, setValues] = useState<ProfileValues>(EMPTY_PROFILE);
  const [errors, setErrors] = useState<ProfileErrors>({});
  const refused = draft.isError ? describeLlmProblem(draft.error) : undefined;
  const unavailable = loading || (failed !== undefined && failed !== null);
  const set = <K extends keyof ProfileValues>(field: K, value: ProfileValues[K]): void => {
    setValues((previous) => ({ ...previous, [field]: value }));
    setErrors({});
  };
  const message = (field: keyof ProfileErrors): string | undefined => (errors[field] === undefined ? undefined : evalProblemMessage(t, errors[field]));
  const before = profiles.filter((profile) => profile.taskType === values.taskType.trim() && (profile.status === 'PUBLISHED' || profile.status === 'SUPERSEDED'));
  const send = (event: FormEvent): void => {
    event.preventDefault();
    // The models and the prompts are what a profile is made of: it is not sent while they load or could not be read.
    if (draft.isPending || unavailable) return;
    const found = validateProfile(values);
    setErrors(found);
    const chosen = models.find((model) => model.id === values.modelId);
    if (Object.keys(found).length === 0 && chosen !== undefined) draft.mutate({ values, providerModelId: chosen.modelId });
  };
  const number = (field: 'outputCap' | 'maxInputTokens' | 'timeoutMs' | 'concurrencyLimit' | 'retentionDays', label: string) => (
    <Field id={`profile-${field}`} label={label} error={message(field)}>
      <input id={`profile-${field}`} inputMode="numeric" value={values[field]} onChange={(event) => set(field, event.target.value)} />
    </Field>
  );
  return (
    <form className="card" onSubmit={send} noValidate aria-label={t('llm.profiles.form.title')}>
      <h2>{t('llm.profiles.form.title')}</h2>
      <p className="sub">{t('llm.profiles.form.hint')}</p>
      {refused === undefined ? null : (
        <p className="callout warning" role="alert" data-testid="profile-refused">
          {refusalMessage(t, refused.reason, refused.detail)}
        </p>
      )}
      {draft.isSuccess ? (
        <p className="callout" role="status" data-testid="profile-saved">
          {t('llm.profiles.form.saved')}
        </p>
      ) : null}
      {failed === undefined || failed === null ? null : (
        <p className="callout warning" role="alert" data-testid="profile-sources-failed">
          {t('llm.profiles.form.sourcesFailed')}{' '}
          <button type="button" className="btn" onClick={onRetry}>
            {t('llm.profiles.form.sourcesRetry')}
          </button>
        </p>
      )}
      {loading ? <p className="sub">{t('llm.profiles.form.sourcesLoading')}</p> : null}
      <div className="mne-filters">
        <Field id="profile-task" label={t('llm.profiles.form.task')} error={message('taskType')}>
          <input id="profile-task" value={values.taskType} onChange={(event) => set('taskType', event.target.value)} maxLength={60} />
        </Field>
        <Field id="profile-model" label={t('llm.profiles.form.model')} error={message('modelId')}>
          <select
            id="profile-model"
            value={values.modelId}
            onChange={(event) => {
              set('modelId', event.target.value);
              // The model it runs is one of the models it may use.
              if (event.target.value !== '' && !values.allowedModelIds.includes(event.target.value)) setValues((previous) => ({ ...previous, modelId: event.target.value, allowedModelIds: [...previous.allowedModelIds, event.target.value] }));
            }}
          >
            <option value="">{t('llm.profiles.form.choose')}</option>
            {models.map((model) => (
              <option key={model.id} value={model.id}>
                {model.modelId}
                {model.modelVersion === null ? '' : ` ${model.modelVersion}`}
              </option>
            ))}
          </select>
        </Field>
        <Field id="profile-effort" label={t('llm.profiles.form.effort')} error={undefined}>
          <select id="profile-effort" value={values.effort} onChange={(event) => set('effort', event.target.value)}>
            <option value="">{t('llm.profiles.none')}</option>
            {EFFORTS.map((effort) => (
              <option key={effort} value={effort}>
                {effortLabel(t, effort)}
              </option>
            ))}
          </select>
        </Field>
        <Field id="profile-max" label={t('llm.profiles.form.max')} error={undefined}>
          <select id="profile-max" value={values.maxClassification} onChange={(event) => set('maxClassification', event.target.value as Classification)}>
            {CLASSIFICATIONS.map((level) => (
              <option key={level} value={level}>
                {classificationLabel(t, level)}
              </option>
            ))}
          </select>
        </Field>
        <Field id="profile-prompt" label={t('llm.profiles.form.prompt')} error={message('promptVersionId')}>
          <select id="profile-prompt" value={values.promptVersionId} onChange={(event) => set('promptVersionId', event.target.value)}>
            <option value="">{t('llm.profiles.form.choose')}</option>
            {prompts.map((prompt) => (
              <option key={prompt.id} value={prompt.id}>
                {prompt.taskType} · {prompt.name} #{prompt.revision}
              </option>
            ))}
          </select>
        </Field>
        <Field id="profile-rollback" label={t('llm.profiles.form.rollback')} error={undefined} hint={t('llm.profiles.form.rollbackHint')}>
          <select id="profile-rollback" value={values.rollbackProfileId} onChange={(event) => set('rollbackProfileId', event.target.value)}>
            <option value="">{t('llm.profiles.form.rollbackDefault')}</option>
            {before.map((profile) => (
              <option key={profile.id} value={profile.id}>
                #{profile.revision} · {profileStatusLabel(t, profile.status)}
              </option>
            ))}
          </select>
        </Field>
        {number('outputCap', t('llm.profiles.form.outputCap'))}
        {number('maxInputTokens', t('llm.profiles.form.maxInput'))}
        {number('timeoutMs', t('llm.profiles.form.timeout'))}
        {number('concurrencyLimit', t('llm.profiles.form.concurrency'))}
        {number('retentionDays', t('llm.profiles.form.retention'))}
      </div>
      <fieldset>
        <legend>{t('llm.profiles.form.allowed')}</legend>
        {message('allowedModelIds') === undefined ? null : (
          <p className="callout warning" role="alert">
            {message('allowedModelIds')}
          </p>
        )}
        {!loading && !unavailable && models.length === 0 ? <p className="sub">{t('llm.profiles.form.noModels')}</p> : null}
        {models.map((model) => (
          <label key={model.id} className="field" htmlFor={`profile-allowed-${model.id}`}>
            <input id={`profile-allowed-${model.id}`} type="checkbox" checked={values.allowedModelIds.includes(model.id)} onChange={() => set('allowedModelIds', toggled(values.allowedModelIds, model.id))} /> {model.modelId}
          </label>
        ))}
      </fieldset>
      <fieldset>
        <legend>{t('llm.profiles.form.routes')}</legend>
        {message('routes') === undefined ? null : (
          <p className="callout warning" role="alert">
            {message('routes')}
          </p>
        )}
        {ROUTES.map((entry: Route) => (
          <label key={entry} className="field" htmlFor={`profile-route-${entry}`}>
            <input id={`profile-route-${entry}`} type="checkbox" checked={values.routes.includes(entry)} onChange={() => set('routes', toggled(values.routes, entry))} /> {routeLabel(t, entry)}
          </label>
        ))}
      </fieldset>
      <fieldset>
        <legend>{t('llm.profiles.form.tools')}</legend>
        <p className="sub">{t('llm.profiles.form.toolsHint')}</p>
        {READ_ONLY_TOOLS.map((tool) => (
          <label key={tool} className="field" htmlFor={`profile-tool-${tool}`}>
            <input id={`profile-tool-${tool}`} type="checkbox" checked={values.toolAllowlist.includes(tool)} onChange={() => set('toolAllowlist', toggled(values.toolAllowlist, tool))} /> {toolLabel(t, tool)}
          </label>
        ))}
      </fieldset>
      <Field id="profile-schema" label={t('llm.profiles.form.schema')} error={message('outputSchema')}>
        <textarea id="profile-schema" rows={3} value={values.outputSchema} onChange={(event) => set('outputSchema', event.target.value)} />
      </Field>
      <div className="mne-actions">
        <button type="submit" className="btn" disabled={draft.isPending || unavailable}>
          {t('llm.profiles.form.submit')}
        </button>
      </div>
    </form>
  );
}
