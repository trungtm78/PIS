import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from '../../../i18n';
import { DataTable, ReadonlyStat, SectionCard, StatusPill, Timeline } from '../../../ui';
import type { ProcessTreeNode, TimelineGroup } from '../../../ui';
import { useScreenState } from '../../../states/useScreenState';
import { PATHS, packageColumns } from './components';
import { useNodeFeed, useNodeOverview, useNodePackages } from './hooks';
import { methodLabel, toTimelineEntry } from './labels';
import { billions } from './model';
import type { Filters, TreeDto } from './model';

type Tab = 'overview' | 'packages' | 'changes';

export interface NodePanelProps {
  node: ProcessTreeNode;
  tree: TreeDto;
  filters: Filters;
  onClose: () => void;
  today: string;
}

const HEALTH_TONE = { ok: 'success', attention: 'warning', late: 'danger', hold: 'neutral', none: 'neutral' } as const;

/**
 * The side panel of a node of the tree (spec section 6): its numbers, its packages with the little timeline of each, and the changes that went in and out of it. Escape closes it and gives the focus back to the node; the
 * panel is a sticky column from 1280 px, a drawer below and a full-screen sheet with a back button on a phone (the same markup, styled by the width).
 */
export function NodePanel({ node, tree, filters, onClose, today }: NodePanelProps) {
  const { t, locale } = useTranslation();
  const [tab, setTab] = useState<Tab>('overview');
  const [cursors, setCursors] = useState<Array<string | undefined>>([undefined]);
  const [range, setRange] = useState<{ from?: string | undefined; to?: string | undefined }>({});
  const heading = useRef<HTMLHeadingElement>(null);
  const cursor = cursors[cursors.length - 1];
  const overview = useNodeOverview(node.id, filters);
  const packages = useNodePackages(tab === 'packages' ? node.id : undefined, filters, cursor);
  const feed = useNodeFeed(tab === 'changes' ? node.id : undefined, filters, range);
  const dto = tree.nodes.find((one) => one.id === node.id);
  const stepNames = useMemo(() => new Map(tree.nodes.filter((one) => one.kind === 'STEP' && one.step_code !== null).map((one) => [one.step_code as string, one.label ?? one.step_code as string])), [tree]);
  const names = { step: (code: string | null) => (code === null ? undefined : stepNames.get(code)) };

  useEffect(() => {
    heading.current?.focus();
  }, [node.id]);
  useEffect(() => {
    setCursors([undefined]);
  }, [node.id, filters]);

  const overviewState = useScreenState({ isLoading: overview.isLoading, error: overview.error, data: overview.data, isEmpty: () => false });
  const packageState = useScreenState({ isLoading: packages.isLoading, error: packages.error, data: packages.data, isEmpty: (data) => (data as { items: unknown[] }).items.length === 0 });
  const feedState = useScreenState({ isLoading: feed.isLoading, error: feed.error, data: feed.data, isEmpty: (data) => (data as { items: unknown[] }).items.length === 0 });

  const groups: TimelineGroup[] = useMemo(() => {
    const byDay = new Map<string, TimelineGroup['entries'][number][]>();
    for (const item of feed.data?.items ?? []) {
      const entry = toTimelineEntry(t, item.entry, names);
      const title =
        item.entry.kind === 'STATE_CHANGE'
          ? t('prc1.feed.move.text', { code: item.package_code, from: names.step(item.entry.from_step) ?? item.entry.from_step ?? '', to: names.step(item.entry.to_step) ?? item.entry.to_step ?? '' })
          : t('prc1.feed.prefix.text', { code: item.package_code, title: entry.title ?? '' });
      byDay.set(item.entry.day, [...(byDay.get(item.entry.day) ?? []), { ...entry, title }]);
    }
    return [...byDay.entries()].map(([date, entries]) => ({ date, entries }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [feed.data, t]);

  const tabs: Array<{ id: Tab; label: string }> = [
    { id: 'overview', label: t('prc1.panel.overview.name') },
    { id: 'packages', label: t('prc1.panel.packages.name') },
    { id: 'changes', label: t('prc1.panel.changes.name') },
  ];

  return (
    <aside
      className="prc1-panel"
      aria-label={t('prc1.panel.title.label', { label: node.label })}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <header className="prc1-panel__head">
        <button type="button" className="ui-button ui-button--outline ui-button--small prc1-panel__back" onClick={onClose}>
          {t('prc1.panel.close.action')}
        </button>
        <h2 ref={heading} tabIndex={-1} className="prc1-panel__title">
          {node.label}
        </h2>
        <p className="prc1-panel__sub">
          {t('ui.processTree.node.packages', { count: node.count ?? 0 })}
          {dto !== undefined && ` · ${billions(dto.value_vnd, locale)} ${t('prc1.unit.billion.name')}`}{' '}
          {node.health !== undefined && node.health !== 'none' && <StatusPill tone={HEALTH_TONE[node.health]}>{healthName(t, node.health)}</StatusPill>}
        </p>
        {dto?.method !== null && dto?.method !== undefined && <p className="prc1-panel__sub">{methodLabel(t, dto.method)}</p>}
      </header>
      <div className="prc1-tabs" role="tablist" aria-label={t('prc1.panel.tabs.label')}>
        {tabs.map((one) => (
          <button key={one.id} type="button" role="tab" id={`prc1-tab-${one.id}`} aria-selected={tab === one.id} aria-controls={`prc1-tabpanel-${one.id}`} tabIndex={tab === one.id ? 0 : -1} className={`prc1-tabs__tab${tab === one.id ? ' is-active' : ''}`} onClick={() => setTab(one.id)}>
            {one.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`prc1-tabpanel-${tab}`} aria-labelledby={`prc1-tab-${tab}`} className="prc1-panel__body">
        {tab === 'overview' &&
          (overviewState !== 'default' ? (
            <PanelState state={overviewState} onRetry={() => void overview.refetch()} />
          ) : (
            overview.data !== undefined && (
              <div className="prc1-overview">
                <div className="prc1-overview__stats">
                  <ReadonlyStat label={t('prc1.overview.median.label')} value={overview.data.median_days === null ? t('prc1.column.none.text') : t('prc1.overview.days.text', { days: overview.data.median_days })} sub={overview.data.basis === 'WORKING_DAYS' ? t('prc1.overview.working.text') : t('prc1.overview.calendar.text')} />
                  <ReadonlyStat label={t('prc1.overview.longest.label')} value={overview.data.longest_days === null ? t('prc1.column.none.text') : t('prc1.overview.days.text', { days: overview.data.longest_days })} />
                  <ReadonlyStat label={t('prc1.overview.shortest.label')} value={overview.data.shortest_days === null ? t('prc1.column.none.text') : t('prc1.overview.days.text', { days: overview.data.shortest_days })} />
                  <ReadonlyStat label={t('prc1.overview.late.label')} value={String(overview.data.late_count)} tone={overview.data.late_count > 0 ? 'danger' : undefined} />
                  <ReadonlyStat label={t('prc1.overview.stalled.label')} value={String(overview.data.stalled_count)} />
                  <ReadonlyStat label={t('prc1.overview.held.label')} value={String(overview.data.held_count)} />
                  <ReadonlyStat label={t('prc1.overview.noOwner.label')} value={String(overview.data.no_owner_count)} />
                </div>
                {overview.data.truncated && <p className="callout" role="status">{t('prc1.truncated.text')}</p>}
                <SectionCard title={t('prc1.overview.items.title')}>
                  {overview.data.unfinished_items.length === 0 ? (
                    <p className="sub">{t('prc1.overview.items.none')}</p>
                  ) : (
                    <ol className="prc1-list">
                      {overview.data.unfinished_items.map((item) => (
                        <li key={`${item.step_code}:${item.item_code}`}>{t('prc1.overview.items.row', { name: item.name, count: item.count })}</li>
                      ))}
                    </ol>
                  )}
                </SectionCard>
                <SectionCard title={t('prc1.overview.owners.title')}>
                  {overview.data.top_owners.length === 0 ? (
                    <p className="sub">{t('prc1.overview.owners.none')}</p>
                  ) : (
                    <ol className="prc1-list">
                      {overview.data.top_owners.map((owner) => (
                        <li key={owner.id ?? 'none'}>{t('prc1.overview.owners.row', { name: owner.name ?? t('prc1.column.noOwner.text'), count: owner.count })}</li>
                      ))}
                    </ol>
                  )}
                </SectionCard>
                <SectionCard title={t('prc1.overview.weeks.title')}>
                  <table className="prc1-weeks">
                    <caption className="ui-sr-only">{t('prc1.overview.weeks.title')}</caption>
                    <thead>
                      <tr>
                        <th scope="col">{t('prc1.overview.weeks.week')}</th>
                        <th scope="col">{t('prc1.overview.weeks.in')}</th>
                        <th scope="col">{t('prc1.overview.weeks.out')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {overview.data.weeks.map((week) => (
                        <tr key={week.week_of}>
                          <th scope="row">{`${week.week_of.slice(8, 10)}/${week.week_of.slice(5, 7)}`}</th>
                          <td>
                            <span className="prc1-weeks__bar prc1-weeks__bar--in" aria-hidden="true" style={{ width: `${Math.min(100, week.arrivals * 12)}px` }} />
                            {week.arrivals}
                          </td>
                          <td>
                            <span className="prc1-weeks__bar prc1-weeks__bar--out" aria-hidden="true" style={{ width: `${Math.min(100, week.departures * 12)}px` }} />
                            {week.departures}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </SectionCard>
                <EdgeFacts tree={tree} nodeId={node.id} names={stepNames} />
              </div>
            )
          ))}
        {tab === 'packages' && (
          <>
            <DataTable
              caption={t('prc1.panel.packages.caption', { label: node.label })}
              columns={packageColumns(t, locale, (row) => `${PATHS.package}?package=${row.package_id}&node=${encodeURIComponent(node.id)}`)}
              rows={packages.data?.items ?? []}
              rowKey={(row) => row.package_id}
              severity={(row) => (row.late ? 'ACTION' : null)}
              state={packageState === 'loading' ? 'loading' : packageState === 'error' || packageState === 'denied' || packageState === 'offline' ? 'error' : packageState === 'empty' ? 'empty' : 'ready'}
              onRetry={() => void packages.refetch()}
            />
            {packageState === 'default' && (
              <div className="prc1-pager">
                <button type="button" className="ui-button ui-button--outline ui-button--small" disabled={cursors.length < 2} onClick={() => setCursors((list) => list.slice(0, -1))}>
                  {t('prc1.pager.previous.action')}
                </button>
                <span className="sub">{t('prc1.pager.page.text', { page: cursors.length })}</span>
                <button type="button" className="ui-button ui-button--outline ui-button--small" disabled={packages.data?.next_cursor === null || packages.data?.next_cursor === undefined} onClick={() => setCursors((list) => [...list, packages.data?.next_cursor ?? undefined])}>
                  {t('prc1.pager.next.action')}
                </button>
              </div>
            )}
          </>
        )}
        {tab === 'changes' && (
          <div className="prc1-changes">
            <div className="prc1-changes__range">
              <div className="field">
                <label htmlFor="prc1-feed-from">{t('prc1.filter.from.label')}</label>
                <input id="prc1-feed-from" type="date" value={range.from ?? ''} onChange={(event) => setRange((value) => ({ ...value, from: event.target.value === '' ? undefined : event.target.value }))} />
              </div>
              <div className="field">
                <label htmlFor="prc1-feed-to">{t('prc1.filter.to.label')}</label>
                <input id="prc1-feed-to" type="date" value={range.to ?? ''} onChange={(event) => setRange((value) => ({ ...value, to: event.target.value === '' ? undefined : event.target.value }))} />
              </div>
            </div>
            <Timeline
              caption={t('prc1.panel.changes.caption', { label: node.label })}
              groups={groups}
              today={today}
              gaps={false}
              state={feedState === 'loading' ? 'loading' : feedState === 'error' || feedState === 'denied' || feedState === 'offline' ? 'error' : feedState === 'empty' ? 'empty' : 'ready'}
              emptyKind={range.from !== undefined || range.to !== undefined ? 'filtered' : 'none'}
              onRetry={() => void feed.refetch()}
              notices={feed.data?.truncated === true ? [{ kind: 'partial', text: t('prc1.truncated.text') }] : []}
            />
          </div>
        )}
      </div>
    </aside>
  );
}

function healthName(t: ReturnType<typeof useTranslation>['t'], health: 'ok' | 'attention' | 'late' | 'hold' | 'none'): string {
  switch (health) {
    case 'ok':
      return t('ui.processTree.health.ok');
    case 'attention':
      return t('ui.processTree.health.attention');
    case 'late':
      return t('ui.processTree.health.late');
    case 'hold':
    case 'none':
      return t('ui.processTree.health.hold');
  }
}

function PanelState({ state, onRetry }: { state: string; onRetry: () => void }) {
  const { t } = useTranslation();
  if (state === 'loading') return <div className="prc1-state" role="status" aria-busy="true" aria-label={t('prc1.panel.loading.label')}><span className="ui-skeleton ui-skeleton--line" /><span className="ui-skeleton ui-skeleton--line" /><span className="ui-skeleton ui-skeleton--line" /></div>;
  return (
    <div className="prc1-state" role="alert">
      <span>{state === 'denied' ? t('prc1.panel.denied.text') : t('prc1.panel.error.text')}</span>
      {state !== 'denied' && (
        <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={onRetry}>
          {t('ui.common.retry')}
        </button>
      )}
    </div>
  );
}

/** The moves in and out of the node as sentences: the lines of the edges the accessible tree repeats (spec section 9). */
function EdgeFacts({ tree, nodeId, names }: { tree: TreeDto; nodeId: string; names: ReadonlyMap<string, string> }) {
  const { t } = useTranslation();
  const label = (id: string): string => {
    const node = tree.nodes.find((one) => one.id === id);
    return node?.label ?? names.get(node?.step_code ?? '') ?? id;
  };
  const related = tree.edges.filter((edge) => edge.from === nodeId || edge.to === nodeId || edge.from.startsWith(`${nodeId}:`) || edge.to.startsWith(`${nodeId}:`));
  if (related.length === 0) return null;
  return (
    <SectionCard title={t('prc1.overview.flows.title', { from: tree.period.from.slice(8, 10) + '/' + tree.period.from.slice(5, 7), to: tree.period.to.slice(8, 10) + '/' + tree.period.to.slice(5, 7) })}>
      <ul className="prc1-list">
        {related.map((edge) => (
          <li key={`${edge.from}>${edge.to}>${edge.kind}`}>{t('prc1.overview.flows.row', { count: edge.count, from: label(edge.from), to: label(edge.to) })}</li>
        ))}
      </ul>
    </SectionCard>
  );
}
