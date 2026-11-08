import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { useTranslation } from '../i18n';
import type { Translator } from '../i18n';
import { StatusPill } from './StatusPill';
import type { Tone, UiState } from './types';
import { useMediaQuery } from './useMediaQuery';
import { defaultExpanded, edgePath, indexOf, layoutFlow, navigate, percentOf, visibleOrder } from './process-tree-model';
import type { FlowGeometry, NavKey, ProcessTreeEdge, ProcessTreeHealth, ProcessTreeNode } from './process-tree-model';

export type { ProcessTreeEdge, ProcessTreeEdgeKind, ProcessTreeHealth, ProcessTreeNode } from './process-tree-model';

export interface ProcessTreeNotice {
  kind: 'partial' | 'stale' | 'denied';
  text: string;
}

export interface ProcessTreeProps {
  nodes: readonly ProcessTreeNode[];
  edges: readonly ProcessTreeEdge[];
  selectedId?: string | undefined;
  onSelect: (id: string) => void;
  state?: UiState | undefined;
  onRetry?: (() => void) | undefined;
  /** `flow` is the left-to-right picture, `outline` the indented list; without it the width of the window decides (flow from 980 px). */
  view?: 'flow' | 'outline' | undefined;
  /** The name of the board for screen readers and the caption of the table. */
  caption: string;
  emptyKind?: 'none' | 'filtered' | undefined;
  /** The sentence and the action of an empty board that has no package yet. */
  emptyText?: string | undefined;
  emptyActionLabel?: string | undefined;
  onEmptyAction?: (() => void) | undefined;
  onClearFilters?: (() => void) | undefined;
  /** The banners of a partial, stale or denied board; the nodes stay as they were read. */
  notices?: readonly ProcessTreeNotice[] | undefined;
  /** The key under which the expanded rows of the outline are remembered for the session (UI state only). */
  storageKey?: string | undefined;
  /** How many levels of the outline are open at first. */
  openDepth?: number | undefined;
}

const HEALTH_TONE: Readonly<Record<Exclude<ProcessTreeHealth, 'none'>, Tone>> = { ok: 'success', attention: 'warning', late: 'danger', hold: 'neutral' };
const HEALTH_ICON: Readonly<Record<Exclude<ProcessTreeHealth, 'none'>, string>> = { ok: '✓', attention: '⚠', late: '⛔', hold: '⏸' };
const SKELETON_COLUMNS = 3;

function healthWord(t: Translator['t'], health: Exclude<ProcessTreeHealth, 'none'>): string {
  switch (health) {
    case 'ok':
      return t('ui.processTree.health.ok');
    case 'attention':
      return t('ui.processTree.health.attention');
    case 'late':
      return t('ui.processTree.health.late');
    case 'hold':
      return t('ui.processTree.health.hold');
  }
}

const countText = (t: Translator['t'], node: ProcessTreeNode): string => (node.count === null ? t('ui.processTree.node.unknown') : t('ui.processTree.node.packages', { count: node.count }));

/** The sentence a screen reader reads for a node: name, count, value, how many are late, and what a press does. */
function nodeSentence(t: Translator['t'], node: ProcessTreeNode): string {
  if (node.ariaLabel !== undefined) return node.ariaLabel;
  const parts = [node.label, countText(t, node)];
  if (node.value !== undefined) parts.push(t('ui.processTree.node.valueIs', { value: node.value, unit: node.unit ?? '' }).trim());
  if (node.lateCount !== undefined && node.lateCount > 0) parts.push(t('ui.processTree.node.late', { count: node.lateCount }));
  if (node.heldCount !== undefined && node.heldCount > 0) parts.push(t('ui.processTree.node.held', { count: node.heldCount }));
  if (node.count !== 0) parts.push(t('ui.processTree.node.choose'));
  return parts.join(', ');
}

function Health({ node }: { node: ProcessTreeNode }) {
  const { t } = useTranslation();
  if (node.health === undefined || node.health === 'none') return null;
  return (
    <StatusPill tone={HEALTH_TONE[node.health]} icon={HEALTH_ICON[node.health]}>
      {healthWord(t, node.health)}
    </StatusPill>
  );
}

function Facts({ node }: { node: ProcessTreeNode }) {
  const { t } = useTranslation();
  const percent = percentOf(node.share);
  return (
    <>
      <span className="ui-process-tree__count">{node.count === null ? t('ui.processTree.node.unknown') : node.count}</span>
      <span className="ui-process-tree__unitword">{node.count === null ? '' : t('ui.processTree.node.unitWord')}</span>
      {node.value !== undefined && (
        <span className="ui-process-tree__value">{t('ui.processTree.node.value', { value: node.value, unit: node.unit ?? '' })}</span>
      )}
      {percent !== null && (
        <span className="ui-process-tree__share">
          <span className="ui-process-tree__bar" aria-hidden="true">
            <span className="ui-process-tree__bar-fill" style={{ width: `${Math.min(100, Math.max(0, percent))}%` }} />
          </span>
          <span>{t('ui.processTree.node.share', { percent })}</span>
        </span>
      )}
      {(node.medianDays !== undefined && node.medianDays !== null) || (node.longestDays !== undefined && node.longestDays !== null) ? (
        <span className="ui-process-tree__days">
          {node.medianDays !== undefined && node.medianDays !== null && t('ui.processTree.node.median', { days: node.medianDays })}
          {node.medianDays !== undefined && node.medianDays !== null && node.longestDays !== undefined && node.longestDays !== null && ' · '}
          {node.longestDays !== undefined && node.longestDays !== null && t('ui.processTree.node.longest', { days: node.longestDays })}
        </span>
      ) : null}
    </>
  );
}

function readExpanded(key: string | undefined): Set<string> | undefined {
  if (key === undefined) return undefined;
  try {
    const raw = window.sessionStorage.getItem(`ui.processTree:${key}`);
    if (raw === null) return undefined;
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? new Set(parsed.filter((item): item is string => typeof item === 'string')) : undefined;
  } catch {
    return undefined;
  }
}

function writeExpanded(key: string | undefined, value: ReadonlySet<string>): void {
  if (key === undefined) return;
  try {
    window.sessionStorage.setItem(`ui.processTree:${key}`, JSON.stringify([...value]));
  } catch {
    // The session store may be blocked; the outline then forgets its open rows on reload and nothing else.
  }
}

/**
 * "Progress tree": the states of a process as one connected picture (docs/process-tree-design.md). The flow view lays the nodes out left to right in columns, one lane per branch, with the edges between them as an
 * aria-hidden SVG whose width tells how many moved; the outline view is the same tree as an indented `role="tree"` list, which is also what assistive technology reads. Every count is text, health is an icon and a word,
 * and the same figures can be read as a table. Arrow keys move between nodes (roving tabindex), Enter or Space selects, Escape in the outline closes the open branch and returns to its node.
 */
export function ProcessTree({
  nodes,
  edges,
  selectedId,
  onSelect,
  state = 'ready',
  onRetry,
  view,
  caption,
  emptyKind = 'none',
  emptyText,
  emptyActionLabel,
  onEmptyAction,
  onClearFilters,
  notices = [],
  storageKey,
  openDepth = 2,
}: ProcessTreeProps) {
  const { t } = useTranslation();
  const wide = useMediaQuery('(min-width: 980px)');
  const roomy = useMediaQuery('(min-width: 1280px)');
  const mode = view ?? (wide ? 'flow' : 'outline');
  const index = useMemo(() => indexOf(nodes), [nodes]);
  // What the person opened or closed (or what the session remembers); until they do, the first levels are open, whatever the nodes are by then.
  const [chosen, setChosen] = useState<Set<string> | undefined>(() => readExpanded(storageKey));
  const expanded = useMemo(() => chosen ?? defaultExpanded(index, openDepth), [chosen, index, openDepth]);
  const [asTable, setAsTable] = useState(false);
  const [hovered, setHovered] = useState<string | undefined>(undefined);
  const shown = useMemo(() => visibleOrder(index, expanded), [index, expanded]);
  const [focusId, setFocusId] = useState<string | undefined>(undefined);
  const root = useRef<HTMLDivElement>(null);
  const pending = useRef<string | undefined>(undefined);

  const activeId = focusId !== undefined && shown.includes(focusId) ? focusId : selectedId !== undefined && shown.includes(selectedId) ? selectedId : shown[0];

  const toggle = useCallback(
    (id: string, open?: boolean) => {
      setChosen(() => {
        const next = new Set(expanded);
        const want = open ?? !next.has(id);
        if (want) next.add(id);
        else next.delete(id);
        writeExpanded(storageKey, next);
        return next;
      });
    },
    [expanded, storageKey],
  );

  useEffect(() => {
    if (pending.current === undefined || root.current === null) return;
    const wanted = pending.current;
    const target = Array.from(root.current.querySelectorAll<HTMLElement>('[data-node-id]')).find((element) => element.getAttribute('data-node-id') === wanted);
    pending.current = undefined;
    target?.focus();
  });

  const focusNode = (id: string): void => {
    pending.current = id;
    setFocusId(id);
  };

  const select = (node: ProcessTreeNode): void => {
    if (node.count === 0) return;
    onSelect(node.id);
  };

  const onKey = (event: KeyboardEvent<HTMLElement>, node: ProcessTreeNode, outline: boolean): void => {
    const key = event.key;
    if (key === 'ArrowRight' && outline && (index.children.get(node.id)?.length ?? 0) > 0 && !expanded.has(node.id)) {
      event.preventDefault();
      toggle(node.id, true);
      return;
    }
    if (key === 'ArrowLeft' && outline && expanded.has(node.id) && (index.children.get(node.id)?.length ?? 0) > 0) {
      event.preventDefault();
      toggle(node.id, false);
      return;
    }
    if (key === 'ArrowRight' || key === 'ArrowLeft' || key === 'ArrowDown' || key === 'ArrowUp' || key === 'Home' || key === 'End') {
      event.preventDefault();
      const order = outline ? shown : index.order.filter((id) => index.byId.get(id)?.inFlow !== false);
      const target = navigate(index, order, node.id, key as NavKey);
      if (target !== node.id) focusNode(target);
      return;
    }
    if (key === 'Enter' || key === ' ') {
      event.preventDefault();
      select(node);
      return;
    }
    if (key === 'Escape') {
      // Close the branch the node is in and come back to the node that opened it.
      const parent = node.parentId;
      if (outline && parent !== undefined && parent !== null && index.byId.has(parent)) {
        event.preventDefault();
        toggle(parent, false);
        focusNode(parent);
      } else if (outline && expanded.has(node.id)) {
        event.preventDefault();
        toggle(node.id, false);
      }
    }
  };

  // ---- the states of the board ----------------------------------------------------------------------------------------------------------------------------------------------

  if (state === 'loading') {
    return (
      <div className="ui-process-tree ui-process-tree--loading" role="status" aria-busy="true" aria-label={t('ui.processTree.loading.label')}>
        {Array.from({ length: SKELETON_COLUMNS }, (_, column) => (
          <div className="ui-process-tree__skeleton-column" key={column}>
            <span className="ui-skeleton ui-skeleton--line ui-skeleton--short" />
            <span className="ui-skeleton ui-process-tree__skeleton-card" />
            <span className="ui-skeleton ui-process-tree__skeleton-card" />
          </div>
        ))}
      </div>
    );
  }
  if (state === 'error') {
    return (
      <div className="ui-process-tree ui-process-tree--message" role="alert">
        <span>{t('ui.processTree.error.message')}</span>
        {onRetry !== undefined && (
          <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={onRetry}>
            {t('ui.common.retry')}
          </button>
        )}
      </div>
    );
  }
  if (state === 'empty' || nodes.length === 0) {
    return (
      <div className="ui-process-tree ui-process-tree--message" role="status">
        <span>{emptyKind === 'filtered' ? t('ui.processTree.empty.filtered') : (emptyText ?? t('ui.processTree.empty.none'))}</span>
        {emptyKind === 'filtered' && onClearFilters !== undefined && (
          <button type="button" className="ui-button ui-button--outline ui-button--small" onClick={onClearFilters}>
            {t('ui.processTree.empty.clear')}
          </button>
        )}
        {emptyKind !== 'filtered' && onEmptyAction !== undefined && emptyActionLabel !== undefined && (
          <button type="button" className="ui-button ui-button--primary ui-button--small" onClick={onEmptyAction}>
            {emptyActionLabel}
          </button>
        )}
      </div>
    );
  }

  const banners: ReactNode = notices.length > 0 && (
    <div className="ui-process-tree__notices">
      {notices.map((notice) => (
        <p className={`ui-process-tree__notice ui-process-tree__notice--${notice.kind}`} role="status" key={`${notice.kind}:${notice.text}`}>
          {notice.text}
        </p>
      ))}
    </div>
  );

  const toggleView = (
    <button type="button" className="ui-button ui-button--outline ui-button--small ui-process-tree__table-toggle" aria-pressed={asTable} onClick={() => setAsTable((value) => !value)}>
      {asTable ? t('ui.processTree.table.hide') : t('ui.processTree.table.show')}
    </button>
  );

  if (asTable) {
    return (
      <div className="ui-process-tree" ref={root}>
        {banners}
        <div className="ui-process-tree__toolbar">{toggleView}</div>
        <div className="ui-table-scroll" role="region" aria-label={caption} tabIndex={0}>
          <table className="ui-process-tree__table">
            <caption>{caption}</caption>
            <thead>
              <tr>
                <th scope="col">{t('ui.processTree.table.state')}</th>
                <th scope="col">{t('ui.processTree.table.count')}</th>
                <th scope="col">{t('ui.processTree.table.value')}</th>
                <th scope="col">{t('ui.processTree.table.share')}</th>
                <th scope="col">{t('ui.processTree.table.median')}</th>
                <th scope="col">{t('ui.processTree.table.late')}</th>
                <th scope="col">{t('ui.processTree.table.health')}</th>
              </tr>
            </thead>
            <tbody>
              {index.order.map((id) => {
                const node = index.byId.get(id) as ProcessTreeNode;
                const percent = percentOf(node.share);
                return (
                  <tr key={id} data-node-id={id}>
                    <th scope="row" style={{ paddingInlineStart: `calc(var(--mv-space-12) + ${(index.depth.get(id) ?? 0) * 16}px)` }}>
                      {node.label}
                    </th>
                    <td>{node.count === null ? t('ui.processTree.node.unknown') : node.count}</td>
                    <td>{node.value === undefined ? '' : t('ui.processTree.node.value', { value: node.value, unit: node.unit ?? '' })}</td>
                    <td>{percent === null ? '' : t('ui.processTree.node.share', { percent })}</td>
                    <td>{node.medianDays === undefined || node.medianDays === null ? '' : t('ui.processTree.node.median', { days: node.medianDays })}</td>
                    <td>{node.lateCount === undefined ? '' : node.lateCount}</td>
                    <td>{node.health === undefined || node.health === 'none' ? '' : healthWord(t, node.health)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {edges.length > 0 && (
          <ul className="ui-process-tree__flows" aria-label={t('ui.processTree.flows.label')}>
            {edges.map((edge) => (
              <li key={`${edge.from}>${edge.to}>${edge.kind}`}>{edgeText(t, edge, index.byId.get(edge.from)?.label ?? edge.from, index.byId.get(edge.to)?.label ?? edge.to)}</li>
            ))}
          </ul>
        )}
      </div>
    );
  }

  // ---- the outline ------------------------------------------------------------------------------------------------------------------------------------------------------------

  if (mode === 'outline') {
    const renderBranch = (id: string, level: number): ReactNode => {
      const node = index.byId.get(id) as ProcessTreeNode;
      const kids = index.children.get(id) ?? [];
      const open = expanded.has(id);
      const size = (index.children.get(node.parentId ?? null) ?? []).length;
      const position = (index.children.get(node.parentId ?? null) ?? []).indexOf(id) + 1;
      const selected = selectedId === id;
      const percent = percentOf(node.share);
      return (
        <li
          key={id}
          role="treeitem"
          aria-level={level + 1}
          aria-setsize={size}
          aria-posinset={position}
          aria-expanded={kids.length > 0 ? open : undefined}
          aria-selected={selected}
          aria-label={nodeSentence(t, node)}
          data-node-id={id}
          tabIndex={activeId === id ? 0 : -1}
          className={`ui-process-tree__item${selected ? ' is-selected' : ''}${node.count === 0 ? ' is-empty' : ''}`}
          onKeyDown={(event) => {
            if (event.target === event.currentTarget) onKey(event, node, true);
          }}
          onFocus={(event) => {
            if (event.target === event.currentTarget) setFocusId(id);
          }}
        >
          <div className="ui-process-tree__row" style={{ paddingInlineStart: `${level * 16}px` }}>
            {kids.length > 0 ? (
              <button
                type="button"
                className="ui-process-tree__chevron"
                tabIndex={-1}
                aria-label={open ? t('ui.processTree.outline.collapse', { label: node.label }) : t('ui.processTree.outline.expand', { label: node.label })}
                onClick={() => toggle(id)}
              >
                <span aria-hidden="true">{open ? '▾' : '▸'}</span>
              </button>
            ) : (
              <span className="ui-process-tree__chevron ui-process-tree__chevron--none" aria-hidden="true" />
            )}
            <div className="ui-process-tree__outline-main" onClick={() => select(node)}>
              <span className="ui-process-tree__title">{node.label}</span>
              <span className="ui-process-tree__outline-count">{node.count === null ? t('ui.processTree.node.unknown') : node.count}</span>
            </div>
            <Health node={node} />
          </div>
          {percent !== null && (
            <span className="ui-process-tree__bar ui-process-tree__bar--outline" aria-hidden="true" style={{ marginInlineStart: `${level * 16 + 44}px` }}>
              <span className="ui-process-tree__bar-fill" style={{ width: `${Math.min(100, Math.max(0, percent))}%` }} />
            </span>
          )}
          {kids.length > 0 && open && (
            <ul role="group" className="ui-process-tree__group">
              {kids.map((child) => renderBranch(child, level + 1))}
            </ul>
          )}
        </li>
      );
    };
    return (
      <div className="ui-process-tree ui-process-tree--outline" ref={root}>
        {banners}
        <div className="ui-process-tree__toolbar">{toggleView}</div>
        <ul role="tree" aria-label={caption} className="ui-process-tree__tree">
          {(index.children.get(null) ?? []).map((id) => renderBranch(id, 0))}
        </ul>
      </div>
    );
  }

  // ---- the flow ---------------------------------------------------------------------------------------------------------------------------------------------------------------

  const geometry: FlowGeometry = { columnWidth: roomy ? 232 : 200, gutter: 48, nodeHeight: 132, rowGap: 36, laneHeader: 36, laneGap: 40 };
  const layout = layoutFlow(nodes, index, geometry);
  const maxCount = Math.max(1, ...edges.map((edge) => edge.count));
  const paths = edges.map((edge) => edgePath(layout, geometry, edge, maxCount)).filter((path) => path !== undefined);
  const focus = hovered ?? selectedId;
  const flowOrder = index.order.filter((id) => index.byId.get(id)?.inFlow !== false);
  const flowActive = activeId !== undefined && flowOrder.includes(activeId) ? activeId : flowOrder[0];

  return (
    <div className="ui-process-tree ui-process-tree--flow" ref={root}>
      {banners}
      <div className="ui-process-tree__toolbar">{toggleView}</div>
      <div className="ui-process-tree__canvas ui-table-scroll" role="region" aria-label={caption} tabIndex={0}>
        <div className="ui-process-tree__stage" style={{ width: layout.width, height: layout.height }}>
          <svg className="ui-process-tree__edges" width={layout.width} height={layout.height} aria-hidden="true" focusable="false">
            {paths.map((path) => {
              const dimmed = focus !== undefined && path.from !== focus && path.to !== focus;
              const text = path.text ?? edgeLabel(t, path.kind, path.count);
              const labelWidth = text.length * 6.6 + 14;
              return (
                <g key={`${path.from}>${path.to}>${path.kind}`} className={`ui-process-tree__edge ui-process-tree__edge--${path.kind}${dimmed ? ' is-dimmed' : ''}`}>
                  <path d={path.d} fill="none" strokeWidth={path.width} />
                  <rect x={path.label.x - labelWidth / 2} y={path.label.y - 10} width={labelWidth} height={20} rx={10} className="ui-process-tree__edge-pill" />
                  <text x={path.label.x} y={path.label.y + 4} textAnchor="middle" className="ui-process-tree__edge-text">
                    {text}
                  </text>
                </g>
              );
            })}
          </svg>
          {layout.lanes.map((lane) => (
            <div key={lane.lane} role="group" aria-label={lane.lane === '' ? caption : lane.lane}>
              {lane.lane !== '' && (
                <h3 className="ui-process-tree__lane" style={{ top: lane.y }}>
                  {lane.lane}
                </h3>
              )}
              {lane.nodes.map((cell) => {
                const node = index.byId.get(cell.id) as ProcessTreeNode;
                const selected = selectedId === cell.id;
                const empty = node.count === 0;
                return (
                  <button
                    key={cell.id}
                    type="button"
                    data-node-id={cell.id}
                    aria-pressed={selected}
                    aria-disabled={empty ? true : undefined}
                    aria-label={nodeSentence(t, node)}
                    tabIndex={flowActive === cell.id ? 0 : -1}
                    className={`ui-process-tree__node ui-process-tree__node--${node.health ?? 'none'}${selected ? ' is-selected' : ''}${empty ? ' is-empty' : ''}${node.terminal === true ? ' is-terminal' : ''}`}
                    style={{ left: cell.x, top: cell.y, width: geometry.columnWidth, minHeight: geometry.nodeHeight }}
                    onClick={() => select(node)}
                    onKeyDown={(event) => onKey(event, node, false)}
                    onFocus={() => setFocusId(cell.id)}
                    onMouseEnter={() => setHovered(cell.id)}
                    onMouseLeave={() => setHovered(undefined)}
                  >
                    <span className="ui-process-tree__head">
                      <span className="ui-process-tree__title">{node.label}</span>
                      {node.lateCount !== undefined && node.lateCount > 0 && (
                        <StatusPill tone="danger" icon="⛔">
                          {t('ui.processTree.node.late', { count: node.lateCount })}
                        </StatusPill>
                      )}
                    </span>
                    <Facts node={node} />
                    <Health node={node} />
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function edgeLabel(t: Translator['t'], kind: ProcessTreeEdge['kind'], count: number): string {
  switch (kind) {
    case 'forward':
      return t('ui.processTree.edge.forward', { count });
    case 'return':
      return t('ui.processTree.edge.return', { count });
    case 'drop':
      return t('ui.processTree.edge.drop', { count });
  }
}

function edgeText(t: Translator['t'], edge: ProcessTreeEdge, from: string, to: string): string {
  return t('ui.processTree.flows.item', { from, to, label: edge.label ?? edgeLabel(t, edge.kind, edge.count) });
}
