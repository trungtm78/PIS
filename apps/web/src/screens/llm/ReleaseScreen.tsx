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
import { gateLabel, metricLabel, profileStatusLabel, runStatusLabel } from './eval-labels';
import { EVAL_MANAGE, EVAL_SIGN, PROFILE_PUBLISH, evalCost, gateOfRoute, releasable } from './eval-model';
import type { DatasetEntry, ProfileEntry, RunEntry } from './eval-model';
import { useDatasets, useDecideProfile, useEvalRuns, useModels, useProfiles, useSignEvalRun, useStartEvalRun } from './hooks';
import { refusalMessage, routeLabel } from './labels';
import { describeLlmProblem } from './llm-model';
import type { Route } from './llm-model';
import './llm-kit.css';

const MIN_COMMENT = 10;
const open = (profile: ProfileEntry): boolean => profile.status === 'DRAFT' || profile.status === 'EVAL_PENDING';

/**
 * LLM-17: the release of a profile of the AI gateway (ST-LLM-004, LLM F4, BR-LLM-11): for each route the profile may use, the evaluation that stands and where it is (not run, waiting for an expert, failed, signed as passed or
 * failed), the metrics against the thresholds and what failed. A profile is released only when every route has an evaluation signed as passed by an expert who did not start it, and every model it may use is approved; the person
 * who drafted it cannot release it. A release takes the place of the one that is in force, which stays as the profile to go back to.
 */
export default function ReleaseScreen({ route }: ScreenProps) {
  const tenant = useSession().tenant;
  // What is open belongs to one member of one tenant: a switch starts the screen over.
  return <ReleaseContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function ReleaseContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  const profiles = useProfiles();
  const asked = params.get('profile') ?? '';
  const chosen = (profiles.data ?? []).find((profile) => profile.id === asked);
  const state = useScreenState({ isLoading: profiles.isLoading, error: profiles.error, data: profiles.data === undefined ? undefined : { rows: profiles.data } });
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('llm.release.page.title')}</h1>
          <p>{t('llm.release.page.subtitle')}</p>
        </div>
      </div>
      <StateBoundary state={state} onRetry={() => void profiles.refetch()}>
        <div className="card">
          <Field id="release-profile" label={t('llm.release.choose')} error={undefined}>
            <select id="release-profile" value={chosen === undefined ? '' : chosen.id} onChange={(event) => setParams(event.target.value === '' ? {} : { profile: event.target.value }, { replace: true })}>
              <option value="">{t('llm.release.chooseNone')}</option>
              {(profiles.data ?? []).map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.taskType} #{profile.revision} · {profileStatusLabel(t, profile.status)}
                </option>
              ))}
            </select>
          </Field>
        </div>
        {asked !== '' && chosen === undefined ? (
          <p className="callout warning" role="alert" data-testid="release-unknown">
            {t('llm.release.unknown')}
          </p>
        ) : null}
        {chosen === undefined ? <p data-testid="release-pick">{t('llm.release.pick')}</p> : <ProfileRelease key={chosen.id} profile={chosen} />}
      </StateBoundary>
    </section>
  );
}

function ProfileRelease({ profile }: { profile: ProfileEntry }) {
  const { t } = useTranslation();
  const { permissions, mode } = useSession();
  const writable = mode !== 'READ_ONLY';
  const holds = (permission: string): boolean => (permissions === undefined || permissions.includes(permission)) && writable;
  const runs = useEvalRuns(profile.id);
  const datasets = useDatasets();
  const models = useModels();
  // The datasets matter to who starts an evaluation: for them a failure to read them is a failure of the page, with a retry that reads again what failed.
  const mayStart = open(profile) && holds(EVAL_MANAGE);
  const needsDatasets = mayStart;
  const state = useScreenState({
    isLoading: runs.isLoading || models.isLoading || (needsDatasets && datasets.isLoading),
    error: runs.error ?? models.error ?? (needsDatasets ? datasets.error : null),
    data: runs.data === undefined || models.data === undefined || (needsDatasets && datasets.data === undefined) ? undefined : { rows: runs.data },
  });
  const retry = (): void => {
    if (runs.isError) void runs.refetch();
    if (models.isError) void models.refetch();
    if (datasets.isError) void datasets.refetch();
  };
  const allowed = profile.allowedModelIds.map((id) => (models.data ?? []).find((model) => model.id === id) ?? { id, modelId: id.slice(0, 8), status: 'PROPOSED' as const });
  const unapproved = allowed.filter((model) => model.status !== 'APPROVED');
  const current = runs.data ?? [];
  const ready = releasable(profile.routes, current) && unapproved.length === 0;
  return (
    <div data-profile-id={profile.id} data-status={profile.status}>
      <div className="card">
        <h2>
          {profile.taskType} #{profile.revision}
        </h2>
        <p data-testid="release-status">{profileStatusLabel(t, profile.status)}</p>
        <p className="sub">{t('llm.release.models', { models: allowed.map((model) => model.modelId).join(', ') })}</p>
        {unapproved.length === 0 ? null : (
          <p className="callout warning" role="alert" data-testid="release-unapproved">
            {t('llm.release.unapproved', { models: unapproved.map((model) => model.modelId).join(', ') })}
          </p>
        )}
        {profile.rollbackProfileId === null ? null : <p className="sub">{t('llm.release.rollback', { id: profile.rollbackProfileId.slice(0, 8) })}</p>}
      </div>
      <StateBoundary state={state} onRetry={retry}>
        <div className="tablewrap" role="region" aria-label={t('llm.release.table.aria')} tabIndex={0}>
          <table className="table" data-testid="gate-table" aria-label={t('llm.release.table.aria')}>
            <thead>
              <tr>
                <th scope="col">{t('llm.release.column.route')}</th>
                <th scope="col">{t('llm.release.column.gate')}</th>
                <th scope="col">{t('llm.release.column.metrics')}</th>
                <th scope="col">{t('llm.release.column.cost')}</th>
                <th scope="col">{t('llm.release.column.action')}</th>
              </tr>
            </thead>
            <tbody>
              {profile.routes.map((entry) => (
                <RouteRow key={entry} profile={profile} route={entry} runs={current} datasets={datasets.data ?? []} mayStart={mayStart} maySign={open(profile) && holds(EVAL_SIGN)} />
              ))}
            </tbody>
          </table>
        </div>
        {profile.routes.length === 0 ? <p data-testid="release-no-routes">{t('llm.release.noRoutes')}</p> : null}
        {open(profile) && holds(PROFILE_PUBLISH) ? <DecisionForm profile={profile} runs={current} ready={ready} /> : null}
      </StateBoundary>
    </div>
  );
}

function RouteRow({ profile, route, runs, datasets, mayStart, maySign }: { profile: ProfileEntry; route: Route; runs: readonly RunEntry[]; datasets: readonly DatasetEntry[]; mayStart: boolean; maySign: boolean }) {
  const { t } = useTranslation();
  const { gate, run } = gateOfRoute(route, runs);
  const [signing, setSigning] = useState(false);
  return (
    <>
      <tr data-route={route} data-gate={gate}>
        <td>{routeLabel(t, route)}</td>
        <td>
          {gateLabel(t, gate)}
          {run === undefined ? null : <span className="sub"> · {runStatusLabel(t, run.status)}</span>}
        </td>
        <td>
          <Metrics run={run} />
        </td>
        <td>{run === undefined ? t('llm.release.noCost') : `${evalCost(run.costVnd)} ₫`}</td>
        <td>
          {run?.status === 'PENDING_SIGNATURE' && maySign ? (
            <button type="button" className="ui-button ui-button--outline ui-button--small" aria-expanded={signing} onClick={() => setSigning(!signing)}>
              {t('llm.release.sign')}
            </button>
          ) : null}
          {mayStart && (run === undefined || run.status !== 'PENDING_SIGNATURE') ? <StartForm profile={profile} route={route} datasets={datasets} /> : null}
        </td>
      </tr>
      {signing && run !== undefined ? (
        <tr data-sign-for={run.id}>
          <td colSpan={5}>
            <SignForm run={run} onDone={() => setSigning(false)} />
          </td>
        </tr>
      ) : null}
    </>
  );
}

function Metrics({ run }: { run: RunEntry | undefined }) {
  const { t } = useTranslation();
  if (run === undefined) return <span className="sub">{t('llm.release.noRun')}</span>;
  if (run.metrics === null) return <span className="sub">{t('llm.release.noMetrics')}</span>;
  return (
    <ul className="list-plain">
      {Object.entries(run.metrics).map(([name, value]) => (
        <li key={name} data-metric={name} data-failed={run.failures.includes(name) ? 'true' : 'false'}>
          {metricLabel(t, name)}: {value}
          {run.failures.includes(name) ? <strong> · {t('llm.release.metricFailed')}</strong> : null}
        </li>
      ))}
    </ul>
  );
}

function StartForm({ profile, route, datasets }: { profile: ProfileEntry; route: Route; datasets: readonly DatasetEntry[] }) {
  const { t } = useTranslation();
  const start = useStartEvalRun();
  const usable = datasets.filter((dataset) => dataset.taskType === profile.taskType && dataset.injectionCases > 0 && (route !== 'INTERNATIONAL' || dataset.maxClassification === 'PUBLIC'));
  const [datasetId, setDatasetId] = useState('');
  const refused = start.isError ? describeLlmProblem(start.error) : undefined;
  const send = (event: FormEvent): void => {
    event.preventDefault();
    if (start.isPending || datasetId === '') return;
    start.mutate({ profileId: profile.id, datasetId, route });
  };
  return (
    <form onSubmit={send} noValidate aria-label={t('llm.release.start.title', { route: routeLabel(t, route) })}>
      <label htmlFor={`start-${route}`}>{t('llm.release.start.dataset')}</label>
      <select id={`start-${route}`} value={datasetId} onChange={(event) => setDatasetId(event.target.value)}>
        <option value="">{t('llm.release.start.choose')}</option>
        {usable.map((dataset) => (
          <option key={dataset.id} value={dataset.id}>
            {dataset.code} #{dataset.revision}
          </option>
        ))}
      </select>
      {usable.length === 0 ? <p className="sub">{t('llm.release.start.none')}</p> : null}
      <button type="submit" className="ui-button ui-button--primary" disabled={start.isPending || datasetId === ''}>
        {t('llm.release.start.submit')}
      </button>
      {refused === undefined ? null : (
        <p className="callout warning" role="alert" data-testid="start-refused">
          {refusalMessage(t, refused.reason, refused.detail)}
        </p>
      )}
    </form>
  );
}

function SignForm({ run, onDone }: { run: RunEntry; onDone: () => void }) {
  const { t } = useTranslation();
  const sign = useSignEvalRun();
  const [decision, setDecision] = useState<'PASS' | 'FAIL'>(run.passed === true ? 'PASS' : 'FAIL');
  const [comment, setComment] = useState('');
  const [short, setShort] = useState(false);
  const refused = sign.isError ? describeLlmProblem(sign.error) : undefined;
  const send = (event: FormEvent): void => {
    event.preventDefault();
    if (sign.isPending) return;
    if (comment.trim().length < MIN_COMMENT) {
      setShort(true);
      return;
    }
    sign.mutate({ runId: run.id, version: run.version, decision, comment }, { onSuccess: onDone });
  };
  return (
    <form onSubmit={send} noValidate aria-label={t('llm.release.sign.title')}>
      <p className="sub">{t('llm.release.sign.hint')}</p>
      {refused === undefined ? null : (
        <p className="callout warning" role="alert" data-testid="sign-refused">
          {refusalMessage(t, refused.reason, refused.detail)}
        </p>
      )}
      <Field id={`sign-decision-${run.id}`} label={t('llm.release.sign.decision')} error={undefined}>
        <select id={`sign-decision-${run.id}`} value={decision} onChange={(event) => setDecision(event.target.value as 'PASS' | 'FAIL')}>
          <option value="PASS">{t('llm.release.sign.pass')}</option>
          <option value="FAIL">{t('llm.release.sign.fail')}</option>
        </select>
      </Field>
      <Field id={`sign-comment-${run.id}`} label={t('llm.release.sign.comment')} error={short ? t('llm.release.sign.short', { count: MIN_COMMENT }) : undefined}>
        <textarea
          id={`sign-comment-${run.id}`}
          rows={3}
          value={comment}
          maxLength={2000}
          onChange={(event) => {
            setComment(event.target.value);
            setShort(false);
          }}
        />
      </Field>
      <div className="mne-actions">
        <button type="submit" className="ui-button ui-button--primary" disabled={sign.isPending}>
          {t('llm.release.sign.submit')}
        </button>
      </div>
    </form>
  );
}

function DecisionForm({ profile, runs, ready }: { profile: ProfileEntry; runs: readonly RunEntry[]; ready: boolean }) {
  const { t } = useTranslation();
  const decide = useDecideProfile();
  const [reason, setReason] = useState('');
  const [short, setShort] = useState(false);
  const refused = decide.isError ? describeLlmProblem(decide.error) : undefined;
  // The evidence of a release is the signed passing run of each route; the server checks it again against what stands.
  const evidence = profile.routes.flatMap((route) => {
    const { gate, run } = gateOfRoute(route, runs);
    return gate === 'SIGNED_PASS' && run !== undefined ? [run.id] : [];
  });
  const submit = (decision: 'approve' | 'return'): void => {
    if (decide.isPending) return;
    if (reason.trim() === '') {
      setShort(true);
      return;
    }
    decide.mutate({ profileId: profile.id, version: profile.version, decision, reason, evidenceIds: decision === 'approve' ? evidence : [] });
  };
  const send = (event: FormEvent): void => {
    event.preventDefault();
    submit('approve');
  };
  return (
    <form className="card" onSubmit={send} noValidate aria-label={t('llm.release.decide.title')}>
      <h2>{t('llm.release.decide.title')}</h2>
      {ready ? null : (
        <p className="callout warning" data-testid="release-blocked">
          {t('llm.release.decide.blocked')}
        </p>
      )}
      {refused === undefined ? null : (
        <p className="callout warning" role="alert" data-testid="release-refused">
          {refusalMessage(t, refused.reason, refused.detail)}
        </p>
      )}
      {decide.isSuccess ? (
        <p className="callout" role="status" data-testid="release-done">
          {t('llm.release.decide.done')}
        </p>
      ) : null}
      <Field id="release-reason" label={t('llm.release.decide.reason')} error={short ? t('llm.problem.required') : undefined}>
        <textarea
          id="release-reason"
          rows={3}
          value={reason}
          maxLength={2000}
          onChange={(event) => {
            setReason(event.target.value);
            setShort(false);
          }}
        />
      </Field>
      <div className="mne-actions">
        <button type="submit" className="ui-button ui-button--primary" disabled={decide.isPending || !ready}>
          {t('llm.release.decide.publish')}
        </button>
        {profile.status === 'EVAL_PENDING' ? (
          <button type="button" className="ui-button ui-button--outline ui-button--small" disabled={decide.isPending} onClick={() => submit('return')}>
            {t('llm.release.decide.return')}
          </button>
        ) : null}
      </div>
    </form>
  );
}
