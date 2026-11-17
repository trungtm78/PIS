// Mounts the owner's dashboard (template/engine.js, template/viz.js: generated from the template, see scripts/dashboard/import-template.mjs) inside one element of a screen.
// The template draws a page of 1280 wide and scales it to its window; here it scales to the width of its host, and to the whole screen while the host is shown full screen.
//
// The chips at the top of a page are text in the template. Here each one opens a list of what its filter can be set to (template/filters.js), and a choice draws the
// whole board again from the part of the tables it leaves.
import * as d3 from 'd3';
import { E } from './engine.js';
import { CHIP_FILTER, allLabel, applyFilters, chipText, chosen, cleared, computable, emptyFilters, engineFor, isSet, optionsOf, scoped, withFilter } from './filters.js';
import { createViz } from './viz.js';
import './dash.css';
import './skin.css';

const PAGE_WIDTH = 1280;
// The page of the template is 720 high; inside the application it is given more height (template/skin.css), for the tabs at the top and the room between the tiles.
const PAGE_HEIGHT = 800;
/** Below this the figures cannot be read: a narrow host scrolls sideways inside its own box instead of shrinking further. */
const MIN_SCALE = 0.6;
/** What a page must never say: a figure the engine could not compute for the part of the tables it was given. */
const BROKEN = /NaN|undefined|Infinity/;
const NOT_ENOUGH = 'Không đủ dữ liệu cho lựa chọn này';
const CLEAR = 'Xóa lọc';

export function mountDashboard(host, db, options = {}) {
  const stage = document.createElement('div');
  stage.className = 'dash9';
  host.replaceChildren(stage);
  let filters = emptyFilters();
  /**
   * The charts of one kind of page for the filters of that kind. A page of investment is cut by the investment filters and a page of the 360° work by the 360°
   * filters; what a page shows of the other kind (the 360° tiles of the investment overview, the capital figures quoted on a 360° page) is of the whole tables, so a
   * filter that is not on the page never changes it. The charts are kept until the filters of their kind change.
   */
  const built = { inv: null, gov: null };
  const vizFor = (kind) => {
    const own = scoped(filters, kind);
    const id = JSON.stringify(own);
    if (built[kind]?.id !== id) built[kind] = { id, viz: createViz(d3, engineFor(E, db, own), applyFilters(db, own), stage) };
    return built[kind].viz;
  };
  const whole = vizFor('inv');
  const { count, names, modes } = whole;
  let current = 0;
  /** What is said beside the chips after a choice that could not be drawn. */
  let message = '';
  /** The open list: its element, the chip it hangs under, the filter it sets and the values of its options in order. */
  let menu = null;
  /** Whether the engine can compute a choice, by kind of page and choice: it was written for the whole tables and reads the first row of lists a small part can leave empty. */
  const usable = new Map();

  const fit = () => {
    const page = stage.querySelector('.pg');
    if (page === null) return;
    const full = document.fullscreenElement === host;
    const scale = full ? Math.min(window.innerWidth / PAGE_WIDTH, window.innerHeight / PAGE_HEIGHT) : Math.max(MIN_SCALE, (host.clientWidth || PAGE_WIDTH) / PAGE_WIDTH);
    page.style.transformOrigin = '0 0';
    page.style.transform = `scale(${scale})`;
    // Whole pixels, rounded down: a fraction of a pixel more than the host is wide would give the host a scroll bar.
    stage.style.width = `${Math.floor(PAGE_WIDTH * scale)}px`;
    stage.style.height = `${Math.floor(PAGE_HEIGHT * scale)}px`;
  };

  /** The kind of the page on screen. */
  const kindOfPage = () => modes[current];
  const chipOf = (key) => stage.querySelector(`[data-filter="${key}"]`);

  /** Makes the chips of the page that set a filter into buttons that say the choice, and adds the chip that clears the filters and the message of a refused choice. */
  const dress = () => {
    const band = stage.querySelector('.sl');
    if (band === null) return;
    const kind = kindOfPage();
    let last = null;
    for (const chip of band.querySelectorAll('.s')) {
      last = chip;
      const key = CHIP_FILTER[kind][(chip.firstChild?.textContent ?? '').replace(/:\s*$/, '')];
      const value = chip.querySelector('b');
      if (key === undefined || value === null) continue;
      chip.setAttribute('data-filter', key);
      chip.setAttribute('role', 'button');
      chip.setAttribute('tabindex', '0');
      chip.setAttribute('aria-haspopup', 'listbox');
      chip.setAttribute('aria-expanded', 'false');
      chip.classList.add('pick');
      chip.classList.toggle('set', filters[key] !== null);
      value.textContent = chipText(db, filters, key);
    }
    if (last === null) return;
    if (isSet(filters, kind)) {
      const clear = document.createElement('div');
      clear.className = 's clear';
      clear.setAttribute('data-clear', kind);
      clear.setAttribute('role', 'button');
      clear.setAttribute('tabindex', '0');
      clear.textContent = CLEAR;
      last.after(clear);
      last = clear;
    }
    if (message !== '') {
      const note = document.createElement('span');
      note.className = 'fmsg';
      note.setAttribute('role', 'status');
      note.textContent = message;
      last.after(note);
    }
  };

  /** Draws the page on screen; false when it cannot be drawn for the filters that are set, or says a figure that could not be computed for them. */
  const paint = () => {
    const kind = kindOfPage();
    try {
      vizFor(kind).render(current);
      return !(isSet(filters, kind) && BROKEN.test(stage.textContent ?? ''));
    } catch (error) {
      if (!isSet(filters, kind)) throw error;
      return false;
    }
  };
  /** Draws the page on screen. A page the filters leave too little for is drawn whole instead: its filters are cleared and a line beside the chips says so. */
  const draw = () => {
    menu = null;
    if (!paint()) {
      filters = cleared(filters, kindOfPage());
      message = NOT_ENOUGH;
      paint();
    }
    dress();
    fit();
  };
  const go = (index, announce = true) => {
    const next = Math.max(0, Math.min(count - 1, index));
    if (next !== current) message = '';
    current = next;
    // Drawing a page replaces every element of the board, the focused tab included: the focus is put back on the tab of the page, or the arrow keys would stop reaching the board.
    const focused = host.contains(document.activeElement);
    draw();
    if (focused) (stage.querySelector("[data-pg][aria-selected=\"true\"]") ?? host).focus({ preventScroll: true });
    if (announce) options.onPage?.(current);
  };

  /** Whether the engine can compute the page on screen for a choice: one run of the engine, nothing drawn, and the answer kept. */
  const canCompute = (state) => {
    const kind = kindOfPage();
    const id = `${kind}${JSON.stringify(scoped(state, kind))}`;
    if (!usable.has(id)) usable.set(id, computable(E, db, state, kind));
    return usable.get(id);
  };

  /**
   * Sets the filters and draws the page on screen again (the other pages are drawn when the reader turns to them). A choice the page cannot be drawn for is refused:
   * the board stays as it was, and a line beside the chips says so.
   */
  const choose = (next, focusKey) => {
    const before = filters;
    const kind = kindOfPage();
    filters = next;
    message = '';
    menu = null;
    if (!canCompute(next) || !paint()) {
      usable.set(`${kind}${JSON.stringify(scoped(next, kind))}`, false);
      filters = before;
      message = NOT_ENOUGH;
      paint();
    }
    dress();
    fit();
    (chipOf(focusKey) ?? stage.querySelector('.sl [role="button"]') ?? host).focus({ preventScroll: true });
  };

  const closeMenu = (refocus = false) => {
    if (menu === null) return;
    const { element, chip } = menu;
    menu = null;
    element.remove();
    chip.setAttribute('aria-expanded', 'false');
    if (refocus) chip.focus({ preventScroll: true });
  };
  /** Opens the list of a chip under it: "all" first where the filter has one, then every choice that leaves rows and can be computed, with how many rows it leaves. */
  const openMenu = (chip) => {
    closeMenu();
    const key = chip.getAttribute('data-filter');
    const all = allLabel(key);
    const found = optionsOf(db, filters, key).filter((option) => canCompute(withFilter(db, filters, key, option.value)));
    const list = all === null ? found : [{ value: null, label: all, count: null }, ...found];
    const now = chosen(db, filters, key);
    const element = document.createElement('div');
    element.className = 'fmenu';
    element.setAttribute('role', 'listbox');
    element.setAttribute('aria-label', (chip.firstChild?.textContent ?? '').replace(/:\s*$/, ''));
    list.forEach((option, index) => {
      const row = document.createElement('div');
      row.className = 'fopt';
      row.setAttribute('role', 'option');
      row.setAttribute('tabindex', '-1');
      row.setAttribute('data-option', String(index));
      row.setAttribute('aria-selected', String(option.value === now));
      const label = document.createElement('span');
      label.textContent = option.label;
      row.append(label);
      if (option.count !== null) {
        const count = document.createElement('span');
        count.className = 'n';
        count.textContent = String(option.count);
        row.append(count);
      }
      element.append(row);
    });
    // The list hangs inside the band of the chips, so it is scaled with the page; the band is its positioning box (template/skin.css).
    element.style.left = `${chip.offsetLeft}px`;
    chip.parentElement.append(element);
    chip.setAttribute('aria-expanded', 'true');
    menu = { element, chip, key, values: list.map((option) => option.value) };
    (element.querySelector('[aria-selected="true"]') ?? element.firstElementChild)?.focus({ preventScroll: true });
  };
  const pick = (row) => {
    const { key, values } = menu;
    const value = values[Number(row.getAttribute('data-option'))];
    closeMenu();
    choose(withFilter(db, filters, key, value), key);
  };
  const moveInMenu = (step) => {
    const rows = [...menu.element.children];
    const at = rows.indexOf(document.activeElement);
    const to = step === 'first' ? 0 : step === 'last' ? rows.length - 1 : Math.max(0, Math.min(rows.length - 1, (at < 0 ? 0 : at) + step));
    rows[to]?.focus({ preventScroll: true });
  };

  const pageOf = (target) => { const tab = target instanceof Element ? target.closest('[data-pg]') : null; return tab === null ? undefined : Number(tab.getAttribute('data-pg')); };
  const closest = (target, selector) => (target instanceof Element ? target.closest(selector) : null);
  /** A click or a key on a chip, on the chip that clears, or on a row of the open list; true when it was one of them. */
  const act = (target) => {
    const row = closest(target, '.fopt');
    if (row !== null && menu !== null) { pick(row); return true; }
    const chip = closest(target, '[data-filter]');
    if (chip !== null) { if (menu !== null && menu.chip === chip) closeMenu(true); else openMenu(chip); return true; }
    const clear = closest(target, '[data-clear]');
    if (clear !== null) { closeMenu(); choose(cleared(filters, clear.getAttribute('data-clear')), ''); return true; }
    return false;
  };
  const onClick = (event) => {
    if (act(event.target)) return;
    closeMenu();
    const page = pageOf(event.target);
    if (page !== undefined) go(page);
  };
  const onKey = (event) => {
    if (menu !== null) {
      // While a list is open the keys belong to it: the arrows move in it and do not turn the page.
      if (event.key === 'Escape') { event.preventDefault(); closeMenu(true); }
      else if (event.key === 'ArrowDown') { event.preventDefault(); moveInMenu(1); }
      else if (event.key === 'ArrowUp') { event.preventDefault(); moveInMenu(-1); }
      else if (event.key === 'Home') { event.preventDefault(); moveInMenu('first'); }
      else if (event.key === 'End') { event.preventDefault(); moveInMenu('last'); }
      else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); act(event.target); }
      // Tab leaves the list from the chip it hangs under, so the next stop is the one after (or before) the chip.
      else if (event.key === 'Tab') closeMenu(true);
      else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight' || event.key === 'PageUp' || event.key === 'PageDown') event.preventDefault();
      return;
    }
    if (event.key === 'ArrowRight' || event.key === 'PageDown') { event.preventDefault(); go(current + 1); }
    else if (event.key === 'ArrowLeft' || event.key === 'PageUp') { event.preventDefault(); go(current - 1); }
    else if (event.key === 'Enter' || event.key === ' ' || (event.key === 'ArrowDown' && closest(event.target, '[data-filter]') !== null)) {
      if (act(event.target)) { event.preventDefault(); return; }
      const page = pageOf(event.target);
      if (page !== undefined) { event.preventDefault(); go(page); }
    }
  };
  /** A click anywhere outside the board closes the open list. */
  const onOutside = (event) => { if (menu !== null && !(event.target instanceof Node && host.contains(event.target))) closeMenu(); };
  host.addEventListener('click', onClick);
  host.addEventListener('keydown', onKey);
  document.addEventListener('click', onOutside);
  window.addEventListener('resize', fit);
  document.addEventListener('fullscreenchange', fit);
  const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(fit);
  observer?.observe(host);

  go(options.page ?? 0, false);
  return {
    count,
    names,
    go: (index) => go(index, false),
    dispose() {
      host.removeEventListener('click', onClick);
      host.removeEventListener('keydown', onKey);
      document.removeEventListener('click', onOutside);
      window.removeEventListener('resize', fit);
      document.removeEventListener('fullscreenchange', fit);
      observer?.disconnect();
      host.replaceChildren();
    },
  };
}
