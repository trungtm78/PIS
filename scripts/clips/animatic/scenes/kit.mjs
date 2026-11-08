// Pure helpers shared by every scene. A scene is a function of time: render(data, t) returns the HTML of one frame, and the same
// arguments always give the same frame (no Date, no random, no DOM), so a frame can be captured exactly and tested in Node.

export const clamp01 = (value) => Math.min(1, Math.max(0, value));
export const lerp = (from, to, u) => from + (to - from) * u;
export const easeOut = (u) => 1 - (1 - u) ** 3;
export const easeInOut = (u) => (u < 0.5 ? 4 * u * u * u : 1 - (-2 * u + 2) ** 3 / 2);
export const linear = (u) => u;

/** Progress 0..1 of an animation that starts at `at` ms and lasts `dur` ms. */
export function ramp(t, at, dur = 500, ease = easeOut) {
  if (dur <= 0) return t >= at ? 1 : 0;
  return ease(clamp01((t - at) / dur));
}

/** Rounds to two decimals so that float noise never reaches the markup (and a frame stays byte-identical). */
export const num = (value) => String(Math.round(value * 100) / 100);

export function esc(text) {
  return String(text).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

/** An inline style from an object; numbers are written as given, so pass px strings where a unit is needed. */
export function css(style) {
  return Object.entries(style)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => `${key}:${typeof value === 'number' ? num(value) : value}`)
    .join(';');
}

export function el(tag, className, style, inner = '', attributes = '') {
  const cls = className === '' ? '' : ` class="${className}"`;
  const sty = style === undefined || Object.keys(style).length === 0 ? '' : ` style="${css(style)}"`;
  return `<${tag}${cls}${sty}${attributes === '' ? '' : ` ${attributes}`}>${inner}</${tag}>`;
}

/** The look of an element that fades and rises into place from `at`. */
export function appear(t, at, { dur = 500, rise = 18, ease = easeOut } = {}) {
  const u = ramp(t, at, dur, ease);
  return { opacity: u, transform: `translateY(${num((1 - u) * rise)}px)` };
}

/** The fade of the whole scene at its start and end (the assembly may cross-fade instead and ask for 0). */
export function sceneFade(t, durationMs, fadeMs = 300) {
  if (fadeMs <= 0) return 1;
  return Math.min(ramp(t, 0, fadeMs, linear), 1 - ramp(t, durationMs - fadeMs, fadeMs, linear));
}

const ICONS = {
  monitor: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
  phone: '<rect x="7" y="2.5" width="10" height="19" rx="2.5"/><path d="M11 18.5h2"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3.2 3 14.8 0 18M12 3c-3 3.2-3 14.8 0 18"/>',
  cog: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1"/>',
  bell: '<path d="M6 17V11a6 6 0 0 1 12 0v6l1.5 2h-15z"/><path d="M10 21h4"/>',
  chart: '<path d="M4 20V4M4 20h16"/><path d="M8 16v-5M12 16V8M16 16v-8"/>',
  db: '<ellipse cx="12" cy="6" rx="7" ry="3"/><path d="M5 6v12c0 1.7 3.1 3 7 3s7-1.3 7-3V6M5 12c0 1.7 3.1 3 7 3s7-1.3 7-3"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  shield: '<path d="M12 3l8 3v6c0 5-3.4 8-8 9-4.6-1-8-4-8-9V6z"/><path d="M9 12l2 2 4-4"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-6 8-6s8 2 8 6"/>',
  file: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4M9 13h6M9 17h6"/>',
  stamp: '<path d="M9 14V9a3 3 0 1 1 6 0v5l3 3v2H6v-2z"/><path d="M5 22h14"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
};

export const ICON_NAMES = Object.keys(ICONS);

/** An inline stroke icon in the colour of the text around it. */
export function icon(name, size = 40) {
  const body = ICONS[name];
  if (body === undefined) throw new Error(`unknown icon ${name}`);
  return `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}

/** The glyphs of the health and severity words (written as escapes: the text of the clip lives in the data files). */
export const GLYPH = { ok: '✓', attention: '⚠', late: '⛔', hold: '⏸', arrow: '→' };

/** A StatusPill: tinted text with an icon as a second cue, the same look as apps/web/src/ui/StatusPill.tsx. */
export function pill(tone, label, glyph = '') {
  const mark = glyph === '' ? '' : `<span class="pill__icon">${glyph}</span>`;
  return `<span class="pill pill--${tone}">${mark}<span>${esc(label)}</span></span>`;
}

/** A pointer that travels between keyframes ({t, x, y, click?}) and pulses at a click: a pure function of time. */
export function cursorAt(keys, t) {
  if (!Array.isArray(keys) || keys.length === 0) return { visible: false, x: 0, y: 0, ripple: 0 };
  const first = keys[0];
  if (t < first.t) return { visible: false, x: first.x, y: first.y, ripple: 0 };
  let x = first.x;
  let y = first.y;
  for (let index = 1; index < keys.length; index += 1) {
    const from = keys[index - 1];
    const to = keys[index];
    if (t <= to.t) {
      const u = easeInOut(clamp01((t - from.t) / Math.max(1, to.t - from.t)));
      x = lerp(from.x, to.x, u);
      y = lerp(from.y, to.y, u);
      break;
    }
    x = to.x;
    y = to.y;
  }
  let ripple = 0;
  for (const key of keys) {
    if (key.click === true && t >= key.t && t < key.t + 700) ripple = (t - key.t) / 700;
  }
  return { visible: true, x, y, ripple };
}

export function cursorHtml(keys, t) {
  const at = cursorAt(keys, t);
  if (!at.visible) return '';
  const ring =
    at.ripple > 0
      ? el('span', 'ripple', { left: `${num(at.x)}px`, top: `${num(at.y)}px`, transform: `translate(-50%,-50%) scale(${num(0.4 + at.ripple * 1.6)})`, opacity: 1 - at.ripple })
      : '';
  const arrow = el('span', 'pointer', { left: `${num(at.x)}px`, top: `${num(at.y)}px` });
  return ring + arrow;
}

/** The heading block of a diagram scene: a small uppercase kicker, then the title. */
export function heading(data, t) {
  const kicker = data.kicker === undefined ? '' : el('div', 'heading__kicker', {}, esc(data.kicker));
  return el('div', 'heading', appear(t, 0, { dur: 600 }), kicker + el('h1', 'heading__title', {}, esc(data.title)));
}

/** The lower third: one sentence at a time, picked from `captions` ({from, to, text} in ms). */
export function captionHtml(captions, t) {
  const live = (captions ?? []).find((caption) => t >= caption.from && t < caption.to);
  if (live === undefined) return '';
  const u = Math.min(ramp(t, live.from, 350), 1 - ramp(t, live.to - 250, 250));
  return el('div', 'lower-third', { opacity: u, transform: `translateY(${num((1 - u) * 14)}px)` }, esc(live.text));
}

/** The frame of every scene: the theme, the fade, then what the scene drew. */
export function stage(data, t, inner) {
  const fade = sceneFade(t, data.durationMs, data.fadeMs ?? 300);
  return el('div', `scene scene--${data.theme ?? 'light'}`, { opacity: fade }, inner);
}

export function requireFields(data, kind, fields) {
  return fields.filter((field) => data[field] === undefined).map((field) => `${kind}: "${field}" is missing`);
}
