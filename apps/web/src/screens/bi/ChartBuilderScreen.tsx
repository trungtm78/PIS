import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { ContextBar, SectionCard, StatusPill } from '../../ui';
import { Field } from '../mne/components';
import '../dis/dis.css';
import { ChartView } from './ChartView';
import { kindLabel } from './dashboard-labels';
import { BUILDER_PATH, WIDGET_KINDS } from './dashboard-model';
import type { WidgetKind } from './dashboard-model';
import { useDatasetVersions, useDatasets, useMetrics, useRunQuery } from './hooks';
import { dimensionLabel, queryProblemMessage } from './labels';
import { DIMENSIONS, describeQueryProblem } from './query-model';
import type { QueryResult } from './query-model';
import { GroupTable, ResultLabels } from './QueryResultView';
import './bi-kit.css';

/**
 * BI-04: the builder of a chart (ST-BI-005, BI F3, UAT-AC32): a certified metric over a frozen version of the dataset, cut by a dimension and drawn as bars, a line, an area, a pie or a figure. A ratio is the
 * sum of its numerator over the sum of its denominator, as the server gives it; the period and the snapshot are written on the chart, and the table of the same figures stays next to it. The chart is handed on
 * to the builder of a dashboard (BI-03) as a tile.
 */
export default function ChartBuilderScreen({ route }: ScreenProps) {
  const tenant = useSession().tenant;
  // What is open belongs to one member of one tenant: a switch starts the screen over.
  return <ChartContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function ChartContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const { tenant } = useSession();
  const metrics = useMetrics();
  const datasets = useDatasets();
  const disbursement = (datasets.data ?? []).find((dataset) => dataset.sourceKind === 'PERIOD_SNAPSHOT');
  const versions = useDatasetVersions(disbursement?.id);
  const certified = useMemo(() => (metrics.data ?? []).filter((metric) => metric.status === 'CERTIFIED'), [metrics.data]);
  const frozen = useMemo(() => (versions.data ?? []).filter((version) => version.status === 'FROZEN'), [versions.data]);
  const [metricId, setMetricId] = useState('');
  const [snapshotId, setSnapshotId] = useState('');
  const [dimension, setDimension] = useState<string>('unit');
  const [kind, setKind] = useState<WidgetKind>('BAR');
  const [shown, setShown] = useState<{ result: QueryResult; kind: WidgetKind } | undefined>(undefined);
  const run = useRunQuery();
  const state = useScreenState({ isLoading: metrics.isLoading || datasets.isLoading || (disbursement !== undefined && versions.isLoading), error: metrics.error ?? datasets.error ?? versions.error, data: metrics.data });
  const chosenMetric = metricId !== '' ? metricId : (certified[0]?.id ?? '');
  const chosenSnapshot = snapshotId !== '' ? snapshotId : (frozen[0]?.id ?? '');
  const problem = run.error === null ? undefined : describeQueryProblem(run.error);
  const draw = (): void => {
    if (chosenMetric === '' || chosenSnapshot === '') return;
    run.mutate(
      { metricId: chosenMetric, snapshotId: chosenSnapshot, ...(kind === 'KPI' ? {} : { dimension }) },
      { onSuccess: (result) => result !== undefined && setShown({ result, kind }) },
    );
  };

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <p className="back-link">
        <Link to={BUILDER_PATH}>
          <span aria-hidden="true">← </span>
          {t('bi.chart.back.link')}
        </Link>
      </p>
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('bi.chart.page.title')}</h1>
          <p>{t('bi.chart.page.subtitle')}</p>
        </div>
      </div>
      <ContextBar
        items={[
          { label: t('bi.chart.ctx.scope'), value: tenant?.name ?? t('bi.chart.ctx.scope.all') },
          { label: t('bi.chart.ctx.period'), value: frozen.find((version) => version.id === chosenSnapshot)?.asOfPeriod ?? t('bi.chart.ctx.none') },
          { label: t('bi.chart.ctx.snapshot'), value: chosenSnapshot === '' ? t('bi.chart.ctx.none') : chosenSnapshot.slice(0, 8) },
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
        <SectionCard title={t('bi.chart.form.title')}>
        <form
          aria-label={t('bi.chart.form.title')}
          onSubmit={(event) => {
            event.preventDefault();
            draw();
          }}
        >
          <div className="mne-filters">
            <Field id="chart-metric" label={t('bi.chart.metric')} error={undefined}>
              <select id="chart-metric" value={chosenMetric} onChange={(event) => setMetricId(event.target.value)}>
                {certified.map((metric) => (
                  <option key={metric.id} value={metric.id}>
                    {metric.code}
                  </option>
                ))}
              </select>
            </Field>
            <Field id="chart-snapshot" label={t('bi.chart.snapshot')} error={undefined}>
              <select id="chart-snapshot" value={chosenSnapshot} onChange={(event) => setSnapshotId(event.target.value)}>
                {frozen.map((version) => (
                  <option key={version.id} value={version.id}>
                    {version.asOfPeriod} · {version.id.slice(0, 8)}
                  </option>
                ))}
              </select>
            </Field>
            <Field id="chart-kind" label={t('bi.chart.kind')} error={undefined}>
              <select id="chart-kind" value={kind} onChange={(event) => setKind(event.target.value as WidgetKind)}>
                {WIDGET_KINDS.map((candidate) => (
                  <option key={candidate} value={candidate}>
                    {kindLabel(t, candidate)}
                  </option>
                ))}
              </select>
            </Field>
            <Field id="chart-dimension" label={t('bi.chart.dimension')} error={undefined}>
              <select id="chart-dimension" value={dimension} disabled={kind === 'KPI'} onChange={(event) => setDimension(event.target.value)}>
                {DIMENSIONS.map((candidate) => (
                  <option key={candidate} value={candidate}>
                    {dimensionLabel(t, candidate)}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <div className="formfooter">
            <button type="submit" className="ui-button ui-button--primary" disabled={run.isPending || chosenMetric === '' || chosenSnapshot === ''}>
              {t('bi.chart.draw')}
            </button>
          </div>
          {chosenSnapshot === '' ? <p data-testid="chart-no-period">{t('bi.board.noPeriod')}</p> : null}
        </form>
        </SectionCard>
        {problem === undefined ? null : (
          <p className="callout warning" role="alert" data-testid="chart-problem" data-reason={problem.reason}>
            {queryProblemMessage(t, problem.reason, problem.field)}
          </p>
        )}
        {shown === undefined ? null : (
          <div data-testid="chart-result" className="bi-result">
          <SectionCard title={t('bi.chart.result', { code: shown.result.metricCode })}>
            {shown.result.truncated ? (
              <p data-testid="truncated">
                <StatusPill tone="warning">{t('bi.query.truncated')}</StatusPill>
              </p>
            ) : null}
            {shown.kind === 'TABLE' ? null : <ChartView kind={shown.kind} result={shown.result} />}
            <ResultLabels result={shown.result} />
            <GroupTable result={shown.result} />
            <Link to={`${BUILDER_PATH}?metric=${shown.result.metricId}&kind=${shown.kind}${shown.result.dimension === null ? '' : `&dimension=${shown.result.dimension}`}`}>{t('bi.chart.toDashboard')}</Link>
          </SectionCard>
          </div>
        )}
      </StateBoundary>
      <p className="prototype-note">{t('bi.dash.footer.reference', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}
