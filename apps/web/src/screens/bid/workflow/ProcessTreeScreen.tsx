import { useEffect, useMemo, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import type { ScreenProps } from '../../../routes/types';
import { useSession } from '../../../session/SessionContext';
import { StateBoundary } from '../../../states/StateBoundary';
import { useScreenState } from '../../../states/useScreenState';
import { ContextBar, KpiStrip, KpiTile, ProcessTree } from '../../../ui';
import type { ProcessTreeNotice } from '../../../ui';
import { Figure, PATHS, ViewSwitcher, WorkflowFilters } from './components';
import { useProcessTree } from './hooks';
import { NodePanel } from './NodePanel';
import { appliedCount, billions, filtersOf, fullDay, shortDay, treeIsEmpty, treeToView, vietnamDay, vietnamTime, withoutPeriod } from './model';
import type { Filters, TreeWords } from './model';
import './workflow.css';

/**
 * BID-27, "Tiến độ theo quy trình" (PRC-1, docs/process-tree-design.md): the packages of the procurement as one tree of states with how many are in each, what is late, and how many moved between them in the period. A click opens the
 * node: its numbers, its packages and what changed in it; a click on a package opens its page with the timeline. The same filters carry over to the board by step and to the list.
 */
export default function ProcessTreeScreen({ route }: ScreenProps) {
  const { tenant } = useSession();
  // The tree, the filters and the open node belong to one membership: a switch of tenant or of membership starts the screen over.
  return <ProcessTreeContent key={`${tenant?.id ?? 'none'}:${tenant?.membershipId ?? 'none'}`} route={route} />;
}

function ProcessTreeContent({ route }: ScreenProps) {
  const { t, locale } = useTranslation();
  const { tenant } = useSession();
  const [search, setSearch] = useSearchParams();
  const filters = useMemo(() => filtersOf(search), [search]);
  const nodeId = search.get('node') ?? undefined;
  const tree = useProcessTree(filters);
  const root = useRef<HTMLDivElement>(null);
  const restore = useRef<string | undefined>(undefined);

  const words: TreeWords = {
    root: t('prc1.tree.root.name'),
    unit: t('prc1.unit.billion.name'),
    notStarted: t('prc1.status.notStarted.name'),
    completed: t('prc1.status.completed.name'),
    cancelled: t('prc1.status.cancelled.name'),
    onHold: t('prc1.substate.onHold.name'),
    late: t('prc1.substate.late.name'),
    returned: t('prc1.substate.returned.name'),
    onTrack: t('prc1.substate.onTrack.name'),
    hold: t('prc1.edge.hold.text'),
  };
  const view = useMemo(() => (tree.data === undefined ? { nodes: [], edges: [] } : treeToView(tree.data, words, locale)), [tree.data, locale]); // eslint-disable-line react-hooks/exhaustive-deps
  const state = useScreenState({ isLoading: tree.isLoading, error: tree.data === undefined ? tree.error : undefined, data: tree.data, isEmpty: (data) => treeIsEmpty(data as NonNullable<typeof tree.data>) });
  const selected = view.nodes.find((node) => node.id === nodeId);

  const change = (next: Filters): void => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(next)) if (value !== undefined) params.set(key, String(value));
    setSearch(params);
  };
  const open = (id: string): void => {
    const params = new URLSearchParams(search);
    params.set('node', id);
    setSearch(params);
  };
  const close = (): void => {
    restore.current = nodeId;
    const params = new URLSearchParams(search);
    params.delete('node');
    setSearch(params);
  };
  useEffect(() => {
    if (restore.current === undefined || nodeId !== undefined) return;
    const wanted = restore.current;
    restore.current = undefined;
    Array.from(root.current?.querySelectorAll<HTMLElement>('[data-node-id]') ?? [])
      .find((element) => element.getAttribute('data-node-id') === wanted)
      ?.focus();
  });

  const data = tree.data;
  const asOf = data === undefined ? undefined : `${fullDay(vietnamDay(data.as_of))} ${vietnamTime(data.as_of)}`;
  const stale = tree.isError && data !== undefined;
  const notices: ProcessTreeNotice[] = [];
  if (data?.truncated === true) notices.push({ kind: 'partial', text: t('prc1.truncated.text') });
  if (stale && asOf !== undefined) notices.push({ kind: 'stale', text: t('prc1.stale.text', { time: asOf }) });
  const period = data === undefined ? '' : `${shortDay(data.period.from)} – ${shortDay(data.period.to)}`;
  const todayVn = data === undefined ? '' : vietnamDay(data.as_of);
  const loading = state === 'loading';
  const kpi = data?.kpis;
  const asOfDay = data === undefined ? '' : fullDay(todayVn);

  return (
    <section data-screen-id={route.id} aria-labelledby="screen-title" ref={root}>
      <div className="heading">
        <div>
          <h1 id="screen-title">{t('prc1.tree.page.title')}</h1>
          <p>{t('prc1.tree.page.subtitle')}</p>
        </div>
      </div>
      <ViewSwitcher active="tree" />
      <ContextBar
        items={[
          { label: t('prc1.context.scope.label'), value: tenant?.name ?? t('prc1.column.none.text') },
          { label: t('prc1.context.period.label'), value: period === '' ? t('prc1.column.none.text') : period },
        ]}
        unit={t('prc1.unit.billion.name')}
        {...(asOf === undefined ? {} : { asOf })}
        stale={stale}
      />
      <WorkflowFilters filters={filters} onChange={change} period updatedAt={asOf} />
      <KpiStrip label={t('prc1.kpi.group.label')}>
        <KpiTile state={loading ? 'loading' : 'ready'} label={t('prc1.kpi.total.label')} value={data === undefined ? '' : String(data.total.count)} sub={<Figure kind="total" asOf={asOfDay} />} />
        <KpiTile state={loading ? 'loading' : 'ready'} label={t('prc1.kpi.running.label')} value={kpi === undefined ? '' : String(kpi.running)} sub={<Figure kind="running" asOf={asOfDay} />} />
        <KpiTile state={loading ? 'loading' : 'ready'} tone={kpi !== undefined && kpi.late > 0 ? 'danger' : 'default'} label={t('prc1.kpi.late.label')} value={kpi === undefined ? '' : String(kpi.late)} sub={<Figure kind="late" asOf={asOfDay} />} />
        <KpiTile state={loading ? 'loading' : 'ready'} tone={kpi !== undefined && kpi.stalled > 0 ? 'warning' : 'default'} label={t('prc1.kpi.stalled.label')} value={kpi === undefined ? '' : String(kpi.stalled)} sub={<Figure kind="stalled" asOf={asOfDay} />} />
        <KpiTile state={loading ? 'loading' : 'ready'} label={t('prc1.kpi.value.label')} value={data === undefined ? '' : billions(data.total.value_vnd, locale)} unit={t('prc1.unit.billion.name')} sub={<Figure kind="value" asOf={asOfDay} />} />
        <KpiTile
          state={loading ? 'loading' : 'ready'}
          label={t('prc1.kpi.median.label')}
          value={kpi === undefined || kpi.median_days === null ? t('prc1.column.none.text') : String(kpi.median_days)}
          unit={kpi === undefined || kpi.median_days === null ? undefined : t('prc1.kpi.days.unit')}
          sub={<Figure kind="median" asOf={asOfDay} />}
        />
      </KpiStrip>
      {stale && (
        <div className="callout prc1-callout" role="alert">
          <span>{t('prc1.error.source.text')}</span>{' '}
          <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={() => void tree.refetch()}>
            {t('ui.common.retry')}
          </button>
        </div>
      )}
      <p className="sub prc1-health-help">{t('prc1.health.help.text')}</p>
      <StateBoundary state={state === 'denied' || state === 'signedOut' || state === 'offline' ? state : 'default'} onRetry={() => void tree.refetch()}>
        <div className={`prc1-board${selected === undefined ? '' : ' has-panel'}`}>
          <div className="prc1-board__main">
            <ProcessTree
              nodes={view.nodes}
              edges={view.edges}
              selectedId={selected?.id}
              onSelect={open}
              state={state === 'loading' ? 'loading' : state === 'error' ? 'error' : state === 'empty' ? 'empty' : 'ready'}
              onRetry={() => void tree.refetch()}
              caption={t('prc1.tree.caption.text')}
              emptyKind={appliedCount(filters) > 0 ? 'filtered' : 'none'}
              onClearFilters={() => change({})}
              notices={notices}
              storageKey="bid-27"
            />
          </div>
          {selected !== undefined && data !== undefined && <NodePanel node={selected} tree={data} filters={withoutPeriod(filters)} onClose={close} today={todayVn} />}
        </div>
      </StateBoundary>
      <p className="prototype-note">
        {t('prc1.footer.reference', { id: route.id, req: route.req ?? '' })} · <a href={PATHS.analysis}>{t('prc1.footer.analysis.link')}</a>
      </p>
    </section>
  );
}
