import { useId, useMemo, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../../../i18n';
import { DataTable, StatusPill } from '../../../ui';
import { PATHS } from '../shared/vnd-model';
import { linkKindLabel } from './investigation-labels';
import { GRAPH_HEIGHT, GRAPH_WIDTH, NODE_RADIUS, drawGraph, linksOf, shortName } from './investigation-model';
import type { LeadLink, LinkNode } from './investigation-model';
import './investigation.css';

export interface LinkGraphProps {
  nodes: readonly LinkNode[];
  links: readonly LeadLink[];
  /** The contractor in the middle; none puts every member on the circle. */
  focusId: string | null;
  /** What the picture is about, for the accessible name ("Links around …", "Links of the lead"). */
  title: string;
}

/**
 * The graph of related parties, drawn without a graph library: an inline SVG whose places the model works out (`radialLayout`: the same input gives the same picture). Nobody has to look at the picture to read it: the table
 * under it lists every link with its strength and its evidence, and a node is a focusable control that opens the links of that contractor. A restricted contractor is marked with a dashed ring AND the word, never by colour
 * alone; the strength of a link is its thickness AND its number; an old link (stale) is dashed AND says so in the table.
 */
export function LinkGraph({ nodes, links, focusId, title }: LinkGraphProps) {
  const { t } = useTranslation();
  const titleId = useId();
  const descId = useId();
  const drawn = useMemo(() => drawGraph(nodes, links, focusId), [nodes, links, focusId]);
  const [selected, setSelected] = useState<string | null>(null);
  const names = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  const nameOf = (id: string): string => names.get(id)?.name ?? id.slice(0, 8);
  const own = selected === null ? [] : linksOf(links, selected);

  const choose = (id: string): void => setSelected((current) => (current === id ? null : id));
  const onKey = (event: KeyboardEvent<SVGGElement>, id: string): void => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      choose(id);
    }
  };

  return (
    <figure className="inv-graph" data-testid="link-graph">
      <svg className="inv-graph__svg" viewBox={`0 0 ${GRAPH_WIDTH} ${GRAPH_HEIGHT}`} role="group" aria-labelledby={`${titleId} ${descId}`} data-testid="graph-svg">
        <title id={titleId}>{title}</title>
        <desc id={descId}>{t('vnd3.graph.desc.text', { nodes: drawn.nodes.length, links: drawn.edges.length })}</desc>
        <g aria-hidden="true">
          {drawn.edges.map((edge) => (
            <g key={edge.key} data-testid={`graph-edge-${edge.key}`} data-strength={edge.strength}>
              <line className={`inv-edge${edge.stale ? ' inv-edge--stale' : ''}${selected !== null && (edge.a === selected || edge.b === selected) ? ' inv-edge--on' : ''}`} x1={edge.x1} y1={edge.y1} x2={edge.x2} y2={edge.y2} strokeWidth={edge.width} />
              <text className="inv-edge__label" x={edge.mx} y={edge.my} textAnchor="middle" dominantBaseline="middle">
                {edge.strength}
              </text>
            </g>
          ))}
        </g>
        {drawn.nodes.map((node) => (
          <g
            key={node.id}
            className={`inv-node${node.focus ? ' inv-node--focus' : ''}${node.restricted ? ' inv-node--restricted' : ''}${selected === node.id ? ' inv-node--selected' : ''}`}
            tabIndex={0}
            role="button"
            aria-pressed={selected === node.id}
            aria-label={`${node.name}, ${node.tax}${node.restricted ? `, ${t('vnd3.graph.restricted.badge')}` : ''}${node.focus ? `, ${t('vnd3.graph.focus.badge')}` : ''}`}
            data-testid={`graph-node-${node.id}`}
            data-x={node.x}
            data-y={node.y}
            onClick={() => choose(node.id)}
            onKeyDown={(event) => onKey(event, node.id)}
          >
            <circle cx={node.x} cy={node.y} r={NODE_RADIUS} />
            <text className="inv-node__initial" x={node.x} y={node.y} textAnchor="middle" dominantBaseline="central" aria-hidden="true">
              {Array.from(node.name)[0] ?? '?'}
            </text>
            <text className="inv-node__name" x={node.x} y={node.y + NODE_RADIUS + 14} textAnchor="middle" aria-hidden="true">
              {shortName(node.name)}
            </text>
            {node.restricted && (
              <text className="inv-node__badge" x={node.x} y={node.y + NODE_RADIUS + 28} textAnchor="middle" aria-hidden="true">
                {t('vnd3.graph.restricted.badge')}
              </text>
            )}
          </g>
        ))}
      </svg>
      <figcaption className="vnd-days">{t('vnd3.graph.caption.text')}</figcaption>
      {selected !== null && (
        <section className="inv-graph__selected" aria-live="polite" data-testid="graph-selected">
          <h3>{t('vnd3.graph.selected.title', { name: nameOf(selected) })}</h3>
          {own.length === 0 ? (
            <p className="vnd-none">{t('vnd3.graph.selected.none')}</p>
          ) : (
            <ul className="vnd-list">
              {own.map((link) => {
                const other = link.a_id === selected ? link.b_id : link.a_id;
                return (
                  <li key={`${link.a_id}:${link.b_id}`}>
                    {t('vnd3.graph.selected.item', { name: nameOf(other), strength: link.strength, kinds: link.evidence.map((entry) => linkKindLabel(t, entry.kind)).join(', ') })}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      )}
      <div className="inv-graph__table" data-testid="graph-table">
        <DataTable<LeadLink>
          caption={t('vnd3.graph.table.caption')}
          rows={[...links]}
          rowKey={(row) => `${row.a_id}:${row.b_id}`}
          rowAttrs={(row) => ({ 'data-link': `${row.a_id}:${row.b_id}` })}
          state={links.length === 0 ? 'empty' : 'ready'}
          columns={[
            {
              key: 'a',
              header: t('vnd3.graph.column.a'),
              pinned: true,
              render: (row) => (names.has(row.a_id) ? <Link to={PATHS.profile(row.a_id)}>{nameOf(row.a_id)}</Link> : nameOf(row.a_id)),
            },
            { key: 'b', header: t('vnd3.graph.column.b'), render: (row) => (names.has(row.b_id) ? <Link to={PATHS.profile(row.b_id)}>{nameOf(row.b_id)}</Link> : nameOf(row.b_id)) },
            { key: 'strength', header: t('vnd3.graph.column.strength'), align: 'right', render: (row) => <strong>{row.strength}</strong> },
            {
              key: 'evidence',
              header: t('vnd3.graph.column.evidence'),
              render: (row) => (
                <span className="vnd-badges">
                  {row.evidence.map((entry) => (
                    <StatusPill key={`${entry.kind}:${entry.fingerprint}`} tone="neutral">
                      {t('vnd3.graph.evidence.item', { kind: linkKindLabel(t, entry.kind), weight: entry.weight, fingerprint: entry.fingerprint })}
                    </StatusPill>
                  ))}
                </span>
              ),
            },
            { key: 'status', header: t('vnd3.graph.column.status'), render: (row) => (row.status === 'STALE' ? <StatusPill tone="neutral">{t('vnd3.graph.status.stale')}</StatusPill> : <StatusPill tone="info">{t('vnd3.graph.status.active')}</StatusPill>) },
          ]}
        />
      </div>
    </figure>
  );
}
