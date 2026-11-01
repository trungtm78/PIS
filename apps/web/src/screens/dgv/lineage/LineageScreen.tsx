import { useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { Field } from '../components';
import '../dgv.css';
import { useLineage } from './hooks';
import { directionLabel, kindLabel, queryProblemMessage, reasonMessage } from './labels';
import { DEPTHS, DIRECTIONS, EMPTY_QUERY, NODE_KINDS, describeLineageProblem, levelsOf, sameQuery, validateQuery } from './model';
import type { Direction, LineageNode, LineageQuery, NodeKind } from './model';

/**
 * DGV-05: the lineage of a node (ST-DGV-006, DGV F5): where a figure comes from (up) or what is made of it (down), level by level, each step with the run that saw it and the version of the transform. A node the person may not
 * see is a restricted node: it has its place in the graph and no name, no id and no kind, and the steps that touch it say nothing of their run.
 */
export default function LineageScreen({ route }: ScreenProps) {
  const tenant = useSession().tenant;
  // What is open belongs to one member of one tenant: a switch starts the screen over.
  return <LineageContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function LineageContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const [form, setForm] = useState<LineageQuery>(EMPTY_QUERY);
  const [asked, setAsked] = useState<LineageQuery | undefined>(undefined);
  const [attempted, setAttempted] = useState(false);
  const graph = useLineage(asked);
  const problems = attempted ? validateQuery(form) : {};
  const names = new Map((graph.data?.nodes ?? []).map((node) => [node.key, node.restricted ? t('dgv.lin.restricted') : (node.name ?? node.key)]));

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setAttempted(true);
    if (validateQuery(form).refId !== undefined) return;
    // The same question again is asked of the server again (a failure is tried once more, a graph is read after new lineage was recorded): the key of the query does not change, so it is refetched.
    if (asked !== undefined && sameQuery(asked, form)) void graph.refetch();
    else setAsked({ ...form });
  };

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('dgv.lin.title')}</h1>
          <p>{t('dgv.lin.subtitle')}</p>
        </div>
      </div>
      <form className="card" onSubmit={submit} noValidate aria-label={t('dgv.lin.form.title')}>
        <Field id="lin-kind" label={t('dgv.lin.kind')} error={undefined}>
          <select id="lin-kind" value={form.kind} onChange={(event) => setForm({ ...form, kind: event.target.value as NodeKind })}>
            {NODE_KINDS.map((candidate) => (
              <option key={candidate} value={candidate}>
                {kindLabel(t, candidate)}
              </option>
            ))}
          </select>
        </Field>
        <Field id="lin-ref" label={t('dgv.lin.ref')} error={problems.refId === undefined ? undefined : queryProblemMessage(t, problems.refId)}>
          <input id="lin-ref" value={form.refId} aria-invalid={problems.refId !== undefined} onChange={(event) => setForm({ ...form, refId: event.target.value })} />
        </Field>
        <Field id="lin-direction" label={t('dgv.lin.direction')} error={undefined}>
          <select id="lin-direction" value={form.direction} onChange={(event) => setForm({ ...form, direction: event.target.value as Direction })}>
            {DIRECTIONS.map((candidate) => (
              <option key={candidate} value={candidate}>
                {directionLabel(t, candidate)}
              </option>
            ))}
          </select>
        </Field>
        <Field id="lin-depth" label={t('dgv.lin.depth')} error={undefined}>
          <select id="lin-depth" value={form.depth} onChange={(event) => setForm({ ...form, depth: Number(event.target.value) })}>
            {DEPTHS.map((candidate) => (
              <option key={candidate} value={candidate}>
                {candidate}
              </option>
            ))}
          </select>
        </Field>
        <div className="formfooter">
          <button type="submit" className="primary" disabled={graph.isFetching}>
            {t('dgv.lin.submit')}
          </button>
        </div>
      </form>
      {asked === undefined ? (
        <p className="card" data-testid="ask-first">
          {t('dgv.lin.choose')}
        </p>
      ) : graph.isFetching ? (
        <div className="card" role="status" aria-busy="true" aria-label={t('states.loading.label')} />
      ) : graph.isError ? (
        <p className="callout warning" role="alert" data-testid="failed" data-reason={describeLineageProblem(graph.error)}>
          {reasonMessage(t, describeLineageProblem(graph.error))}
        </p>
      ) : graph.data === undefined ? null : (
        <>
          {graph.data.truncated ? (
            <p className="callout warning" data-testid="truncated">
              {t('dgv.lin.truncated')}
            </p>
          ) : null}
          <ol className="card" data-testid="levels" aria-label={t('dgv.lin.levels')}>
            {levelsOf(graph.data).map(({ level, nodes }) => (
              <li key={level} data-level={level}>
                <h2>{level === 0 ? t('dgv.lin.level.start') : t('dgv.lin.level.step', { level })}</h2>
                <ul>
                  {nodes.map((node) => (
                    <NodeLine key={node.key} node={node} />
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
              {graph.data.edges.map((edge, index) => (
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
      )}
      <p className="prototype-note">{t('dgv.lin.footer', { id: route.id, req: route.req ?? '' })}</p>
    </section>
  );
}

function NodeLine({ node }: { node: LineageNode }) {
  const { t } = useTranslation();
  if (node.restricted) {
    return (
      <li data-restricted="true" data-node={node.key}>
        <span className="pill gray">{t('dgv.lin.restricted')}</span>
      </li>
    );
  }
  return (
    <li data-node={node.key} data-kind={node.kind ?? ''}>
      <span className="pill">{node.kind === null ? '' : kindLabel(t, node.kind)}</span> <strong>{node.name}</strong>
      <span className="sub">
        {' '}
        · {node.module} · {node.refId ?? node.refKey} · {node.classification}
      </span>
    </li>
  );
}
