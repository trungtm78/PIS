// Mounts the owner's dashboard (template/engine.js, template/viz.js: generated from the template, see scripts/dashboard/import-template.mjs) inside one element of a screen.
// The template draws a page of 1280 x 720 and scales it to its window; here it scales to the width of its host, and to the whole screen while the host is shown full screen.
import * as d3 from 'd3';
import { E } from './engine.js';
import { createViz } from './viz.js';
import './dash.css';

const PAGE_WIDTH = 1280;
const PAGE_HEIGHT = 720;
/** Below this the figures cannot be read: a narrow host scrolls sideways inside its own box instead of shrinking further. */
const MIN_SCALE = 0.6;

export function mountDashboard(host, db, options = {}) {
  const stage = document.createElement('div');
  stage.className = 'dash9';
  host.replaceChildren(stage);
  const viz = createViz(d3, E, db, stage);
  let current = 0;

  const fit = () => {
    const page = stage.querySelector('.pg');
    if (page === null) return;
    const full = document.fullscreenElement === host;
    const scale = full ? Math.min(window.innerWidth / PAGE_WIDTH, window.innerHeight / PAGE_HEIGHT) : Math.max(MIN_SCALE, (host.clientWidth || PAGE_WIDTH) / PAGE_WIDTH);
    page.style.transformOrigin = '0 0';
    page.style.transform = `scale(${scale})`;
    stage.style.width = `${PAGE_WIDTH * scale}px`;
    stage.style.height = `${PAGE_HEIGHT * scale}px`;
  };
  const go = (index, announce = true) => {
    current = Math.max(0, Math.min(viz.count - 1, index));
    // Drawing a page replaces every element of the board, the focused tab included: the focus is put back on the tab of the page, or the arrow keys would stop reaching the board.
    const focused = host.contains(document.activeElement);
    viz.render(current);
    fit();
    if (focused) (stage.querySelector("[data-pg][aria-selected=\"true\"]") ?? host).focus({ preventScroll: true });
    if (announce) options.onPage?.(current);
  };
  const pageOf = (target) => { const tab = target instanceof Element ? target.closest('[data-pg]') : null; return tab === null ? undefined : Number(tab.getAttribute('data-pg')); };
  const onClick = (event) => { const page = pageOf(event.target); if (page !== undefined) go(page); };
  const onKey = (event) => {
    if (event.key === 'ArrowRight' || event.key === 'PageDown') { event.preventDefault(); go(current + 1); }
    else if (event.key === 'ArrowLeft' || event.key === 'PageUp') { event.preventDefault(); go(current - 1); }
    else if (event.key === 'Enter' || event.key === ' ') { const page = pageOf(event.target); if (page !== undefined) { event.preventDefault(); go(page); } }
  };
  host.addEventListener('click', onClick);
  host.addEventListener('keydown', onKey);
  window.addEventListener('resize', fit);
  document.addEventListener('fullscreenchange', fit);
  const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(fit);
  observer?.observe(host);

  go(options.page ?? 0, false);
  return {
    count: viz.count,
    names: viz.names,
    go: (index) => go(index, false),
    dispose() {
      host.removeEventListener('click', onClick);
      host.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', fit);
      document.removeEventListener('fullscreenchange', fit);
      observer?.disconnect();
      host.replaceChildren();
    },
  };
}
