import { useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { Field } from '../mne/components';
import '../dis/dis.css';
import { DEPTHS, DIRECTIONS, describeLineageProblem, levelsOf } from '../dgv/lineage/model';
import type { Direction, LineageNode } from '../dgv/lineage/model';
import { directionLabel, kindLabel, reasonMessage } from '../dgv/lineage/labels';
import { useMetricLineage, useMetrics } from './hooks';
import { EMPTY_LINEAGE_QUERY, lineageNeedsMetric } from './metric-lineage-model';
import type { MetricLineage, MetricLineageQuery } from './metric-lineage-model';
import './bi-kit.css';
import { StatusPill } from '../../ui';

/**
 * BI-14: where the figures of a metric come from (ST-BI-009, BI F5): the version of the metric, the version of the dataset it was read over, the snapshot of DIS and the projects it is made of, level by level, each step with the
 * transform that made it and the quality of the version of the dataset on the way. A node the person may not see is shown as restricted and nothing more: no name, no id and no kind.
 */
export default function MetricLineageScreen({ route }: ScreenProps) {
  const tenant = useSession().tenant;
  // What is open belongs to one member of one tenant: a switch starts the screen over.
  return <LineageContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function LineageContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const metrics = useMetrics();
  const [form, setForm] = useState<MetricLineageQuery>(EMPTY_LINEAGE_QUERY);
  const [asked, setAsked] = useState<MetricLineageQuery | undefined>(undefined);
  const [attempted, setAttempted] = useState(false);
  const lineage = useMetricLineage(asked);
  const chosen = { ...form, metricId: form.metricId !== '' ? form.metricId : (metrics.data?.[0]?.id ?? '') };
  const missing = attempted && lineageNeedsMetric(chosen);

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setAttempted(true);
    if (lineageNeedsMetric(chosen)) return;
    // The same question again is asked of the server again (a failure is tried once more, a graph is read after new lineage was recorded).
    if (asked !== undefined && asked.metricId === chosen.metricId && asked.direction === chosen.direction && asked.depth === chosen.depth) void lineage.refetch();
    else setAsked({ ...chosen });
  };

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('bi.lin.title')}</h1>
          <p>{t('bi.lin.subtitle')}</p>
        </div>
      </div>
      <form className="card" onSubmit={submit} noValidate aria-label={t('bi.lin.form.title')}>
        <Field id="bilin-metric" label={t('bi.lin.metric')} error={missing ? t('bi.lin.metric.required') : undefined}>
          <select id="bilin-metric" value={chosen.metricId} aria-invalid={missing} onChange={(event) => setForm({ ...form, metricId: event.target.value })}>
            {(metrics.data ?? []).map((metric) => (
              <option key={metric.id} value={metric.id}>
                {metric.code} · {metric.revision}
              </option>
            ))}
          </select>
        </Field>
        <Field id="bilin-direction" label={t('dgv.lin.direction')} error={undefined}>
          <select id="bilin-direction" value={form.direction} onChange={(event) => setForm({ ...form, direction: event.target.value as Direction })}>
            {DIRECTIONS.map((candidate) => (
              <option key={candidate} value={candidate}>
                {directionLabel(t, candidate)}
              </option>
            ))}
          </select>
        </Field>
        <Field id="bilin-depth" label={t('dgv.lin.depth')} error={undefined}>
          <select id="bilin-depth" value={form.depth} onChange={(event) => setForm({ ...form, depth: Number(event.target.value) })}>
            {DEPTHS.map((candidate) => (
              <option key={candidate} value={candidate}>
                {candidate}
              </option>
            ))}
          </select>
        </Field>
        <div className="formfooter">
          <button type="submit" className="ui-button ui-button--primary" disabled={lineage.isFetching}>
            {t('bi.lin.submit')}
          </button>
        </div>
      </form>
      {asked === undefined ? (
        <p className="card" data-testid="ask-first">
          {t('bi.lin.choose')}
        </p>
      ) : lineage.isFetching ? (
        <div className="card" role="status" aria-busy="true" aria-label={t('states.loading.label')} />
      ) : lineage.isError ? (
        <p className="callout warning" role="alert" data-testid="failed" data-reason={describeLineageProblem(lineage.error)}>
          {reasonMessage(t, describeLineageProblem(lineage.error))}
        </p>
      ) : lineage.data === undefined ? null : (
        <Graph lineage={lineage.data} />
      )}
      <p className="prototype-note">{t('bi.lin.footer', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

function Graph({ lineage }: { lineage: MetricLineage }) {
  const { t } = useTranslation();
  const { graph } = lineage;
  if (graph.nodes.length === 0) {
    return (
      <p className="card" data-testid="empty">
        {t('bi.lin.empty')}
      </p>
    );
  }
  const names = new Map(graph.nodes.map((node) => [node.key, node.restricted ? t('dgv.lin.restricted') : (node.name ?? node.key)]));
  return (
    <>
      {graph.truncated ? (
        <p className="callout warning" data-testid="truncated">
          {t('dgv.lin.truncated')}
        </p>
      ) : null}
      <ol className="card" data-testid="levels" aria-label={t('dgv.lin.levels')}>
        {levelsOf(graph).map(({ level, nodes }) => (
          <li key={level} data-level={level}>
            <h2>{level === 0 ? t('dgv.lin.level.start') : t('dgv.lin.level.step', { level })}</h2>
            <ul>
              {nodes.map((node) => (
                <NodeLine key={node.key} node={node} quality={lineage.quality.get(node.key)} />
              ))}
            </ul>
          </li>
        ))}
      </ol>
      <table className="table" data-testid="edges" aria-label={t('dgv.lin.edges')}>
        <thead>
          <tr>
            <th scope="col">{t('dgv.lin.edge.from')}</th>
            <th scope="col">{t('dgv.lin.edge.to')}</th>
            <th scope="col">{t('dgv.lin.edge.run')}</th>
            <th scope="col">{t('dgv.lin.edge.transform')}</th>
          </tr>
        </thead>
        <tbody>
          {graph.edges.map((edge, index) => (
            // A step that touches a restricted node says nothing of its transform, so parallel steps of two nodes only differ by their place in the answer.
            <tr key={`${index}:${edge.from}>${edge.to}`} data-restricted={edge.runId === null}>
              <td>{names.get(edge.from)}</td>
              <td>{names.get(edge.to)}</td>
              <td>{edge.runId ?? t('dgv.lin.none')}</td>
              <td>{edge.transformVersion ?? t('dgv.lin.none')}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

function NodeLine({ node, quality }: { node: LineageNode; quality: { badge: string; excludedRows: number } | undefined }) {
  const { t } = useTranslation();
  if (node.restricted) {
    return (
      <li data-restricted="true" data-node={node.key}>
        <StatusPill tone="neutral">{t('dgv.lin.restricted')}</StatusPill>
      </li>
    );
  }
  return (
    <li data-node={node.key} data-kind={node.kind ?? ''}>
      <StatusPill tone="neutral">{node.kind === null ? '' : kindLabel(t, node.kind)}</StatusPill> <strong>{node.name}</strong>
      <span className="sub">
        {' '}
        · {node.module} · {node.refId ?? node.refKey}
      </span>
      {quality === undefined ? null : (
        <span className="sub" data-testid="quality">
          {' '}
          · {t('bi.lin.quality', { badge: quality.badge, rows: quality.excludedRows })}
        </span>
      )}
    </li>
  );
}
