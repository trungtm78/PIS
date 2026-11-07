import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { Field } from '../mne/components';
import '../dis/dis.css';
import { BUILD_PERMISSION, MODEL_PATH, describeBuildProblem, periodProblem } from './dataset-model';
import { useBuildVersion, useDatasetVersions, useDatasets } from './hooks';
import { badgeLabel, buildProblemMessage, versionStatusLabel } from './labels';
import './bi-kit.css';

/**
 * BI-18: the datasets and the snapshots of their periods (ST-BI-002, BI 3 F2): for the dataset chosen, a version for each period: the snapshot of DIS it was made from, when it was built, the rows it has and the rows
 * that feed certified figures (less those the quality rules quarantined), its quality badge ("not assessed" until DGV has run, never "good") and its status. A version that a newer one replaced stays in the list:
 * a drill that was opened on it is served from it. Whoever may build can ask for the version of a period; asking again for the same content changes nothing.
 */
export default function DatasetVersionsScreen({ route }: ScreenProps) {
  const tenant = useSession().tenant;
  // What is open belongs to one member of one tenant: a switch starts the screen over.
  return <VersionsContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function VersionsContent({ route }: ScreenProps) {
  const { t, locale } = useTranslation();
  const { permissions, mode } = useSession();
  const mayBuild = (permissions === undefined || permissions.includes(BUILD_PERMISSION)) && mode !== 'READ_ONLY';
  const [params, setParams] = useSearchParams();
  const datasets = useDatasets();
  const asked = params.get('dataset') ?? '';
  const chosen = (datasets.data ?? []).find((dataset) => dataset.id === asked) ?? datasets.data?.[0];
  const versions = useDatasetVersions(chosen?.id);
  const state = useScreenState({ isLoading: datasets.isLoading || (chosen !== undefined && versions.isLoading), error: datasets.error ?? versions.error, data: datasets.data });
  const [period, setPeriod] = useState('');
  const [problem, setProblem] = useState<'required' | 'invalid' | undefined>(undefined);
  const build = useBuildVersion();
  const refused = build.isError ? describeBuildProblem(build.error) : undefined;
  const number = new Intl.NumberFormat(locale);

  const send = (event: FormEvent): void => {
    event.preventDefault();
    if (build.isPending || chosen === undefined) return;
    const found = periodProblem(period);
    setProblem(found);
    if (found === undefined) build.mutate({ datasetId: chosen.id, asOfPeriod: period });
  };

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('bi.versions.page.title')}</h1>
          <p>{t('bi.versions.page.subtitle')}</p>
        </div>
        <Link className="ui-button ui-button--outline" to={MODEL_PATH}>
          {t('bi.versions.back')}
        </Link>
      </div>
      <StateBoundary state={state} onRetry={() => { void datasets.refetch(); void versions.refetch(); }}>
        <div className="card">
          <Field id="dataset-choice" label={t('bi.versions.dataset')} error={undefined}>
            <select id="dataset-choice" value={chosen?.id ?? ''} onChange={(event) => setParams({ dataset: event.target.value }, { replace: true })}>
              {(datasets.data ?? []).map((dataset) => (
                <option key={dataset.id} value={dataset.id}>
                  {dataset.title} ({dataset.code})
                </option>
              ))}
            </select>
          </Field>
        </div>
        {mayBuild && chosen !== undefined ? (
          <form className="card" onSubmit={send} noValidate aria-label={t('bi.versions.build.title')}>
            <h2>{t('bi.versions.build.title')}</h2>
            {refused === undefined ? null : (
              <p className="callout warning" role="alert" data-testid="build-refused">
                {buildProblemMessage(t, refused)}
              </p>
            )}
            {build.isSuccess ? (
              <p className="callout" role="status" data-testid="build-done">
                {(build.data as { outcome?: string }).outcome === 'UNCHANGED' ? t('bi.versions.build.unchanged') : t('bi.versions.build.built')}
              </p>
            ) : null}
            <Field id="build-period" label={t('bi.versions.build.period')} error={problem === undefined ? undefined : problem === 'required' ? t('bi.metric.problem.required') : t('bi.versions.build.invalid')} hint={t('bi.versions.build.hint')}>
              <input id="build-period" value={period} aria-invalid={problem !== undefined} onChange={(event) => { setPeriod(event.target.value); setProblem(undefined); }} />
            </Field>
            <div className="mne-actions">
              <button type="submit" className="ui-button ui-button--primary" disabled={build.isPending}>
                {t('bi.versions.build.action')}
              </button>
            </div>
          </form>
        ) : null}
        <table className="table" data-testid="versions-table" aria-label={t('bi.versions.table.aria')}>
          <thead>
            <tr>
              <th scope="col">{t('bi.versions.column.dataset')}</th>
              <th scope="col">{t('bi.versions.column.period')}</th>
              <th scope="col">{t('bi.versions.column.snapshot')}</th>
              <th scope="col">{t('bi.versions.column.builtAt')}</th>
              <th scope="col">{t('bi.versions.column.rows')}</th>
              <th scope="col">{t('bi.versions.column.quality')}</th>
              <th scope="col">{t('bi.versions.column.status')}</th>
            </tr>
          </thead>
          <tbody>
            {(versions.data ?? []).map((version) => (
              <tr key={version.id} data-version-id={version.id} data-status={version.status}>
                <td>{chosen?.code}</td>
                <td>{version.asOfPeriod}</td>
                <td>{version.sourceSnapshotId === null ? t('bi.versions.none') : version.sourceSnapshotId.slice(0, 8)}</td>
                <td>{version.builtAt}</td>
                <td data-testid={`rows-${version.id}`}>
                  {t('bi.versions.rows', { rows: number.format(version.rowCount), certified: number.format(version.certifiedRowCountMin) })}
                  {version.excludedQuarantineRows > 0 ? <span className="sub"> {t('bi.versions.excluded', { rows: number.format(version.excludedQuarantineRows) })}</span> : null}
                </td>
                <td data-testid={`badge-${version.id}`} data-badge={version.badge}>
                  {badgeLabel(t, version.badge)}
                  {version.feedsCertified ? null : <span className="sub"> {t('bi.versions.notCertified')}</span>}
                </td>
                <td>{versionStatusLabel(t, version.status)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {(versions.data ?? []).length === 0 ? <p data-testid="versions-none">{t('bi.versions.noVersions')}</p> : null}
      </StateBoundary>
    </section>
  );
}
