import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { useTranslation } from '../../../i18n';
import { StatusPill } from '../../../ui';
import { statusLabel } from './labels';
import { visibleNodes } from './tree-model';
import type { TreeNode } from './tree-model';
import './org-tree.css';

export interface UnitTreeProps {
  forest: readonly TreeNode[];
  expanded: ReadonlySet<string>;
  onToggle(unitId: string): void;
  selectedId: string | undefined;
  onSelect(unitId: string): void;
}

const STATUS_KEY: Readonly<Record<string, string>> = {
  Planned: 'adm.orgUnit.status.planned',
  Active: 'adm.orgUnit.status.active',
  Superseded: 'adm.orgUnit.status.superseded',
  Dissolved: 'adm.orgUnit.status.dissolved',
};

/** The status label key of a unit; a status this screen does not know is shown as the unit's own text. */
export function statusKeyOf(status: string): string | undefined {
  return STATUS_KEY[status];
}

interface NodeViewProps extends UnitTreeProps {
  node: TreeNode;
  focusedId: string | undefined;
  register(unitId: string, element: HTMLDivElement | null): void;
}

function NodeView({ node, expanded, onToggle, selectedId, onSelect, focusedId, register, forest }: NodeViewProps) {
  const { t } = useTranslation();
  const { unit } = node;
  const open = expanded.has(unit.id);
  const hasChildren = node.children.length > 0;
  const groupId = `unit-group-${unit.id}`;
  const showsGroup = hasChildren && open;
  // The name of the unit is everything the row shows besides the buttons (code and name, status, successor), in the order it is read, so that the visible text is in the accessible name (WCAG 2.5.3).
  const labelledBy = [`unit-label-${unit.id}`, `unit-status-${unit.id}`, ...(node.successor === undefined ? [] : [`unit-successor-${unit.id}`])].join(' ');
  return (
    <li role="none">
      <div
        role="treeitem"
        aria-labelledby={labelledBy}
        aria-level={node.level}
        aria-selected={selectedId === unit.id}
        aria-expanded={hasChildren ? open : undefined}
        aria-owns={showsGroup ? groupId : undefined}
        tabIndex={focusedId === unit.id ? 0 : -1}
        data-unit-id={unit.id}
        ref={(element) => register(unit.id, element)}
        className={`unit-row${node.dimmed ? ' dimmed' : ''}${selectedId === unit.id ? ' selected' : ''}`}
      >
        {hasChildren ? (
          <button type="button" tabIndex={-1} className="unit-caret" aria-label={t('adm.orgUnit.tree.expand.label', { name: unit.name })} onClick={() => onToggle(unit.id)}>
            {open ? '▾' : '▸'}
          </button>
        ) : (
          <span className="unit-caret" aria-hidden="true" />
        )}
        <button type="button" tabIndex={-1} className="unit-select" onClick={() => onSelect(unit.id)}>
          <span id={`unit-label-${unit.id}`}>
            <span className="badge">{unit.code}</span> <span className="unit-name">{unit.name}</span>
          </span>
        </button>
        {/* A space between the parts of a row is not drawn (the row is a flex container) but it is in the text, so that the visible text reads as the name does. */}{' '}
        <span id={`unit-status-${unit.id}`}>
          <StatusPill tone={unit.status === 'Active' ? 'success' : 'neutral'}>{statusLabel(t, unit.status)}</StatusPill>
        </span>
        {node.successor === undefined ? null : (
          <>
            {' '}
            <button type="button" tabIndex={-1} className="unit-successor" id={`unit-successor-${unit.id}`} onClick={() => onSelect(node.successor?.id ?? unit.id)}>
              {t('adm.orgUnit.node.successor.label', { name: node.successor.name })}
            </button>
          </>
        )}
      </div>
      {showsGroup ? (
        <ul role="group" id={groupId}>
          {node.children.map((child) => (
            <NodeView key={child.unit.id} node={child} forest={forest} expanded={expanded} onToggle={onToggle} selectedId={selectedId} onSelect={onSelect} focusedId={focusedId} register={register} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

/**
 * The organisation tree as an ARIA tree: arrow keys move through the visible units, Right opens or enters, Left closes or
 * goes to the parent, Home and End jump to the ends, Enter and Space select. Only the focused unit is in the tab order.
 */
export function UnitTree({ forest, expanded, onToggle, selectedId, onSelect }: UnitTreeProps) {
  const { t } = useTranslation();
  const visible = visibleNodes(forest, expanded);
  const [focusedId, setFocusedId] = useState<string | undefined>(undefined);
  const elements = useRef(new Map<string, HTMLDivElement>());
  const moveFocus = useRef(false);
  const current = visible.some((node) => node.unit.id === focusedId) ? focusedId : (visible.find((node) => node.unit.id === selectedId) ?? visible[0])?.unit.id;

  useEffect(() => {
    if (moveFocus.current && current !== undefined) elements.current.get(current)?.focus();
    moveFocus.current = false;
  }, [current]);

  const register = (unitId: string, element: HTMLDivElement | null): void => {
    if (element === null) elements.current.delete(unitId);
    else elements.current.set(unitId, element);
  };

  // A click makes that unit the one the arrow keys continue from, without moving DOM focus off the clicked control.
  const clickSelect = (unitId: string): void => {
    setFocusedId(unitId);
    onSelect(unitId);
  };
  const clickToggle = (unitId: string): void => {
    setFocusedId(unitId);
    onToggle(unitId);
  };

  const focus = (unitId: string | undefined): void => {
    if (unitId === undefined) return;
    moveFocus.current = true;
    setFocusedId(unitId);
    // The effect only runs when the focused id changes; focusing the already focused element is done here.
    if (unitId === current) elements.current.get(unitId)?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLUListElement>): void => {
    const index = visible.findIndex((node) => node.unit.id === current);
    const node = visible[index];
    if (node === undefined) return;
    const opens = node.children.length > 0;
    switch (event.key) {
      case 'ArrowDown':
        focus(visible[Math.min(index + 1, visible.length - 1)]?.unit.id);
        break;
      case 'ArrowUp':
        focus(visible[Math.max(index - 1, 0)]?.unit.id);
        break;
      case 'Home':
        focus(visible[0]?.unit.id);
        break;
      case 'End':
        focus(visible[visible.length - 1]?.unit.id);
        break;
      case 'ArrowRight':
        if (opens && !expanded.has(node.unit.id)) onToggle(node.unit.id);
        else if (opens) focus(node.children[0]?.unit.id);
        break;
      case 'ArrowLeft':
        if (opens && expanded.has(node.unit.id)) onToggle(node.unit.id);
        else focus(visible.slice(0, index).reverse().find((candidate) => candidate.children.some((child) => child.unit.id === node.unit.id))?.unit.id);
        break;
      case 'Enter':
      case ' ':
        onSelect(node.unit.id);
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  return (
    <ul role="tree" className="unit-tree" aria-label={t('adm.orgUnit.tree.label')} onKeyDown={onKeyDown}>
      {forest.map((node) => (
        <NodeView key={node.unit.id} node={node} forest={forest} expanded={expanded} onToggle={clickToggle} selectedId={selectedId} onSelect={clickSelect} focusedId={current} register={register} />
      ))}
    </ul>
  );
}
