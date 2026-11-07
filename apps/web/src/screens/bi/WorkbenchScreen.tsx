import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { ContextBar, SectionCard, StatusPill } from '../../ui';
import { Field } from '../mne/components';
import '../dis/dis.css';
import { useDatasetVersions, useDatasets, useExplain, useMetrics, useRefreshContext, useRunQuery } from './hooks';
import { dimensionLabel, queryProblemMessage } from './labels';
import { DIMENSIONS, describeQueryProblem } from './query-model';
import type { Group, QueryResult } from './query-model';
import { GroupTable, Reconciliation, ResultLabels } from './QueryResultView';
import './bi-kit.css';

interface Level {
  result: QueryResult;
  /** The label of the group this level was opened from. */
  from: string | null;
}

/**
 * BI-09: the analysis workbench (ST-BI-004, BI F3 and F4): a certified metric over the snapshot of a period, cut by a dimension, then down through the groups to the next dimension. Every level keeps the snapshot of the
 * first (a newer one only raises a banner that renews the data on a click), says the period, the quality of the data, whether it came from the cache and whose scope it is, and says whether the groups add up to the
 * level above or why they cannot. A group that has no value in the dimension is shown as Unclassified; a figure that cannot be given is "no data", never 0.
 */
export default function WorkbenchScreen({ route }: ScreenProps) {
  const tenant = useSession().tenant;
  // What is open belongs to one member of one tenant: a switch starts the screen over.
  return <WorkbenchContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function WorkbenchContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { tenant } = useSession();
  const [params] = useSearchParams();
  const metrics = useMetrics();
  const datasets = useDatasets();
  const disbursement = (datasets.data ?? []).find((dataset) => dataset.sourceKind === 'PERIOD_SNAPSHOT');
  const versions = useDatasetVersions(disbursement?.id);
  const certified = useMemo(() => (metrics.data ?? []).filter((metric) => metric.status === 'CERTIFIED'), [metrics.data]);
  const served = useMemo(() => (versions.data ?? []).filter((version) => version.status === 'FROZEN' || version.status === 'SUPERSEDED'), [versions.data]);
  const [metricId, setMetricId] = useState(params.get('metric') ?? '');
  const [snapshotId, setSnapshotId] = useState(params.get('snapshot') ?? '');
  const [dimension, setDimension] = useState<string>('unit');
  const [levels, setLevels] = useState<Level[]>([]);
  const [nextDimension, setNextDimension] = useState('');
  const run = useRunQuery();
  const explain = useExplain();
  const refresh = useRefreshContext();
  const state = useScreenState({ isLoading: metrics.isLoading || datasets.isLoading || (disbursement !== undefined && versions.isLoading), error: metrics.error ?? datasets.error ?? versions.error, data: metrics.data === undefined ? undefined : certified });
  const chosenMetric = metricId !== '' ? metricId : (certified[0]?.id ?? '');
  const chosenSnapshot = snapshotId !== '' ? snapshotId : (served.find((version) => version.status === 'FROZEN')?.id ?? served[0]?.id ?? '');
  const current = levels.at(-1);
  const freeDimensions = DIMENSIONS.filter((candidate) => !levels.some((level) => level.result.dimension === candidate));
  const busy = run.isPending || explain.isPending || refresh.isPending;
  const failed = run.error ?? explain.error ?? refresh.error;
  const problem = failed === null || failed === undefined ? undefined : describeQueryProblem(failed);

  const start = (snapshot: string = chosenSnapshot): void => {
    if (chosenMetric === '' || snapshot === '') return;
    explain.reset();
    refresh.reset();
    run.mutate({ metricId: chosenMetric, snapshotId: snapshot, dimension }, { onSuccess: (result) => result !== undefined && setLevels([{ result, from: null }]) });
  };
  const down = (group: Group): void => {
    const level = current;
    if (level === undefined || group.drillToken === null) return;
    const child = freeDimensions.includes(nextDimension as never) ? nextDimension : freeDimensions[0];
    if (child === undefined) return;
    run.reset();
    refresh.reset();
    // The answer belongs to the level it was asked from: if the path is another by the time it comes (the reader went back up), it is dropped and not put under a path it does not belong to.
    const origin = levels.length;
    explain.mutate({ token: group.drillToken, dimension: child }, { onSuccess: (result) => result !== undefined && setLevels((previous) => (previous.length === origin ? [...previous, { result, from: group.label }] : previous)) });
  };
  // The newer data: the context is renewed on the newest snapshot of the period, and the first level is asked again on it.
  const renew = (): void => {
    const first = levels[0];
    if (first === undefined) return;
    run.reset();
    explain.reset();
    refresh.mutate(first.result.drillToken, {
      onSuccess: (renewed) => {
        if (renewed.snapshotId === undefined) return;
        setSnapshotId(renewed.snapshotId);
        // The metric and the dimension are those of the analysis that is open (not those the form shows now), and the renewed context goes with the query: a metric that a newer revision replaced goes on.
        run.mutate(
          { metricId: first.result.metricId, snapshotId: renewed.snapshotId, dimension: first.result.dimension ?? undefined, contextToken: renewed.token },
          { onSuccess: (result) => result !== undefined && setLevels([{ result, from: null }]) },
        );
      },
    });
  };

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('bi.workbench.page.title')}</h1>
          <p>{t('bi.workbench.page.subtitle')}</p>
        </div>
      </div>
      <ContextBar
        items={[
          { label: t('bi.workbench.ctx.scope'), value: tenant?.name ?? t('bi.workbench.ctx.scope.all') },
          { label: t('bi.workbench.ctx.period'), value: served.find((version) => version.id === chosenSnapshot)?.asOfPeriod ?? t('bi.workbench.ctx.none') },
          { label: t('bi.workbench.ctx.snapshot'), value: chosenSnapshot === '' ? t('bi.workbench.ctx.none') : chosenSnapshot.slice(0, 8) },
        ]}
      />
      <StateBoundary
        state={state}
        onRetry={() => {
          void metrics.refetch();
          void datasets.refetch();
          void versions.refetch();
        }}
      >
        <SectionCard title={t('bi.workbench.form.title')}>
        <form
          aria-label={t('bi.workbench.form.title')}
          onSubmit={(event) => {
            event.preventDefault();
            start();
          }}
        >
          <div className="mne-filters">
            <Field id="wb-metric" label={t('bi.workbench.metric')} error={undefined}>
              <select id="wb-metric" value={chosenMetric} onChange={(event) => setMetricId(event.target.value)}>
                {certified.map((metric) => (
                  <option key={metric.id} value={metric.id}>
                    {metric.code}
                  </option>
                ))}
              </select>
            </Field>
            <Field id="wb-snapshot" label={t('bi.workbench.snapshot')} error={undefined}>
              <select id="wb-snapshot" value={chosenSnapshot} onChange={(event) => setSnapshotId(event.target.value)}>
                {served.map((version) => (
                  <option key={version.id} value={version.id}>
                    {version.asOfPeriod} · {version.id.slice(0, 8)}
                  </option>
                ))}
              </select>
            </Field>
            <Field id="wb-dimension" label={t('bi.workbench.dimension')} error={undefined}>
              <select id="wb-dimension" value={dimension} onChange={(event) => setDimension(event.target.value)}>
                {DIMENSIONS.map((candidate) => (
                  <option key={candidate} value={candidate}>
                    {dimensionLabel(t, candidate)}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <div className="mne-actions">
            <button type="submit" className="ui-button ui-button--primary" disabled={busy || chosenMetric === '' || chosenSnapshot === ''}>
              {t('bi.workbench.run')}
            </button>
          </div>
        </form>
        </SectionCard>
        {problem === undefined ? null : (
          <p className="callout warning" role="alert" data-testid="query-refused" data-reason={problem.reason}>
            {queryProblemMessage(t, problem.reason, problem.field)}
            {problem.reason === 'expired' || problem.reason === 'token' ? (
              <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={renew} disabled={busy || levels.length === 0}>
                {t('bi.workbench.renew')}
              </button>
            ) : null}
          </p>
        )}
        {current === undefined ? (
          <p className="sub" data-testid="workbench-empty">
            {t('bi.workbench.empty')}
          </p>
        ) : (
          <div data-testid="workbench-result" className="bi-result">
          <SectionCard title={current.result.metricCode}>
            <nav aria-label={t('bi.workbench.path')} data-testid="breadcrumb">
              <ol className="mne-lines">
                {levels.map((level, index) => (
                  <li key={`${level.result.dimension}-${index}`}>
                    <button type="button" className="ui-button ui-button--outline ui-button--small" disabled={busy || index === levels.length - 1} onClick={() => setLevels(levels.slice(0, index + 1))}>
                      {level.from === null ? dimensionLabel(t, level.result.dimension ?? '') : `${level.from} › ${dimensionLabel(t, level.result.dimension ?? '')}`}
                    </button>
                  </li>
                ))}
              </ol>
            </nav>
            {current.result.newDataAvailable ? (
              <p className="callout" role="status" data-testid="new-data-banner">
                {t('bi.workbench.newData')}{' '}
                <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={renew} disabled={busy}>
                  {t('bi.workbench.renew')}
                </button>
              </p>
            ) : null}
            <ResultLabels result={current.result} />
            <GroupTable result={current.result} onDrill={freeDimensions.length === 0 ? undefined : down} />
            {freeDimensions.length > 1 ? (
              <Field id="wb-next" label={t('bi.workbench.nextDimension')} error={undefined}>
                <select id="wb-next" value={freeDimensions.includes(nextDimension as never) ? nextDimension : freeDimensions[0]} onChange={(event) => setNextDimension(event.target.value)}>
                  {freeDimensions.map((candidate) => (
                    <option key={candidate} value={candidate}>
                      {dimensionLabel(t, candidate)}
                    </option>
                  ))}
                </select>
              </Field>
            ) : null}
            <Reconciliation result={current.result} />
            {current.result.truncated ? (
              <p data-testid="truncated">
                <StatusPill tone="warning">{t('bi.query.truncated')}</StatusPill>
              </p>
            ) : null}
          </SectionCard>
          </div>
        )}
      </StateBoundary>
    </section>
  );
}
