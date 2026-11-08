// The "Cay tien do" explainer: the tree of procurement states with package counts, a click on a node (side panel with its packages),
// a click on a package (stepper, day strip and day-by-day timeline). The look follows apps/web/src/ui/ProcessTree.tsx, Stepper.tsx,
// DayStrip.tsx and Timeline.tsx (docs/process-tree-design.md): same cards, stripes, pills and rows, drawn at video scale.
import { GLYPH, appear, cursorHtml, easeInOut, el, esc, heading, num, pill, ramp, requireFields, stage } from './kit.mjs';
import { anchor, partialPath, pointAt, routeOf } from './topology.mjs';

export const kind = 'progress-tree';

const GEOMETRY = { x0: 60, y0: 300, pitchX: 256, pitchY: 270, w: 204, h: 216 };
const PANEL = { x: 1320, y: 170, w: 540, h: 830, rowY: 520, rowH: 92 };
const TIMELINE_ROW_HEIGHT = { day: 40, entry: 62, gap: 46 };
const TIMELINE_BUDGET = 490;
const TONE_OF_HEALTH = { ok: 'success', attention: 'warning', late: 'danger', hold: 'neutral' };
const GLYPH_OF_HEALTH = { ok: GLYPH.ok, attention: GLYPH.attention, late: GLYPH.late, hold: GLYPH.hold };

export function problems(data) {
  const found = requireFields(data, kind, ['title', 'durationMs', 'nodes', 'edges', 'phases', 'select', 'panel', 'package', 'labels', 'health']);
  if (found.length > 0) return found;
  const ids = new Set(data.nodes.map((node) => node.id));
  if (!ids.has(data.select)) found.push(`progress-tree: the selected node ${data.select} is not in the nodes`);
  for (const edge of data.edges) if (!ids.has(edge.from) || !ids.has(edge.to)) found.push(`progress-tree: edge ${edge.from} -> ${edge.to} names a node that is not there`);
  for (const node of data.nodes) {
    if (node.count !== null && !Number.isInteger(node.count)) found.push(`progress-tree: node ${node.id} has a count that is not a whole number`);
    if (!Object.hasOwn(data.health, node.health ?? 'ok')) found.push(`progress-tree: node ${node.id} has the unknown health ${node.health}`);
  }
  const { tree, select, package: open } = data.phases;
  if (!(tree < select && select < open && open < data.durationMs)) found.push('progress-tree: the phases must come in the order tree, select, package, end');
  const used = data.package.timeline.reduce((sum, row) => sum + TIMELINE_ROW_HEIGHT[row.type], 0);
  if (used > TIMELINE_BUDGET) found.push(`progress-tree: the timeline needs ${used}px and the board has ${TIMELINE_BUDGET}px`);
  return found;
}

const nodeBox = (node) => ({ id: node.id, x: GEOMETRY.x0 + (node.col ?? 0) * GEOMETRY.pitchX, y: GEOMETRY.y0 + (node.row ?? 0) * GEOMETRY.pitchY, w: GEOMETRY.w, h: GEOMETRY.h });

/** The route of an edge of the flow: forward edges run across or down, a return edge makes a U below the cards. */
export function edgePoints(edge, boxes) {
  const from = boxes.get(edge.from);
  const to = boxes.get(edge.to);
  if (edge.kind === 'return') {
    const start = { ...anchor(from, 'bottom'), x: from.x + from.w / 2 - 36 };
    const end = { ...anchor(to, 'bottom'), x: to.x + to.w / 2 + 36 };
    const low = start.y + 30;
    return [start, { x: start.x, y: low }, { x: end.x, y: low }, end];
  }
  return routeOf({ from: edge.from, to: edge.to, route: from.y === to.y ? 'h' : 'v' }, boxes);
}

function nodeHtml(node, t, ctx) {
  const box = ctx.boxes.get(node.id);
  const at = ctx.reveal(node);
  const selected = node.id === ctx.data.select && t >= ctx.selectedFrom;
  const count = node.count === null ? '?' : String(Math.round(node.count * ramp(t, at + 150, 900)));
  const health = node.health ?? 'ok';
  const late = node.lateCount !== undefined && node.lateCount > 0 ? `<small class="pt-late">${esc(ctx.labels.late.replace('{n}', node.lateCount))}</small>` : '';
  const empty = node.count === 0;
  const classes = ['pt-node', `pt-node--${health}`, selected ? 'is-selected' : '', node.terminal === true ? 'is-terminal' : '', empty ? 'is-empty' : ''].filter(Boolean).join(' ');
  const share = node.share === undefined || node.share === null ? 0 : node.share;
  const value = node.value === undefined ? '' : el('span', 'pt-node__meta', {}, esc(`${node.value} ${node.unit ?? ''}`.trim()));
  const median = node.medianDays === undefined || node.medianDays === null ? '' : el('span', 'pt-node__meta', {}, esc(ctx.labels.median.replace('{n}', node.medianDays)));
  const inner =
    el('span', 'pt-node__title', {}, esc(node.label)) +
    el('span', 'pt-node__count', {}, `${count}<small>${esc(ctx.labels.packages)}</small>${late}`) +
    el('span', 'pt-node__bar', {}, el('i', '', { width: `${num(share * 100 * ramp(t, at + 300, 900))}%` })) +
    value +
    median +
    (node.health === undefined || empty ? '' : pill(TONE_OF_HEALTH[health], ctx.data.health[health], GLYPH_OF_HEALTH[health]));
  const dim = ctx.dimOthers && node.id !== ctx.data.select && !ctx.neighbours.has(node.id) ? 0.55 : 1;
  const style = { left: `${box.x}px`, top: `${box.y}px`, width: `${box.w}px`, height: `${box.h}px`, ...appear(t, at, { dur: 520, rise: 20 }) };
  style.opacity = style.opacity * dim;
  return el('div', classes, style, inner);
}

function edgesSvg(t, ctx) {
  const maxCount = Math.max(1, ...ctx.data.edges.map((edge) => edge.count));
  const parts = ctx.data.edges.map((edge) => {
    const points = edgePoints(edge, ctx.boxes);
    const at = Math.max(ctx.reveal(ctx.nodeById.get(edge.from)), ctx.reveal(ctx.nodeById.get(edge.to))) + 250;
    const progress = ramp(t, at, 700, easeInOut);
    if (progress <= 0) return '';
    const touches = edge.from === ctx.data.select || edge.to === ctx.data.select;
    const strong = ctx.dimOthers ? (touches ? 1 : 0.35) : 1;
    const width = 3 + (edge.count / maxCount) * 11;
    const dash = edge.kind === 'return' ? 'stroke-dasharray="16 10"' : edge.kind === 'drop' ? 'stroke-dasharray="4 10"' : '';
    const colour = touches && ctx.dimOthers ? 'var(--mv-color-primary)' : 'var(--mv-color-chart-plan)';
    const path = `<path d="${partialPath(points, progress)}" fill="none" stroke="${colour}" stroke-width="${num(width)}" stroke-linecap="round" stroke-linejoin="round" ${dash} opacity="${num(strong)}"/>`;
    if (progress < 0.999) return path;
    const tip = points[points.length - 1];
    const { angle } = pointAt(points, 1);
    const size = 12 + width;
    const head = `<polygon points="${num(tip.x)},${num(tip.y)} ${num(tip.x - size * Math.cos(angle - 0.5))},${num(tip.y - size * Math.sin(angle - 0.5))} ${num(tip.x - size * Math.cos(angle + 0.5))},${num(tip.y - size * Math.sin(angle + 0.5))}" fill="${colour}" opacity="${num(strong)}"/>`;
    const mid = pointAt(points, 0.5);
    // The label sits beside its line, never on it: above a forward line, on a return or drop path, right of a vertical one.
    const vertical = Math.abs(Math.sin(mid.angle)) > 0.5;
    const shift = vertical ? { x: 44, y: 0 } : { x: 0, y: edge.kind === 'forward' ? -34 : 0 };
    mid.x += shift.x;
    mid.y += shift.y;
    const text = esc(edge.label ?? String(edge.count));
    const w = 26 + text.length * 11;
    const label = `<g opacity="${num(strong * ramp(t, at + 800, 400))}"><rect x="${num(mid.x - w / 2)}" y="${num(mid.y - 18)}" width="${num(w)}" height="36" rx="18" fill="var(--mv-color-surface)" stroke="var(--mv-color-border)" stroke-width="2"/><text x="${num(mid.x)}" y="${num(mid.y + 7)}" text-anchor="middle" font-size="19" font-weight="600" fill="var(--mv-color-text-secondary)">${text}</text></g>`;
    return path + head + label;
  });
  return `<svg class="links" width="1920" height="1080" viewBox="0 0 1920 1080" aria-hidden="true">${parts.join('')}</svg>`;
}

function panelHtml(t, ctx) {
  const { data, labels } = ctx;
  const node = ctx.nodeById.get(data.select);
  const u = ramp(t, data.phases.select + 350, 650);
  if (u <= 0) return '';
  const tabs = labels.tabs.map((tab, index) => el('span', `pt-tab${index === 1 ? ' is-active' : ''}`, {}, esc(tab))).join('');
  const stats = data.panel.stats.map((stat) => el('div', 'pt-stat', {}, el('b', '', {}, esc(stat.value)) + el('span', '', {}, esc(stat.label)))).join('');
  const head = labels.columns.map((column) => el('span', '', {}, esc(column))).join('');
  const rows = data.panel.rows
    .map((row, index) => {
      const row0 = appear(t, data.phases.select + 1200 + index * 260, { dur: 450, rise: 12 });
      const hot = index === data.panel.open && t >= data.phases.package - 700;
      return el(
        'div',
        `pt-row${hot ? ' is-hot' : ''}`,
        { ...row0, top: `${PANEL.rowY - PANEL.y + index * PANEL.rowH}px` },
        el('span', 'pt-row__name', {}, el('b', '', {}, esc(row.code)) + el('em', '', {}, esc(row.name))) +
          el('span', 'pt-row__value', {}, esc(row.value)) +
          el('span', 'pt-row__days', {}, esc(row.days)) +
          el('span', 'pt-row__due', {}, pill(row.tone, row.due, GLYPH_OF_HEALTH[row.tone === 'danger' ? 'late' : row.tone === 'warning' ? 'attention' : 'ok'])),
      );
    })
    .join('');
  const style = { left: `${PANEL.x}px`, top: `${PANEL.y}px`, width: `${PANEL.w}px`, height: `${PANEL.h}px`, opacity: u * (1 - ramp(t, data.phases.package, 450)), transform: `translateX(${num((1 - u) * 60)}px)` };
  return el(
    'aside',
    'pt-panel',
    style,
    el('div', 'pt-panel__head', {}, el('h2', '', {}, esc(`${node.label}`)) + el('div', 'pt-panel__sub', {}, `${esc(`${node.count} ${labels.packages}`)} ${pill(TONE_OF_HEALTH[node.health], data.health[node.health], GLYPH_OF_HEALTH[node.health])}`)) +
      el('div', 'pt-tabs', {}, tabs) +
      el('div', 'pt-stats', {}, stats) +
      el('div', 'pt-table-head', {}, head) +
      rows,
  );
}

function stepperHtml(t, ctx, at) {
  const pkg = ctx.data.package;
  const { labels } = ctx;
  const count = pkg.steps.length;
  const pitch = 1660 / (count - 1);
  const dots = pkg.steps
    .map((step, index) => {
      const x = 130 + index * pitch;
      const appearAt = at + index * 140;
      const mark = step.state === 'done' ? GLYPH.ok : step.state === 'late' ? GLYPH.late : step.state === 'here' ? '' : String(index + 1);
      const planned = step.planned === undefined ? '' : `${labels.planned} ${step.planned}`;
      const sub = step.actual === undefined ? planned : `${planned} · ${labels.actual} ${step.actual}`;
      return el(
        'div',
        `pt-step pt-step--${step.state}`,
        { left: `${num(x - 110)}px`, ...appear(t, appearAt, { dur: 450, rise: 10 }) },
        el('span', 'pt-step__dot', {}, mark) + el('span', 'pt-step__name', {}, esc(step.label)) + el('span', 'pt-step__days', {}, esc(sub)),
      );
    })
    .join('');
  const hereIndex = pkg.steps.findIndex((step) => step.state === 'here' || step.state === 'late');
  const filled = hereIndex < 0 ? 1 : hereIndex / (count - 1);
  const rail = `<div class="pt-rail"><i style="width:${num(filled * 100 * ramp(t, at, 1000))}%"></i></div>`;
  return el('div', 'pt-stepper', { top: '285px' }, rail + dots);
}

function stripHtml(t, ctx, at) {
  const strip = ctx.data.package.strip;
  const cells = [];
  for (let index = 0; index < strip.cells; index += 1) {
    const weekend = (strip.startWeekday + index) % 7 >= 5;
    const changed = strip.changes.includes(index);
    const deadline = strip.deadlines.includes(index);
    const today = index === strip.cells - 1;
    const classes = ['pt-cell', weekend ? 'is-weekend' : '', changed ? 'is-changed' : '', deadline ? 'is-deadline' : '', today ? 'is-today' : ''].filter(Boolean).join(' ');
    const mark = deadline ? '⚑' : changed ? '•' : '';
    cells.push(el('span', classes, { opacity: ramp(t, at + index * 28, 260) }, mark));
  }
  const legend = ctx.labels.strip.map((item) => el('span', 'pt-strip__legend', {}, esc(item))).join('');
  return el('div', 'pt-strip', { top: '462px' }, el('div', 'pt-strip__cells', {}, cells.join('')) + el('div', 'pt-strip__legends', { opacity: ramp(t, at + 900, 400) }, legend));
}

function timelineHtml(t, ctx, at) {
  const rows = ctx.data.package.timeline;
  let top = 0;
  const html = rows.map((row, index) => {
    const style = { top: `${top}px`, ...appear(t, at + index * 330, { dur: 450, rise: 12 }) };
    top += TIMELINE_ROW_HEIGHT[row.type];
    if (row.type === 'day') return el('div', 'pt-day', style, esc(row.label) + el('span', '', {}, esc(row.count)));
    if (row.type === 'gap') return el('div', 'pt-gap', style, el('span', '', {}, esc(row.text)));
    const title = row.from === undefined ? esc(row.text) : `${esc(row.lead)} ${pill('info', row.from)} ${GLYPH.arrow} ${pill('success', row.to)}`;
    return el(
      'div',
      'pt-entry',
      style,
      el('span', 'pt-entry__time', {}, esc(row.time)) +
        el('span', `pt-entry__icon pt-entry__icon--${row.tone ?? 'info'}`, {}, esc(row.glyph ?? '•')) +
        el('span', 'pt-entry__main', {}, el('span', 'pt-entry__title', {}, title) + el('span', 'pt-entry__meta', {}, `${el('b', '', {}, esc(row.actor))} · ${esc(row.note)}`)),
    );
  });
  return el('div', 'pt-timeline', { top: '560px', height: `${TIMELINE_BUDGET}px` }, html.join(''));
}

function packagePage(t, ctx) {
  const { data, labels } = ctx;
  const pkg = data.package;
  const start = data.phases.package;
  const u = ramp(t, start + 250, 600);
  if (u <= 0) return '';
  const crumbs = `${esc(labels.breadcrumbRoot)} <span>›</span> ${esc(ctx.nodeById.get(data.select).label)} <span>›</span> <b>${esc(pkg.code)}</b>`;
  const header =
    el('div', 'pt-crumbs', {}, crumbs) +
    el('div', 'pt-package', {}, el('h2', '', {}, esc(`${pkg.code} · ${pkg.name}`)) + el('div', 'pt-package__meta', {}, `${esc(pkg.value)} · ${esc(pkg.method)} · ${esc(pkg.owner)}`));
  const status = el('div', 'pt-status', { top: '392px', ...appear(t, start + 1900, { dur: 500 }) }, el('b', '', {}, esc(pkg.status)) + el('div', 'pt-blocker', {}, `${GLYPH.attention} ${esc(pkg.blocker)}`));
  return el(
    'div',
    'pt-page',
    { opacity: u },
    header + stepperHtml(t, ctx, start + 600) + status + stripHtml(t, ctx, start + 2300) + timelineHtml(t, ctx, start + 3300),
  );
}

export function render(data, t) {
  const nodeById = new Map(data.nodes.map((node) => [node.id, node]));
  const boxes = new Map(data.nodes.map((node) => [node.id, nodeBox(node)]));
  const selectedFrom = data.phases.select;
  const neighbours = new Set(data.edges.filter((edge) => edge.from === data.select || edge.to === data.select).flatMap((edge) => [edge.from, edge.to]));
  const ctx = {
    data,
    labels: data.labels,
    boxes,
    nodeById,
    neighbours,
    selectedFrom,
    dimOthers: t >= selectedFrom && t < data.phases.package,
    reveal: (node) => data.phases.tree + (node.col ?? 0) * 450 + (node.row ?? 0) * 200,
  };
  const treeFade = 1 - ramp(t, data.phases.package, 500);
  const nodes = data.nodes.map((node) => nodeHtml(node, t, ctx)).join('');
  const lane = el('div', 'pt-lane', appear(t, data.phases.tree, { dur: 600 }), esc(data.lane));
  const tree = el('div', 'pt-board', { opacity: treeFade }, lane + edgesSvg(t, ctx) + nodes);

  // The pointer: it comes to the node, clicks, goes to the package row of the panel, clicks.
  const nodeBoxOfSelect = boxes.get(data.select);
  const targetRowY = PANEL.rowY + data.panel.open * PANEL.rowH + PANEL.rowH / 2;
  const cursor = [
    { t: data.phases.select - 2200, x: 1500, y: 900 },
    { t: data.phases.select, x: nodeBoxOfSelect.x + nodeBoxOfSelect.w * 0.6, y: nodeBoxOfSelect.y + nodeBoxOfSelect.h * 0.5, click: true },
    { t: data.phases.package, x: PANEL.x + 220, y: targetRowY, click: true },
    { t: data.phases.package + 900, x: PANEL.x + 360, y: targetRowY + 40 },
  ];
  const contextStyle = appear(t, 300, { dur: 600 });
  contextStyle.opacity *= treeFade;
  const context = el('div', 'pt-context', contextStyle, esc(data.context ?? ''));
  const inner = heading(data, t) + context + tree + panelHtml(t, ctx) + packagePage(t, ctx) + el('div', 'pt-cursor', { opacity: 1 - ramp(t, data.phases.package + 900, 500) }, cursorHtml(cursor, t));
  return stage(data, t, inner);
}
