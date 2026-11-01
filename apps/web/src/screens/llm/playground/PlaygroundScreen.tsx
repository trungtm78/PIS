import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { Field } from '../../mne/components';
import { attemptKindLabel, outcomeLabel, rejectCodeLabel, requestStatusLabel } from '../eval-labels';
import { evalCost } from '../eval-model';
import type { ProfileEntry } from '../eval-model';
import { AUDIT_READ } from '../gateway-model';
import { useProfiles, useRouteDecision } from '../hooks';
import { classificationLabel, routeLabel } from '../labels';
import { useTryPrompt } from './hooks';
import { problemMessage, reasonMessage } from './labels';
import { EMPTY_FORM, INVOKE_PERMISSION, MAX_INPUT, PROFILE_READ_PERMISSION, TRACE_PATH, describeProblem, validate } from './model';
import type { Answer, FormErrors, PlaygroundForm } from './model';

const holds = (permissions: readonly string[] | undefined, permission: string): boolean => permissions === undefined || permissions.includes(permission);

/**
 * LLM-11: the controlled playground (ST-LLM-009, LLM F1, BR-LLM-01): a try of a published profile with documents the person may read goes through the same classification, the same route rules and the same budget as every
 * other request, so a try with CONFIDENTIAL data never reaches a route that is not allowed for it. What is typed is hashed in the browser and only the hash travels; neither the input nor the answer is kept or shown. The
 * cost a try may reach is a ceiling the person sets, and the gateway refuses the try above it.
 */
export default function PlaygroundScreen({ route }: ScreenProps) {
  const tenant = useSession().tenant;
  // What is typed belongs to one member of one tenant: a switch starts the screen over.
  return <PlaygroundContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function PlaygroundContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions } = useSession();
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('llm.playground.page.title')}</h1>
          <p>{t('llm.playground.page.subtitle')}</p>
        </div>
      </div>
      <p className="callout" data-testid="playground-note">
        {t('llm.playground.rule.note')}
      </p>
      {holds(permissions, INVOKE_PERMISSION) && holds(permissions, PROFILE_READ_PERMISSION) ? (
        <Playground />
      ) : (
        <div data-testid="playground-denied">
          <StateBoundary state="denied" />
        </div>
      )}
      <p className="prototype-note">{t('llm.playground.footer', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

const published = (profiles: readonly ProfileEntry[]): ProfileEntry[] => profiles.filter((profile) => profile.status === 'PUBLISHED');

function Playground() {
  const { t } = useTranslation();
  const { mode } = useSession();
  const profiles = useProfiles();
  const state = useScreenState({ isLoading: profiles.isLoading, error: profiles.error, data: profiles.data === undefined ? undefined : published(profiles.data) });
  const available = published(profiles.data ?? []);
  const [form, setForm] = useState<PlaygroundForm>(EMPTY_FORM);
  const [errors, setErrors] = useState<FormErrors>({});
  const attempt = useTryPrompt();
  const chosen = available.find((profile) => profile.id === form.profileId);
  const set = <K extends keyof PlaygroundForm>(field: K, value: PlaygroundForm[K]): void => setForm((previous) => ({ ...previous, [field]: value }));
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const found = validate(form);
    setErrors(found);
    if (Object.keys(found).length > 0 || chosen === undefined) return;
    // The text is not kept once it was sent: it is hashed on its way and cleared when the try is answered, unless the person has gone on typing in the meantime: that text was never sent, and it stays.
    attempt.mutate({ form, taskType: chosen.taskType }, { onSuccess: () => setForm((previous) => (previous.input === form.input ? { ...previous, input: '' } : previous)) });
  };
  const message = (field: keyof PlaygroundForm): string | undefined => (errors[field] === undefined ? undefined : problemMessage(t, errors[field]));
  return (
    <StateBoundary state={state} onRetry={() => void profiles.refetch()}>
      <form className="card" aria-label={t('llm.playground.form.title')} onSubmit={submit} noValidate>
        <h2>{t('llm.playground.form.title')}</h2>
        <Field id="pg-profile" label={t('llm.playground.field.profile')} error={message('profileId')}>
          <select id="pg-profile" value={form.profileId} onChange={(event) => set('profileId', event.target.value)}>
            <option value="">{t('llm.playground.profile.none')}</option>
            {available.map((profile) => (
              <option key={profile.id} value={profile.id}>
                {t('llm.playground.profile.option', { task: profile.taskType, revision: profile.revision, model: profile.modelId })}
              </option>
            ))}
          </select>
        </Field>
        {chosen === undefined ? null : <ProfileFacts profile={chosen} />}
        <Field id="pg-module" label={t('llm.playground.field.module')} error={message('subjectModule')}>
          <input id="pg-module" value={form.subjectModule} maxLength={10} onChange={(event) => set('subjectModule', event.target.value)} />
        </Field>
        <Field id="pg-documents" label={t('llm.playground.field.documents')} hint={t('llm.playground.field.documents.hint')} error={message('documents')}>
          <textarea id="pg-documents" rows={3} value={form.documents} onChange={(event) => set('documents', event.target.value)} />
        </Field>
        <Field id="pg-input" label={t('llm.playground.field.input')} hint={t('llm.playground.field.input.hint', { max: MAX_INPUT })} error={message('input')}>
          <textarea id="pg-input" rows={5} value={form.input} autoComplete="off" onChange={(event) => set('input', event.target.value)} />
        </Field>
        <Field id="pg-cost" label={t('llm.playground.field.cost')} hint={t('llm.playground.field.cost.hint')} error={message('maxCostVnd')}>
          <input id="pg-cost" inputMode="numeric" value={form.maxCostVnd} onChange={(event) => set('maxCostVnd', event.target.value)} />
        </Field>
        <Field id="pg-attestation" label={t('llm.playground.field.attestation')} error={message('attestationId')}>
          <input id="pg-attestation" value={form.attestationId} onChange={(event) => set('attestationId', event.target.value)} />
        </Field>
        {attempt.isError ? (
          <p className="callout warning" role="alert" data-testid="playground-refused">
            {reasonMessage(t, describeProblem(attempt.error))}
          </p>
        ) : null}
        <button type="submit" className="primary" disabled={attempt.isPending || mode === 'READ_ONLY'}>
          {t('llm.playground.submit.action')}
        </button>
      </form>
      {attempt.data === undefined ? null : <Result answer={attempt.data} />}
    </StateBoundary>
  );
}

function ProfileFacts({ profile }: { profile: ProfileEntry }) {
  const { t } = useTranslation();
  return (
    <dl className="aud-facts" data-testid="playground-profile">
      <dt>{t('llm.playground.profile.routes')}</dt>
      <dd>{profile.routes.length === 0 ? '—' : profile.routes.map((entry) => routeLabel(t, entry)).join(', ')}</dd>
      <dt>{t('llm.playground.profile.ceiling')}</dt>
      <dd>{profile.maxClassification === null ? '—' : classificationLabel(t, profile.maxClassification)}</dd>
    </dl>
  );
}

function Result({ answer }: { answer: Answer }) {
  const { t } = useTranslation();
  const { permissions } = useSession();
  const traceable = holds(permissions, AUDIT_READ);
  return (
    <section className="card" aria-label={t('llm.playground.result.title')} data-testid="playground-result" data-request-id={answer.requestId}>
      <h2>{t('llm.playground.result.title')}</h2>
      <dl>
        <dt>{t('llm.playground.result.classification')}</dt>
        <dd data-testid="result-classification">{answer.classification === null ? '—' : classificationLabel(t, answer.classification)}</dd>
        <dt>{t('llm.playground.result.route')}</dt>
        <dd data-testid="result-route">{answer.route === null ? t('llm.requests.noRoute') : routeLabel(t, answer.route)}</dd>
        <dt>{t('llm.playground.result.status')}</dt>
        <dd data-testid="result-status">
          {requestStatusLabel(t, answer.status)}
          {answer.rejectCode === null ? null : <span className="sub"> · {rejectCodeLabel(t, answer.rejectCode)}</span>}
        </dd>
      </dl>
      {traceable ? (
        <>
          <p>
            <Link to={`${TRACE_PATH}?trace=${answer.requestId}`}>{t('llm.playground.result.trace')}</Link>
          </p>
          <Attempts requestId={answer.requestId} />
        </>
      ) : null}
    </section>
  );
}

function Attempts({ requestId }: { requestId: string }) {
  const { t } = useTranslation();
  const decision = useRouteDecision(requestId);
  const attempts = decision.data?.attempts ?? [];
  if (attempts.length === 0) return null;
  return (
    <div className="tablewrap">
      <table className="table" data-testid="playground-attempts" aria-label={t('llm.routing.attempts.aria')}>
        <thead>
          <tr>
            <th scope="col">{t('llm.routing.attempts.no')}</th>
            <th scope="col">{t('llm.routing.attempts.kind')}</th>
            <th scope="col">{t('llm.routing.attempts.route')}</th>
            <th scope="col">{t('llm.routing.attempts.model')}</th>
            <th scope="col">{t('llm.routing.attempts.outcome')}</th>
            <th scope="col">{t('llm.routing.attempts.cost')}</th>
          </tr>
        </thead>
        <tbody>
          {attempts.map((attempt) => (
            <tr key={attempt.id}>
              <td>{attempt.no}</td>
              <td>{attemptKindLabel(t, attempt.kind)}</td>
              <td>{routeLabel(t, attempt.route)}</td>
              <td>{attempt.modelId}</td>
              <td>{outcomeLabel(t, attempt.outcome)}</td>
              <td>{attempt.costVnd === null ? '—' : `${evalCost(attempt.costVnd)} ₫`}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
