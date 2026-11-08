import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../i18n';
import type { Translator } from '../../i18n';
import type { ScreenProps } from '../../routes/types';
import { useSession } from '../../session/SessionContext';
import { StateBoundary } from '../../states/StateBoundary';
import { useScreenState } from '../../states/useScreenState';
import { ContextBar, SectionCard } from '../../ui';
import { useLineage } from './trust-hooks';
import { FRESHNESS_PATH, NODE_KINDS } from './trust-model';
import type { LineageNode, LineageView, NodeKind } from './trust-model';

type T = Translator['t'];

function kindLabel(t: T, kind: NodeKind): string {
  switch (kind) {
    case 'MODULE':
      return t('ana.lineage.kind.module');
    case 'TABLE':
      return t('ana.lineage.kind.table');
    case 'DATASET':
      return t('ana.lineage.kind.dataset');
    case 'METRIC':
      return t('ana.lineage.kind.metric');
    case 'KPI':
      return t('ana.lineage.kind.kpi');
  }
}

function gapLabel(t: T, kind: string): string {
  return kind === 'METRIC_WITHOUT_DATASET' ? t('ana.lineage.gap.metric') : kind === 'TABLE_WITHOUT_MODULE' ? t('ana.lineage.gap.table') : t('ana.lineage.gap.other');
}

/** The ids of a path as the readable line the explorer shows: `metric <- dataset <- table <- module` when going upstream, the other way round downstream. */
export function pathLine(path: readonly string[], nodes: ReadonlyMap<string, LineageNode>, direction: 'UPSTREAM' | 'DOWNSTREAM'): string {
  const arrow = direction === 'UPSTREAM' ? ' ← ' : ' → ';
  return path.map((id) => nodes.get(id)?.label ?? id).join(arrow);
}

/**
 * BI-24: where a number comes from (G3-11). Pick a metric, an indicator, a dataset, a table or a module: upstream shows the chain metric <- dataset <- table <- module, downstream shows what stands on it ("what is hurt if
 * this table changes"). Every node of a line is a button that moves the root there; a table with no known owner and a metric no dataset serves are listed as gaps, not hidden.
 */
export default function LineageScreen({ route }: ScreenProps) {
  const tenant = useSession().tenant;
  return <LineageContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function LineageContent({ route }: ScreenProps) {
  const { t } = useTranslation();
  const [node, setNode] = useState('');
  const [direction, setDirection] = useState<'UPSTREAM' | 'DOWNSTREAM'>('UPSTREAM');
  const [depth, setDepth] = useState(4);
  const [kind, setKind] = useState<NodeKind>('METRIC');
  const query = useLineage({ node, direction, depth });
  const view: LineageView | undefined = query.data;
  const state = useScreenState({ isLoading: query.isLoading, error: view === undefined ? query.error : undefined, data: view, isEmpty: (data) => (data as LineageView).counts.nodes === 0 });
  const nodes = new Map<string, LineageNode>((view?.trace?.nodes ?? []).map((one) => [one.id, one]));
  const choices = view?.catalogue.find((group) => group.kind === kind)?.nodes ?? [];
  const contextItems = [
    { label: t('ana.lineage.context.nodes'), value: view === undefined ? '—' : String(view.counts.nodes) },
    { label: t('ana.lineage.context.edges'), value: view === undefined ? '—' : String(view.counts.edges) },
    { label: t('ana.lineage.context.root'), value: node === '' ? t('ana.lineage.context.none') : node },
  ];
  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title">
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('ana.lineage.page.title')}</h1>
          <p>{t('ana.lineage.page.subtitle')}</p>
        </div>
      </div>
      <ContextBar items={contextItems} unit={t('ana.lineage.context.unit')} />
      <StateBoundary state={state} onRetry={() => void query.refetch()}>
        {view === undefined ? null : (
          <div className="ana-stack">
            <SectionCard title={t('ana.lineage.pick.title')}>
              <div className="ana-controls" role="group" aria-label={t('ana.lineage.pick.aria')}>
                <label>
                  {t('ana.lineage.pick.kind')}
                  <select value={kind} onChange={(event) => setKind(NODE_KINDS.find((one) => one === event.target.value) ?? 'METRIC')} data-testid="lineage-kind">
                    {NODE_KINDS.map((one) => (
                      <option key={one} value={one}>
                        {kindLabel(t, one)}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  {t('ana.lineage.pick.node')}
                  <select value={node} onChange={(event) => setNode(event.target.value)} data-testid="lineage-node">
                    <option value="">{t('ana.lineage.pick.choose')}</option>
                    {choices.map((one) => (
                      <option key={one.id} value={one.id}>
                        {one.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  {t('ana.lineage.pick.direction')}
                  <select value={direction} onChange={(event) => setDirection(event.target.value === 'DOWNSTREAM' ? 'DOWNSTREAM' : 'UPSTREAM')} data-testid="lineage-direction">
                    <option value="UPSTREAM">{t('ana.lineage.direction.up')}</option>
                    <option value="DOWNSTREAM">{t('ana.lineage.direction.down')}</option>
                  </select>
                </label>
                <label>
                  {t('ana.lineage.pick.depth')}
                  <select value={depth} onChange={(event) => setDepth(Number(event.target.value))} data-testid="lineage-depth">
                    {[1, 2, 3, 4, 5, 6].map((one) => (
                      <option key={one} value={one}>
                        {one}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              {choices.length === 0 ? <p className="muted">{t('ana.lineage.pick.none')}</p> : null}
            </SectionCard>
            <SectionCard title={t('ana.lineage.trace.title')}>
              {view.trace === null ? (
                <p role="status" data-testid="lineage-hint">
                  {t('ana.lineage.trace.hint')}
                </p>
              ) : view.trace.paths.length === 0 ? (
                <p role="status" data-testid="lineage-nothing">
                  {direction === 'UPSTREAM' ? t('ana.lineage.trace.nothingUp') : t('ana.lineage.trace.nothingDown')}
                </p>
              ) : (
                <ol className="ana-paths" data-testid="lineage-paths" aria-label={direction === 'UPSTREAM' ? t('ana.lineage.direction.up') : t('ana.lineage.direction.down')}>
                  {view.trace.paths.map((path) => (
                    <li key={path.join('>')} data-testid="lineage-path">
                      {path.map((id, index) => (
                        <span key={id}>
                          {index === 0 ? null : <span aria-hidden="true">{direction === 'UPSTREAM' ? ' ← ' : ' → '}</span>}
                          <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => setNode(id)} data-testid={`lineage-go-${id}`} aria-label={t('ana.lineage.trace.go', { node: nodes.get(id)?.label ?? id })}>
                            {nodes.get(id)?.label ?? id}
                            <span className="muted"> {nodes.get(id) === undefined ? '' : kindLabel(t, (nodes.get(id) as LineageNode).kind)}</span>
                          </button>
                        </span>
                      ))}
                      <span className="sr-only">{pathLine(path, nodes, direction)}</span>
                    </li>
                  ))}
                </ol>
              )}
            </SectionCard>
            {view.unresolved.length === 0 ? null : (
              <SectionCard title={t('ana.lineage.gaps.title')}>
                <ul data-testid="lineage-gaps">
                  {view.unresolved.map((gap) => (
                    <li key={`${gap.kind}:${gap.key}`}>
                      {gap.key}: {gapLabel(t, gap.kind)}
                    </li>
                  ))}
                </ul>
              </SectionCard>
            )}
            <p className="ana-links">
              <Link to={FRESHNESS_PATH}>{t('ana.lineage.link.freshness')}</Link>
            </p>
          </div>
        )}
      </StateBoundary>
    </section>
  );
}
