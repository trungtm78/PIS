import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { Field } from '../../mne/components';
import { metricLabel, runStatusLabel } from '../eval-labels';
import { RELEASE_PATH, evalCost } from '../eval-model';
import type { ProfileEntry } from '../eval-model';
import { useDatasets, useProfiles } from '../hooks';
import { routeLabel } from '../labels';
import { vietnamDay } from '../llm-model';
import { useCompareRuns } from './hooks';
import { DATASET_READ_PERMISSION, METRICS, PROFILE_READ_PERMISSION, RUN_READ_PERMISSION, durationSeconds, groupByRoute, metricCell } from './model';
import type { CompareRun, RouteGroup } from './model';
import '../llm-kit.css';

const holds = (permissions: readonly string[] | undefined, permission: string): boolean => permissions === undefined || permissions.includes(permission);

/**
 * LLM-13: the evaluations of models side by side (ST-LLM-009, LLM F4, UAT-AC459): the runs of one version of one dataset, route by route, with each metric against the threshold it was judged by, what failed, the cost, how long
 * the run took, and whether an expert signed it as passed or failed. Runs are compared only on the same version of the same dataset; a run that was set aside by a newer one is left out. A comparison is not a release: the
 * release of a profile is LLM-17.
 */
export default function CompareScreen({ route }: ScreenProps) {
  const tenant = useSession().tenant;
  // What is chosen belongs to one member of one tenant: a switch starts the screen over.
  return <CompareContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function CompareContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { permissions } = useSession();
  const allowed = [RUN_READ_PERMISSION, PROFILE_READ_PERMISSION, DATASET_READ_PERMISSION].every((permission) => holds(permissions, permission));
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('llm.compare.page.title')}</h1>
          <p>{t('llm.compare.page.subtitle')}</p>
        </div>
      </div>
      {allowed ? (
        <Compare />
      ) : (
        <div data-testid="compare-denied">
          <StateBoundary state="denied" />
        </div>
      )}
      <p className="prototype-note">{t('llm.compare.footer', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

function Compare() {
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  const datasets = useDatasets();
  const runs = useCompareRuns();
  const profiles = useProfiles();
  const state = useScreenState({
    isLoading: datasets.isLoading || runs.isLoading || profiles.isLoading,
    error: datasets.error ?? runs.error ?? profiles.error,
    data: datasets.data === undefined || runs.data === undefined || profiles.data === undefined ? undefined : datasets.data,
  });
  const asked = params.get('dataset') ?? '';
  const chosen = (datasets.data ?? []).find((dataset) => dataset.id === asked);
  const retry = (): void => {
    void datasets.refetch();
    void runs.refetch();
    void profiles.refetch();
  };
  return (
    <StateBoundary state={state} onRetry={retry}>
      <div className="card">
        <Field id="compare-dataset" label={t('llm.compare.dataset.label')} hint={t('llm.compare.dataset.hint')} error={undefined}>
          <select
            id="compare-dataset"
            value={chosen === undefined ? '' : chosen.id}
            onChange={(event) => setParams(event.target.value === '' ? {} : { dataset: event.target.value }, { replace: true })}
          >
            <option value="">{t('llm.compare.dataset.none')}</option>
            {(datasets.data ?? []).map((dataset) => (
              <option key={dataset.id} value={dataset.id}>
                {t('llm.compare.dataset.option', { code: dataset.code, revision: dataset.revision, task: dataset.taskType })}
              </option>
            ))}
          </select>
        </Field>
      </div>
      {asked !== '' && chosen === undefined ? (
        <p className="callout warning" role="alert" data-testid="compare-unknown">
          {t('llm.compare.unknown.notice')}
        </p>
      ) : null}
      {chosen === undefined ? <p data-testid="compare-pick">{t('llm.compare.pick.notice')}</p> : <Groups groups={groupByRoute(runs.data ?? [], chosen.id)} profiles={profiles.data ?? []} />}
    </StateBoundary>
  );
}

function Groups({ groups, profiles }: { groups: RouteGroup[]; profiles: readonly ProfileEntry[] }) {
  const { t } = useTranslation();
  if (groups.length === 0) return <p data-testid="compare-none">{t('llm.compare.none.notice')}</p>;
  return (
    <>
      {groups.map((group) => (
        <section key={group.route} className="card" aria-label={routeLabel(t, group.route)} data-route={group.route}>
          <h2>{routeLabel(t, group.route)}</h2>
          {group.runs.length < 2 ? (
            <p className="sub" data-testid="compare-single">
              {t('llm.compare.single.notice')}
            </p>
          ) : null}
          <div className="tablewrap">
            <table className="table" aria-label={t('llm.compare.table.aria', { route: routeLabel(t, group.route) })}>
              <thead>
                <tr>
                  <th scope="col">{t('llm.compare.column.model')}</th>
                  {METRICS.map(({ metric }) => (
                    <th key={metric} scope="col">
                      {metricLabel(t, metric)}
                    </th>
                  ))}
                  <th scope="col">{t('llm.compare.column.cost')}</th>
                  <th scope="col">{t('llm.compare.column.duration')}</th>
                  <th scope="col">{t('llm.compare.column.signature')}</th>
                </tr>
              </thead>
              <tbody>
                {group.runs.map((run) => (
                  <Row key={run.id} run={run} profile={profiles.find((entry) => entry.id === run.profileId)} />
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}
    </>
  );
}

function Row({ run, profile }: { run: CompareRun; profile: ProfileEntry | undefined }) {
  const { t } = useTranslation();
  const seconds = durationSeconds(run);
  return (
    <tr data-run-id={run.id} data-status={run.status}>
      <th scope="row">
        {profile === undefined ? run.profileId.slice(0, 8) : profile.modelId}
        {profile === undefined ? null : <span className="sub"> {t('llm.compare.profile.text', { task: profile.taskType, revision: profile.revision })}</span>}
        <br />
        <Link to={`${RELEASE_PATH}?profile=${run.profileId}`}>{t('llm.compare.release.link')}</Link>
      </th>
      {METRICS.map(({ metric, bound }) => {
        const cell = metricCell(run, metric, bound);
        return (
          <td key={metric} data-metric={metric} data-failed={cell.failed}>
            {cell.value === null ? '—' : cell.value}
            {cell.threshold === null ? null : (
              <span className="sub"> {bound === 'min' ? t('llm.compare.threshold.min', { value: cell.threshold }) : t('llm.compare.threshold.max', { value: cell.threshold })}</span>
            )}
            {cell.failed ? <span className="aud-badge warning"> {t('llm.compare.metric.failed')}</span> : null}
          </td>
        );
      })}
      <td>{evalCost(run.costVnd)} ₫</td>
      <td>{seconds === null ? '—' : t('llm.compare.duration.seconds', { value: seconds })}</td>
      <td>
        {runStatusLabel(t, run.status)}
        {run.signedBy === null ? null : <span className="sub"> {t('llm.compare.signed.text', { by: run.signedBy.slice(0, 8), day: run.signedAt === null ? '' : vietnamDay(run.signedAt) })}</span>}
        {run.signatureComment === null ? null : <p className="sub">{run.signatureComment}</p>}
      </td>
    </tr>
  );
}
