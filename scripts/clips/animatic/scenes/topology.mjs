// The node-and-link diagram behind the platform scene (it builds up) and the service-flow scene (a request travels through it).
import { GLYPH, appear, captionHtml, clamp01, easeInOut, el, esc, heading, icon, num, pill, ramp, stage } from './kit.mjs';

const ARROW = 14;

export function anchor(node, side) {
  switch (side) {
    case 'left':
      return { x: node.x, y: node.y + node.h / 2 };
    case 'right':
      return { x: node.x + node.w, y: node.y + node.h / 2 };
    case 'top':
      return { x: node.x + node.w / 2, y: node.y };
    default:
      return { x: node.x + node.w / 2, y: node.y + node.h };
  }
}

/** The corners of a link: an orthogonal route between two nodes, or the points the data gives. */
export function routeOf(link, byId) {
  if (Array.isArray(link.points) && link.points.length >= 2) return link.points.map(([x, y]) => ({ x, y }));
  const from = byId.get(link.from);
  const to = byId.get(link.to);
  if (from === undefined || to === undefined) throw new Error(`link ${link.from} -> ${link.to} names a node that is not there`);
  const dx = to.x + to.w / 2 - (from.x + from.w / 2);
  const dy = to.y + to.h / 2 - (from.y + from.h / 2);
  const horizontal = link.route === undefined ? Math.abs(dx) >= Math.abs(dy) : link.route === 'h';
  const raw = [];
  if (horizontal) {
    const start = anchor(from, dx >= 0 ? 'right' : 'left');
    const end = anchor(to, dx >= 0 ? 'left' : 'right');
    const mid = start.x + (end.x - start.x) * (link.mid ?? 0.5);
    raw.push(start, { x: mid, y: start.y }, { x: mid, y: end.y }, end);
  } else {
    const start = anchor(from, dy >= 0 ? 'bottom' : 'top');
    const end = anchor(to, dy >= 0 ? 'top' : 'bottom');
    const mid = start.y + (end.y - start.y) * (link.mid ?? 0.5);
    raw.push(start, { x: start.x, y: mid }, { x: end.x, y: mid }, end);
  }
  const distinct = raw.filter((point, index) => index === 0 || point.x !== raw[index - 1].x || point.y !== raw[index - 1].y);
  // A point in the middle of a straight run is not a corner.
  return distinct.filter((point, index) => index === 0 || index === distinct.length - 1 || !((distinct[index - 1].x === point.x && point.x === distinct[index + 1].x) || (distinct[index - 1].y === point.y && point.y === distinct[index + 1].y)));
}

export function lengthOf(points) {
  let total = 0;
  for (let index = 1; index < points.length; index += 1) total += Math.hypot(points[index].x - points[index - 1].x, points[index].y - points[index - 1].y);
  return total;
}

/** The point at fraction `u` of the length of a polyline, and the direction of the segment there. */
export function pointAt(points, u) {
  const wanted = clamp01(u) * lengthOf(points);
  let walked = 0;
  for (let index = 1; index < points.length; index += 1) {
    const from = points[index - 1];
    const to = points[index];
    const segment = Math.hypot(to.x - from.x, to.y - from.y);
    if (walked + segment >= wanted || index === points.length - 1) {
      const f = segment === 0 ? 0 : (wanted - walked) / segment;
      return { x: from.x + (to.x - from.x) * f, y: from.y + (to.y - from.y) * f, angle: Math.atan2(to.y - from.y, to.x - from.x) };
    }
    walked += segment;
  }
  return { x: points[0].x, y: points[0].y, angle: 0 };
}

/** The first part of a polyline, as an SVG path (the link being drawn). */
export function partialPath(points, u) {
  const wanted = clamp01(u) * lengthOf(points);
  let walked = 0;
  let d = `M${num(points[0].x)} ${num(points[0].y)}`;
  for (let index = 1; index < points.length; index += 1) {
    const from = points[index - 1];
    const to = points[index];
    const segment = Math.hypot(to.x - from.x, to.y - from.y);
    if (walked + segment <= wanted) {
      d += ` L${num(to.x)} ${num(to.y)}`;
      walked += segment;
    } else {
      const f = segment === 0 ? 0 : (wanted - walked) / segment;
      d += ` L${num(from.x + (to.x - from.x) * f)} ${num(from.y + (to.y - from.y) * f)}`;
      break;
    }
  }
  return d;
}

function arrowHead(points, colour) {
  const tip = points[points.length - 1];
  const { angle } = pointAt(points, 1);
  const left = { x: tip.x - ARROW * Math.cos(angle - 0.45), y: tip.y - ARROW * Math.sin(angle - 0.45) };
  const right = { x: tip.x - ARROW * Math.cos(angle + 0.45), y: tip.y - ARROW * Math.sin(angle + 0.45) };
  return `<polygon points="${num(tip.x)},${num(tip.y)} ${num(left.x)},${num(left.y)} ${num(right.x)},${num(right.y)}" fill="${colour}"/>`;
}

export const linkId = (link) => link.id ?? `${link.from}-${link.to}`;

/** The checks both scenes run on their data; they return problems as text instead of throwing, so a test can list them all. */
export function topologyProblems(data) {
  const problems = [];
  const ids = new Set();
  for (const node of data.nodes ?? []) {
    if (ids.has(node.id)) problems.push(`node ${node.id} is twice`);
    ids.add(node.id);
    for (const key of ['x', 'y', 'w', 'h']) if (typeof node[key] !== 'number') problems.push(`node ${node.id}: ${key} is not a number`);
    if (typeof node.label !== 'string' || node.label === '') problems.push(`node ${node.id}: label is missing`);
    if (node.x + node.w > 1920 || node.y + node.h > 1080) problems.push(`node ${node.id} is outside the 1920x1080 frame`);
  }
  for (const link of data.links ?? []) {
    if (link.points === undefined && (!ids.has(link.from) || !ids.has(link.to))) problems.push(`link ${link.from} -> ${link.to} names a node that is not there`);
  }
  for (const step of data.steps ?? []) {
    if (!(data.links ?? []).some((link) => linkId(link) === step.link)) problems.push(`step uses the link ${step.link}, which is not in the data`);
  }
  return problems;
}


function nodeHtml(node, t, state) {
  const shown = state.reveal(node);
  const lit = state.lit(node);
  const kind = node.kind ?? 'service';
  const classes = ['node', `node--${kind}`, state.visited(node) ? 'is-visited' : '', lit > 0 ? 'is-lit' : ''].filter(Boolean).join(' ');
  const badge = node.edition === undefined ? '' : el('span', 'node__badge', {}, esc(state.labels.enterpriseBadge ?? node.edition));
  const body =
    (node.icon === null ? '' : el('span', 'node__icon', {}, icon(node.icon ?? 'cog', 38))) +
    el('span', 'node__text', {}, el('span', 'node__label', {}, esc(node.label)) + (node.sub === undefined ? '' : el('span', 'node__sub', {}, esc(node.sub)))) +
    badge;
  const glow = lit > 0 ? `0 0 0 ${num(6 + lit * 8)}px rgba(47,181,168,${num(0.12 + lit * 0.2)})` : undefined;
  return el('div', classes, { left: `${node.x}px`, top: `${node.y}px`, width: `${node.w}px`, height: `${node.h}px`, ...appear(t, shown, { dur: 520, rise: 22 }), 'box-shadow': glow }, body);
}

function linksSvg(links, byId, t, state) {
  const parts = links.map((link) => {
    const points = routeOf(link, byId);
    const progress = state.linkProgress(link, points);
    if (progress <= 0) return '';
    const active = state.linkActive(link);
    const colour = active ? 'var(--mv-color-primary)' : state.linkDone(link) ? 'var(--mv-color-selected-bar)' : 'var(--mv-color-chart-plan)';
    const width = active ? 7 : 4;
    const dash = link.dashed === true ? ' stroke-dasharray="14 10"' : '';
    const path = `<path d="${partialPath(points, progress)}" fill="none" stroke="${colour}" stroke-width="${width}" stroke-linejoin="round" stroke-linecap="round"${dash}/>`;
    const head = progress >= 0.999 ? arrowHead(points, colour) : '';
    let label = '';
    if (link.label !== undefined && progress >= 0.999) {
      const mid = pointAt(points, 0.5);
      const fade = state.linkLabelOpacity(link);
      const text = esc(link.label);
      const width2 = 22 + link.label.length * 11.5;
      label = `<g opacity="${num(fade)}"><rect x="${num(mid.x - width2 / 2)}" y="${num(mid.y - 20)}" width="${num(width2)}" height="40" rx="20" fill="var(--mv-color-surface)" stroke="var(--mv-color-border)" stroke-width="2"/><text x="${num(mid.x)}" y="${num(mid.y + 7)}" text-anchor="middle" font-size="20" font-weight="600" fill="var(--mv-color-text-secondary)">${text}</text></g>`;
    }
    return path + head + label;
  });
  return `<svg class="links" width="1920" height="1080" viewBox="0 0 1920 1080" aria-hidden="true">${parts.join('')}</svg>`;
}

function packetsSvg(data, byId, t) {
  const out = [];
  for (const step of data.steps ?? []) {
    if (t < step.at || t > step.at + step.dur) continue;
    const link = data.links.find((candidate) => linkId(candidate) === step.link);
    const points = routeOf(link, byId);
    const u = easeInOut((t - step.at) / step.dur);
    const spot = pointAt(points, u);
    const trail = pointAt(points, Math.max(0, u - 0.06));
    out.push(`<line x1="${num(trail.x)}" y1="${num(trail.y)}" x2="${num(spot.x)}" y2="${num(spot.y)}" stroke="var(--mv-color-focus-on-dark)" stroke-width="10" stroke-linecap="round" opacity="0.5"/>`);
    out.push(`<circle cx="${num(spot.x)}" cy="${num(spot.y)}" r="16" fill="var(--mv-color-primary)" stroke="var(--mv-color-surface)" stroke-width="5"/>`);
    if (step.packet !== undefined) {
      const w = 28 + step.packet.length * 12;
      out.push(`<g><rect x="${num(spot.x - w / 2)}" y="${num(spot.y - 62)}" width="${num(w)}" height="38" rx="10" fill="var(--mv-color-sidebar)"/><text x="${num(spot.x)}" y="${num(spot.y - 36)}" text-anchor="middle" font-size="20" font-weight="600" fill="var(--mv-color-menu-text)">${esc(step.packet)}</text></g>`);
    }
  }
  return `<svg class="links links--top" width="1920" height="1080" viewBox="0 0 1920 1080" aria-hidden="true">${out.join('')}</svg>`;
}

function legendHtml(data, t) {
  if (!Array.isArray(data.legend) || data.legend.length === 0) return '';
  const items = data.legend.map((entry) => el('span', 'legend__item', {}, pill(entry.tone ?? 'neutral', entry.label, entry.glyph ?? ''))).join('');
  return el('div', 'legend', appear(t, data.legendAt ?? 0, { dur: 600 }), items);
}

/** The platform scene: nodes appear in the order of their `at`, each link is drawn when both of its ends are there. */
export function renderPlatform(data, t) {
  const byId = new Map(data.nodes.map((node) => [node.id, node]));
  const state = {
    labels: data.labels ?? {},
    reveal: (node) => node.at ?? 0,
    visited: () => false,
    lit: () => 0,
    linkProgress: (link) => {
      const start = Math.max(byId.get(link.from)?.at ?? 0, byId.get(link.to)?.at ?? 0, link.at ?? 0) + 350;
      return ramp(t, start, link.drawMs ?? 700, easeInOut);
    },
    linkActive: () => false,
    linkDone: () => true,
    linkLabelOpacity: (link) => ramp(t, Math.max(byId.get(link.from)?.at ?? 0, byId.get(link.to)?.at ?? 0, link.at ?? 0) + 1000, 400),
  };
  const nodes = data.nodes.map((node) => nodeHtml(node, t, state)).join('');
  return stage(data, t, heading(data, t) + linksSvg(data.links, byId, t, state) + nodes + legendHtml(data, t) + captionHtml(data.captions, t));
}

/** The service-flow scene: the diagram is there from the start and a request travels along the links in the order of `steps`. */
export function renderFlow(data, t) {
  const byId = new Map(data.nodes.map((node) => [node.id, node]));
  const linkOf = (id) => data.links.find((link) => linkId(link) === id);
  const stepsOf = (link) => (data.steps ?? []).filter((step) => step.link === linkId(link));
  const arrivals = (node) => (data.steps ?? []).filter((step) => linkOf(step.link).to === node.id);
  const departures = (node) => (data.steps ?? []).filter((step) => linkOf(step.link).from === node.id);
  const state = {
    labels: data.labels ?? {},
    reveal: (node) => (node.at ?? 0),
    visited: (node) => arrivals(node).some((step) => t >= step.at + step.dur) || (arrivals(node).length === 0 && departures(node).some((step) => t >= step.at)),
    lit: (node) => {
      let best = 0;
      for (const step of arrivals(node)) {
        const end = step.at + step.dur;
        if (t >= end && t < end + 1400) best = Math.max(best, 1 - (t - end) / 1400);
      }
      for (const step of departures(node)) if (t >= step.at && t < step.at + 500) best = Math.max(best, 1 - (t - step.at) / 500);
      return best;
    },
    linkProgress: (link) => ramp(t, Math.max(byId.get(link.from)?.at ?? 0, byId.get(link.to)?.at ?? 0) + 200, 500),
    linkActive: (link) => stepsOf(link).some((step) => t >= step.at && t <= step.at + step.dur),
    linkDone: (link) => stepsOf(link).some((step) => t > step.at + step.dur),
    linkLabelOpacity: (link) => (stepsOf(link).some((step) => t >= step.at) ? 1 : 0.55),
  };
  const nodes = data.nodes.map((node) => nodeHtml(node, t, state)).join('');
  const live = (data.steps ?? []).find((step) => t >= step.at && t < step.at + step.dur + (step.holdMs ?? 700));
  const captions = live === undefined || live.caption === undefined ? data.captions : [{ from: live.at, to: live.at + live.dur + (live.holdMs ?? 700), text: live.caption }];
  const counter = (data.steps ?? []).findIndex((step) => step === live);
  const stepMark = live === undefined ? '' : el('div', 'stepmark', {}, `${GLYPH.arrow} ${counter + 1}/${data.steps.length}`);
  return stage(data, t, heading(data, t) + linksSvg(data.links, byId, t, state) + nodes + packetsSvg(data, byId, t) + stepMark + captionHtml(captions, t));
}
