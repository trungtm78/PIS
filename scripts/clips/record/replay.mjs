// Replays the click steps of a scenario scene on the real screens: opens drawers, applies filters, expands rows, opens a detail record, fills and sends demo forms.
// The scenario names places by symbolic refs (refs.json); bindings.json says how a ref is found on the screen (explicit line, last word of the ref, kind of place).
// A step that cannot be done is skipped with a reason, never thrown: the film must still be made. Every step leaves one line in the per-scene report.
import { readJson } from '../common.mjs';
import { parseTarget } from './scene.mjs';
import { Ui } from './ui.mjs';

export const bindings = () => readJson('record/bindings.json');

/** The verbs of a scenario step list that act on the screen (the others are handled elsewhere or are not for a browser). */
export const SCREEN_VERBS = new Set(['click', 'choose', 'point', 'type', 'spot', 'scroll', 'wait', 'expect']);
/** Verbs that do their work outside the browser (an API call or a file import) or on the phone. */
export const OFF_SCREEN_VERBS = new Set(['command', 'upload', 'phone-open', 'phone-tap', 'phone-scroll', 'animatic', 'still']);

const lastWords = (ref) => ref.split('.').slice(-2).join(' ');

/** The candidates (target texts, best first) a ref can be found with for a verb, and where the list came from. */
export function candidatesFor(verb, ref, table = bindings()) {
  if (typeof ref !== 'string' || ref === '') return { source: 'none', targets: [] };
  const explicit = table.refs?.[ref];
  const tail = ref.split('.').at(-1);
  const byTail = table.tails?.[verb]?.[tail];
  const targets = [];
  const sources = [];
  const add = (source, list) => {
    if (list === undefined) return;
    sources.push(source);
    for (const target of list) if (!targets.includes(target)) targets.push(target);
  };
  add('ref', explicit);
  add('tail', byTail);
  const words = lastWords(ref);
  for (const rule of table.words ?? []) {
    if (rule.verbs !== undefined && !rule.verbs.includes(verb)) continue;
    if (new RegExp(String.raw`\b(?:${rule.match})\b`, 'iu').test(words)) {
      add(`kind:${rule.kind}`, table.kinds?.[rule.kind]);
      break;
    }
  }
  if (verb === 'spot' || verb === 'point') add('kind:region', table.kinds?.region);
  return { source: sources.join('+') || 'none', targets };
}

const escapeRegex = (text) => text.replace(/[.*+?^${}()[\]\\]/gu, '\\$&');
/** A case-insensitive pattern from a name written with bars between alternatives (`Luu|Ghi`). */
export const namePattern = (value) => new RegExp(value.split('|').map((part) => escapeRegex(part.trim())).filter(Boolean).join('|'), 'iu');

/** The Playwright locator (all matches, not yet narrowed) of a target text. */
export function toLocator(page, spec) {
  const target = parseTarget(spec);
  switch (target.kind) {
    case 'role':
      return target.name === undefined ? page.getByRole(target.role) : page.getByRole(target.role, { name: namePattern(target.name) });
    case 'label':
      return page.getByLabel(namePattern(target.value));
    case 'text':
      return page.getByText(namePattern(target.value));
    case 'testid':
      return page.getByTestId(target.value);
    case 'placeholder':
      return page.getByPlaceholder(namePattern(target.value));
    default:
      return page.locator(target.value);
  }
}

const MIN_SIDE = 8;
const overlaps = (a, b) => {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return width > 0 && height > 0 && (width * height) / Math.min(a.width * a.height, b.width * b.height) > 0.6;
};

/**
 * The first visible place the candidates name: { locator, via, box }, or null. `avoid` is a list of boxes already framed in this view (a fallback
 * that would frame the same place twice moves on to the next match). At most `perTarget` matches of one candidate are tried.
 */
export async function resolve(page, targets, { avoid = [], perTarget = 8, minArea = 0 } = {}) {
  for (const spec of targets) {
    let all;
    try {
      all = toLocator(page, spec);
      const count = await all.count();
      for (let index = 0; index < Math.min(count, perTarget); index += 1) {
        const locator = all.nth(index);
        if (!(await locator.isVisible())) continue;
        const box = await locator.boundingBox();
        if (box === null || box.width < MIN_SIDE || box.height < MIN_SIDE || box.width * box.height < minArea) continue;
        if (avoid.some((other) => overlaps(box, other))) continue;
        return { locator, via: spec, box };
      }
    } catch {
      // a candidate that the browser refuses (bad selector, page moved) is just not a match
    }
  }
  return null;
}

/** Points of a smooth path from `from` to `to`: ease in and out, with a slight arc so that it does not look like a ruler line. */
export function glidePath(from, to, steps) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const distance = Math.hypot(dx, dy);
  const bend = Math.min(36, distance * 0.07);
  const nx = distance === 0 ? 0 : -dy / distance;
  const ny = distance === 0 ? 0 : dx / distance;
  const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - ((-2 * t + 2) ** 3) / 2);
  const points = [];
  for (let index = 1; index <= steps; index += 1) {
    const t = index / steps;
    const e = ease(t);
    const arc = Math.sin(Math.PI * e) * bend;
    points.push({ x: Math.round(from.x + dx * e + nx * arc), y: Math.round(from.y + dy * e + ny * arc) });
  }
  points[steps - 1] = { x: Math.round(to.x), y: Math.round(to.y) };
  return points;
}

/** How long the pointer takes for a distance, in ms at normal speed (a short hop is quick, a cross-screen travel about one second). */
export const travelMs = (distance) => Math.round(Math.min(1100, Math.max(380, 280 + distance * 0.55)));

/** In the page: zoom the part a little and dim the rest with a frame that fades in; the scale is smaller for a wide part. */
function applyFocus(element, frame) {
  const doc = globalThis.document;
  const old = { transform: element.style.transform, transition: element.style.transition, transformOrigin: element.style.transformOrigin };
  element.__clipsOld = old;
  element.style.transformOrigin = 'center center';
  element.style.transition = 'transform 600ms ease-in-out';
  element.style.transform = `${old.transform} scale(${frame.width > 1100 ? 1.012 : frame.width > 600 ? 1.022 : 1.04})`.trim();
  const box = doc.createElement('div');
  box.className = 'clips-spot';
  Object.assign(box.style, { left: `${frame.x - 8}px`, top: `${frame.y - 8}px`, width: `${frame.width + 16}px`, height: `${frame.height + 16}px`, boxShadow: '0 0 0 9999px rgba(8,22,30,.30), 0 0 0 6px rgba(47,181,168,.30)' });
  doc.body.appendChild(box);
  box.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 450, fill: 'both' });
}

function clearFocus(element) {
  const doc = globalThis.document;
  doc.querySelectorAll('.clips-spot').forEach((node) => node.remove());
  const old = element?.__clipsOld;
  if (old !== undefined) {
    element.style.transform = old.transform;
    element.style.transition = old.transition;
    element.style.transformOrigin = old.transformOrigin;
    delete element.__clipsOld;
  }
}

/** In the page: what is left on the screen that should not be (a spinner that does not end, an error banner, a loading text). */
function readScreenProblems(loadingPattern) {
  const doc = globalThis.document;
  const shown = (element) => element.getClientRects().length > 0 && globalThis.getComputedStyle(element).visibility !== 'hidden';
  const busy = Array.from(doc.querySelectorAll('[aria-busy="true"], [role="progressbar"], [class*="spinner" i], [class*="loading" i]')).filter(shown).length;
  const alerts = Array.from(doc.querySelectorAll('[role="alert"], [class*="error-banner" i], [class*="banner-error" i]'))
    .filter(shown)
    .map((element) => (element.textContent ?? '').trim().replace(/\s+/gu, ' ').slice(0, 100))
    .filter((text) => text !== '');
  const screen = doc.querySelector('[data-screen-id]');
  const text = screen === null ? '' : (screen.innerText ?? '').trim();
  const loadingText = text.length < 400 && new RegExp(loadingPattern, 'iu').test(text);
  return { busy, alerts, loadingText, blank: screen !== null && text.length < 20 };
}

export class ReplayUi extends Ui {
  constructor(page, options = {}) {
    super(page, options);
    this.at = { x: 960, y: 540 };
  }

  /** The pointer glides to a place with an eased, slightly curved path, one small move per frame. */
  async glideTo(x, y) {
    const distance = Math.hypot(x - this.at.x, y - this.at.y);
    const duration = Math.round(travelMs(distance) * this.slowMo);
    const steps = Math.min(48, Math.max(10, Math.round(duration / 24)));
    for (const point of glidePath(this.at, { x, y }, steps)) {
      await this.page.mouse.move(point.x, point.y);
      await this.page.waitForTimeout(Math.round(duration / steps));
    }
    this.at = { x, y };
  }

  async point(locator) {
    await locator.scrollIntoViewIfNeeded();
    const box = await locator.boundingBox();
    if (box === null) throw new Error('the target has no box to point at');
    await this.glideTo(box.x + Math.min(box.width / 2, 60), box.y + box.height / 2);
  }

  async click(locator, { pause = 300 } = {}) {
    await this.point(locator);
    await this.wait(pause);
    await locator.click({ timeout: 6000 });
  }

  async type(locator, text) {
    await this.click(locator, { pause: 200 });
    await locator.pressSequentially(text, { delay: Math.round(55 * this.slowMo) });
  }

  /** Zoom and dim around a part of the screen for as long as `during` takes. */
  async spot(locator, during) {
    await locator.scrollIntoViewIfNeeded();
    const box = await locator.boundingBox();
    if (box === null) throw new Error('the target has no box to frame');
    await locator.evaluate(applyFocus, box);
    try {
      return await during();
    } finally {
      await locator.evaluate(clearFocus).catch(() => undefined);
    }
  }

  /** Picks an option of a filter: a native select (the first real option, or the one named) or a custom list box. */
  async choose(locator, option) {
    await this.point(locator);
    await this.wait(300);
    const native = await locator.evaluate((element) => element.tagName === 'SELECT');
    if (native) {
      if (option === 'first' || option === undefined) {
        const values = await locator.evaluate((element) => Array.from(element.options).filter((entry) => entry.value !== '').map((entry) => entry.value));
        if (values.length === 0) throw new Error('the list has no option to choose');
        await locator.selectOption(values[0]);
      } else {
        // The label may carry a count after the name ("Name (2 hợp đồng)"): the first option whose text holds the words is the one.
        const value = await locator.evaluate((element, text) => Array.from(element.options).find((entry) => entry.label === text || (entry.textContent ?? '').includes(text))?.value, option);
        if (value === undefined) throw new Error('the list has no option named ' + option);
        await locator.selectOption(value);
      }
      return;
    }
    await locator.click({ timeout: 6000 });
    await this.wait(400);
    const options = this.page.getByRole('option');
    const entry = option === 'first' || option === undefined ? options.first() : options.filter({ hasText: option }).first();
    await this.glideTo(...(await centre(entry)));
    await entry.click({ timeout: 4000 });
  }

  /** Sends the event a Chromium browser sends when the application can be installed (a headless browser never does), so that the install button of the page shows. */
  async fireInstallPrompt() {
    await this.page.evaluate(() => {
      const event = new globalThis.Event('beforeinstallprompt', { cancelable: true });
      event.prompt = () => {
        globalThis.setTimeout(() => globalThis.dispatchEvent(new globalThis.Event('appinstalled')), 900);
        return Promise.resolve();
      };
      event.userChoice = Promise.resolve({ outcome: 'accepted' });
      globalThis.dispatchEvent(event);
    });
    await this.page.waitForTimeout(500);
  }

  /** What is on the screen now that should not be: see readScreenProblems. */
  async screenProblems() {
    return this.page.evaluate(readScreenProblems, bindings().loadingText ?? 'loading');
  }

  /** Waits (up to `ms`) until nothing on the screen is loading any more. */
  async settleLoading(ms = 3500) {
    await this.page.waitForFunction(() => globalThis.document.querySelector('[aria-busy="true"], [role="progressbar"]') === null, undefined, { timeout: ms }).catch(() => undefined);
  }

  /** Closes a drawer or dialog the last step opened, so that the next screen is not filmed behind it. */
  async closeOverlays() {
    const open = await this.page.locator('[role="dialog"], [role="alertdialog"]').count().catch(() => 0);
    if (open === 0) return false;
    await this.page.keyboard.press('Escape');
    await this.page.waitForTimeout(400);
    return true;
  }
}

async function centre(locator) {
  const box = await locator.boundingBox();
  if (box === null) throw new Error('the option has no box');
  return [box.x + box.width / 2, box.y + box.height / 2];
}

const record = (step, status, extra = {}) => ({ do: step.do, ref: step.ref ?? null, status, ...extra });

/** Does one step of the scenario with `ui`. Returns the line for the report; never throws. */
export async function replayStep(ui, step, { typed = {}, table = bindings(), avoid = [], slotMs = 1500, log = () => undefined } = {}) {
  const began = Date.now();
  const finish = (line) => ({ ...line, ms: Date.now() - began });
  try {
    if (OFF_SCREEN_VERBS.has(step.do)) return finish(record(step, 'skipped', { reason: step.do.startsWith('phone') ? 'phone step' : 'done outside the screen (data, not a click)' }));
    if (step.do === 'wait') {
      await ui.wait(Number.isFinite(step.ms) ? step.ms : slotMs);
      return finish(record(step, 'replayed', { via: 'wait' }));
    }
    if (step.do === 'scroll') {
      await ui.scrollThrough(Number.isFinite(step.through) ? step.through : Math.round(slotMs * 1.6));
      return finish(record(step, 'replayed', { via: 'scroll' }));
    }
    if (!SCREEN_VERBS.has(step.do)) return finish(record(step, 'skipped', { reason: `verb ${step.do} is not replayed` }));
    const { source, targets } = candidatesFor(step.do, step.ref, table);
    const found = await resolve(ui.page, targets, { avoid, ...(step.do === 'spot' ? { minArea: 3000 } : {}) });
    if (found === null) {
      log(`  warning: step ${step.do} ${step.ref}: no place found (${source || 'no binding'})`);
      return finish(record(step, 'skipped', { reason: targets.length === 0 ? 'no binding for this ref' : 'not visible on the screen', source }));
    }
    const via = `${source} ${found.via}`;
    switch (step.do) {
      case 'click':
        await ui.click(found.locator);
        await ui.wait(900);
        await ui.settleLoading();
        break;
      case 'point':
        await ui.hover(found.locator);
        break;
      case 'choose':
        await ui.choose(found.locator, step.option);
        await ui.wait(700);
        await ui.settleLoading();
        break;
      case 'type': {
        const text = typed[step.textKey];
        if (typeof text !== 'string') throw new Error(`typed text ${step.textKey} is missing`);
        await ui.type(found.locator, text);
        await ui.wait(500);
        break;
      }
      case 'expect':
        await ui.expectVisible(found.locator, 4000);
        break;
      default: {
        await ui.point(found.locator);
        await ui.spot(found.locator, () => ui.wait(slotMs));
        avoid.push(found.box);
      }
    }
    return finish(record(step, 'replayed', { via, fallback: source.includes('region') && !source.includes('ref'), ...(step.do === 'spot' ? { box: found.box, startedAt: began } : {}) }));
  } catch (error) {
    const reason = String(error instanceof Error ? error.message : error).split('\n')[0].slice(0, 160);
    log(`  warning: step ${step.do} ${step.ref ?? ''} skipped: ${reason}`);
    return finish(record(step, 'skipped', { reason }));
  }
}

/** The scene steps of each view: the steps after an `open` belong to that screen; steps before the first `open` go to the first view. */
export function groupSteps(scene, views) {
  const groups = views.map(() => []);
  let current = 0;
  for (const step of scene.steps ?? []) {
    if (step.do === 'open') {
      const at = views.findIndex((view) => view.screen === step.screen);
      if (at >= 0) current = at;
      continue;
    }
    if (step.do === 'as' || groups.length === 0) continue;
    groups[current].push(step);
  }
  return groups;
}

export const isActionable = (step) => SCREEN_VERBS.has(step.do);

/** The share of the scene each view gets: a view with steps to show gets more time than a bare one. */
export function viewShares(groups, durationMs) {
  const weights = groups.map((steps) => 1 + 0.7 * steps.filter(isActionable).length);
  const sum = weights.reduce((total, weight) => total + weight, 0);
  return weights.map((weight) => (durationMs * weight) / sum);
}

/**
 * Replays the steps of one view inside `budgetMs` (the time left for this view after it has drawn). Every actionable step gets an equal slot of
 * the budget (at least 1.2 s); a step that finishes early holds the rest of its slot, one that overruns takes time from the next ones.
 * Returns the lines of the report and whether a scroll step ran (so that the caller does not scroll again).
 */
export async function replayView(ui, steps, { budgetMs, typed, table, log = () => undefined, now = () => Date.now() } = {}) {
  const lines = [];
  const avoid = [];
  const deadline = now() + budgetMs * 0.85;
  let left = steps.filter(isActionable).length;
  let scrolled = false;
  for (const step of steps) {
    const began = now();
    const slot = left > 0 ? Math.max(1200, (deadline - began) / left) : 1200;
    const line = await replayStep(ui, step, { typed, table, avoid, slotMs: Math.min(slot, 6000), log });
    if (step.do === 'scroll' && line.status === 'replayed') scrolled = true;
    if (isActionable(step)) {
      left -= 1;
      const spent = now() - began;
      if (line.status === 'replayed' && spent < slot && step.do !== 'wait' && step.do !== 'scroll') await ui.page.waitForTimeout(Math.min(slot - spent, 3000));
    }
    lines.push(line);
    log(`  step ${step.do} ${step.ref ?? ''}: ${line.status}${line.reason ? ` (${line.reason})` : ''}`);
  }
  await ui.closeOverlays().catch(() => false);
  return { lines, scrolled };
}

/** The numbers of a report: how many steps were replayed, skipped and how many of the skipped were off-screen by nature. */
export function summariseReplay(lines) {
  const replayed = lines.filter((line) => line.status === 'replayed').length;
  const offScreen = lines.filter((line) => line.status === 'skipped' && /outside the screen|phone step/u.test(line.reason ?? '')).length;
  return { total: lines.length, replayed, skipped: lines.length - replayed, offScreen };
}
