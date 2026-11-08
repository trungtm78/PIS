// The look of a produced product film: branded background, browser and phone frames, a headline for each scene, callout chips, a dark subtitle bar
// with the key term in the accent colour, and the chapter ticker. Everything here is pure: data in, HTML or numbers out (render.mjs draws it with Chromium,
// plan.mjs puts it together with ffmpeg). The words come from the scenario and from brand.json; this file holds none.
import { readJson } from '../common.mjs';

export const layouts = () => readJson('compose/layouts.json');
export const LAYOUT_NAMES = ['full-web', 'web+callouts', 'phone-right', 'split', 'title'];
/** Seconds after which the background starts over (every motion in it has a whole number of cycles in this time). */
export const LOOP_SEC = 12;

export const PALETTE = {
  deep: '#0B2230',
  sidebar: '#102E3B',
  ink: '#122D3B',
  card: '#1C3B48',
  primary: '#007D77',
  teal: '#2FB5A8',
  tealLight: '#7FE0D6',
  gold: '#E0AA52',
  white: '#FFFFFF',
  muted: '#C4D5DC',
};

const escapeHtml = (text) => String(text).replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;').replace(/"/gu, '&quot;');

/** The layout a scene is shown in: its own `layout` field, else by its screen platform. null means the scene is full-bleed (an animatic) and is not framed. */
export function layoutOf(scene) {
  if (scene.layout !== undefined) {
    if (!LAYOUT_NAMES.includes(scene.layout)) throw new Error(`scene ${scene.id}: unknown layout ${scene.layout} (known: ${LAYOUT_NAMES.join(', ')})`);
    return scene.layout;
  }
  switch (scene.screen?.platform) {
    case 'web':
    case 'pwa':
      return 'web+callouts';
    case 'phone':
      return 'phone-right';
    case 'title':
      return 'title';
    default:
      return null;
  }
}

const SENTENCE_END = /(?<=[.!?])\s+/u;

/** A short line for the left of a scene: the `headline` of the scene, else its first sentence without figure placeholders, cut at a comma or a word. */
export function headlineOf(scene, max = 64) {
  if (typeof scene.headline === 'string' && scene.headline !== '') return scene.headline;
  const sentences = (scene.narration ?? '').split(SENTENCE_END);
  let line = sentences.find((sentence) => !sentence.includes('{{')) ?? (sentences[0] ?? '').replace(/\{\{[^}]*\}\}/gu, '').replace(/\s{2,}/gu, ' ');
  line = line.trim().replace(/[.!?]+$/u, '');
  if (line.length <= max) return line;
  const comma = line.slice(0, max).lastIndexOf(',');
  if (comma >= 24) return line.slice(0, comma);
  const space = line.slice(0, max).lastIndexOf(' ');
  return `${line.slice(0, space > 0 ? space : max)}…`;
}

let numberTerm;
const numberTermOf = () => {
  if (numberTerm === undefined) {
    const units = layouts().numberUnits.map((unit) => unit.replace(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`)).join('|');
    numberTerm = new RegExp(String.raw`\d[\d.,]*(?:\s?(?:%|${units}))?`, 'iu');
  }
  return numberTerm;
};

/** The first key term of a line: a number with its unit, else the first capitalised word after the start, else the longest word. Returns [before, key, after]. */
export function splitKey(text) {
  const number = numberTermOf().exec(text);
  if (number !== null) return [text.slice(0, number.index), number[0], text.slice(number.index + number[0].length)];
  const caps = /(?<=\s)\p{Lu}[\p{L}\p{M}-]{2,}(?:\s\p{Lu}[\p{L}\p{M}-]{2,})*/u.exec(text);
  if (caps !== null) return [text.slice(0, caps.index), caps[0], text.slice(caps.index + caps[0].length)];
  const words = [...text.matchAll(/[\p{L}\p{M}\p{N}-]{5,}/gu)];
  if (words.length === 0) return [text, '', ''];
  const best = words.reduce((longest, word) => (word[0].length > longest[0].length ? word : longest), words[0]);
  return [text.slice(0, best.index), best[0], text.slice(best.index + best[0].length)];
}

export const keyTerm = (text) => splitKey(text)[1];

/** The outer rectangles of the frames of a layout and where their screens (holes) are. */
export function frames(layoutName, spec = layouts()) {
  const layout = spec.layouts[layoutName];
  if (layout === undefined) throw new Error(`unknown layout ${layoutName}`);
  const result = { headline: layout.headline === false ? null : layout.headline, chips: layout.chips === true };
  if (layout.window !== undefined) {
    const { x, y, hole } = layout.window;
    result.web = { outer: { x, y, width: hole.width + 2 * spec.windowPad, height: hole.height + spec.windowBar + spec.windowPad }, hole: { x: x + spec.windowPad, y: y + spec.windowBar, width: hole.width, height: hole.height } };
  }
  if (layout.phone !== undefined) {
    const { x, y, screen } = layout.phone;
    result.phone = { outer: { x, y, width: screen.width + 2 * spec.phoneBezel, height: screen.height + 2 * spec.phoneBezel }, hole: { x: x + spec.phoneBezel, y: y + spec.phoneBezel, width: screen.width, height: screen.height } };
  }
  return result;
}

/** Where a box of the 1920x1080 footage lands on the canvas, inside a hole. */
export function mapBox(box, hole, source = { width: 1920, height: 1080 }) {
  const sx = hole.width / source.width;
  const sy = hole.height / source.height;
  return { x: hole.x + box.x * sx, y: hole.y + box.y * sy, width: box.width * sx, height: box.height * sy };
}

/** The brand of an edition: from brand.json (the logo lane writes it) when it exists, else a text mark. Never throws. */
export function brandOf(edition, raw, names = {}) {
  const base = { name: names[edition] ?? '', tagline: '', logo: null, accent: PALETTE.gold };
  if (raw === undefined || raw === null) return base;
  const pick = raw.editions?.[edition] ?? raw[edition] ?? raw.files?.[edition] ?? {};
  const taglines = raw.taglines ?? {};
  const logo = pick.logo ?? pick.logoFile ?? pick.file ?? raw.logo ?? null;
  return { name: pick.name ?? raw.name ?? base.name, tagline: pick.tagline ?? taglines[edition] ?? raw.tagline ?? '', logo, accent: raw.colours?.accent ?? raw.colors?.accent ?? base.accent };
}

export const fontCss = (fontDir) => ['Regular:400', 'Medium:500', 'SemiBold:600', 'Bold:700'].map((entry) => {
  const [name, weight] = entry.split(':');
  return `@font-face{font-family:'Be Vietnam Pro';font-weight:${weight};src:url('file:///${fontDir.replace(/\\/gu, '/')}/BeVietnamPro-${name}.ttf')}`;
}).join('');

const BASE_CSS = `*{box-sizing:border-box;margin:0;padding:0}html,body{width:1920px;height:1080px;overflow:hidden;background:transparent;font-family:'Be Vietnam Pro',sans-serif;color:#fff}`;
const page = (css, body, fonts, script = '') => `<!doctype html><html lang="vi"><head><meta charset="utf-8"><style>${fonts}${BASE_CSS}${css}</style></head><body>${body}${script === '' ? '' : `<script>${script}</script>`}</body></html>`;

/** The animated background: a deep teal gradient, soft concentric rings that breathe, and slow particles. `window.__setT(seconds)` draws the frame of a time. */
export function backgroundHtml(fonts = '') {
  const rings = Array.from({ length: 9 }, (_, index) => `<circle class="ring" data-i="${index}" cx="1480" cy="520" r="${160 + index * 118}" fill="none" stroke="${PALETTE.teal}" stroke-width="${index % 3 === 0 ? 2.5 : 1.5}"/>`).join('');
  const dots = Array.from({ length: 44 }, (_, index) => `<circle class="dot" data-i="${index}" r="${2 + (index % 4)}" fill="${PALETTE.tealLight}"/>`).join('');
  const body = `<div id="glow"></div><svg width="1920" height="1080" viewBox="0 0 1920 1080">${rings}${dots}</svg>`;
  const css = `body{background:linear-gradient(135deg,${PALETTE.deep} 0%,${PALETTE.sidebar} 48%,#0D5558 100%)}#glow{position:absolute;inset:0}svg{position:absolute;inset:0}`;
  const script = `const T=${LOOP_SEC};const rings=[...document.querySelectorAll('.ring')];const dots=[...document.querySelectorAll('.dot')];const glow=document.getElementById('glow');
const seed=(i,k)=>{const x=Math.sin(i*127.1+k*311.7)*43758.5453;return x-Math.floor(x)};
window.__setT=(t)=>{const a=2*Math.PI*t/T;
rings.forEach((r,i)=>{const base=160+i*118;r.setAttribute('r',base+14*Math.sin(a+i*0.7));r.setAttribute('stroke-opacity',(0.30-i*0.028).toFixed(3))});
dots.forEach((d,i)=>{const cyc=1+(i%3);const px=seed(i,1)*1920,py=seed(i,2)*1080;d.setAttribute('cx',px+40*Math.sin(a*cyc+i));d.setAttribute('cy',py+30*Math.cos(a*cyc+i*1.3));d.setAttribute('opacity',(0.12+0.28*(0.5+0.5*Math.sin(a*cyc+i*2))).toFixed(3))});
glow.style.background='radial-gradient(900px 700px at '+(1380+60*Math.sin(a))+'px '+(500+40*Math.cos(a))+'px, rgba(47,181,168,0.20), rgba(47,181,168,0) 70%)'};window.__setT(0);`;
  return page(css, body, fonts, script);
}

const logoMark = (brand) => (brand.logo === null || brand.logo === undefined
  ? `<div class="mark">${escapeHtml((brand.name || 'PIS').slice(0, 1))}</div>`
  : `<img class="logo" src="file:///${String(brand.logo).replace(/\\/gu, '/')}">`);

const tickerHtml = (ticker) => {
  if (ticker === undefined || ticker.chapters.length === 0) return '';
  const cells = ticker.chapters.map((chapter) => `<div class="tk ${chapter.state}" style="flex:${chapter.weight}"><i style="width:${Math.round(chapter.fill * 100)}%"></i><span>${escapeHtml(chapter.title)}</span></div>`).join('');
  return `<div id="ticker">${cells}</div>`;
};

const FRAME_CSS = `
#ticker{position:absolute;left:0;right:0;top:0;height:54px;display:flex;gap:4px;padding:10px 40px 0;opacity:.95}
.tk{position:relative;height:34px;border-radius:10px;background:rgba(255,255,255,.08);overflow:hidden;display:flex;align-items:center;padding:0 12px;min-width:0}
.tk i{position:absolute;left:0;top:0;bottom:0;background:rgba(47,181,168,.45)}
.tk.done i{background:rgba(47,181,168,.30)}
.tk span{position:relative;font-size:15px;font-weight:500;color:${PALETTE.muted};white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tk.current span{color:#fff;font-weight:700}.tk.current{box-shadow:inset 0 0 0 2px ${PALETTE.teal}}
.win{position:absolute;border-radius:20px;overflow:hidden;box-shadow:0 36px 90px rgba(0,0,0,.55),0 8px 24px rgba(0,0,0,.4)}
.win .bar{height:38px;background:#0F2733;display:flex;align-items:center;gap:8px;padding:0 16px}
.win .bar b{width:12px;height:12px;border-radius:50%;background:#E0675F}.win .bar b:nth-child(2){background:#E0B04F}.win .bar b:nth-child(3){background:#58B96B}
.win .bar u{margin-left:18px;flex:1;max-width:520px;height:22px;border-radius:11px;background:rgba(255,255,255,.1)}
.win .bar img{height:24px;margin-left:auto}
.hole{position:absolute;box-shadow:0 0 0 14px #0F2733}
.phone{position:absolute;border-radius:62px;overflow:hidden;box-shadow:0 40px 100px rgba(0,0,0,.6)}
.phone .rim{position:absolute;inset:0;border-radius:62px;border:3px solid #3A5563;z-index:4}
.phone .notch{position:absolute;top:10px;left:50%;width:120px;height:26px;margin-left:-60px;border-radius:14px;background:#050C10;z-index:2}
.phone .scr{position:absolute;border-radius:42px;box-shadow:0 0 0 60px #0B1A22}
.phone .status{position:absolute;top:14px;left:34px;right:34px;display:flex;justify-content:space-between;font-size:15px;font-weight:600;color:#fff;z-index:3;text-shadow:0 1px 3px rgba(0,0,0,.6)}
.head{position:absolute;color:#fff}
.head small{display:block;font-size:22px;font-weight:600;letter-spacing:.12em;text-transform:uppercase;color:${PALETTE.tealLight};margin-bottom:18px}
.head h1{font-size:56px;line-height:1.16;font-weight:700;text-wrap:balance}
.head hr{width:120px;height:6px;border:0;border-radius:3px;background:${PALETTE.gold};margin-top:28px}
.brand{position:absolute;left:56px;bottom:26px;display:flex;align-items:center;gap:12px;font-size:20px;font-weight:600;color:${PALETTE.muted}}
.brand .logo{height:36px}.mark{width:36px;height:36px;border-radius:10px;background:${PALETTE.primary};display:flex;align-items:center;justify-content:center;font-weight:700}
`;

/** The transparent layer over the footage: ticker, frames with holes where the footage shows, the headline, the brand. Holes are cut by a huge shadow clipped to the frame. */
export function overlayHtml({ layout, headline, kicker, ticker, brand, spec = layouts(), fonts = '' }) {
  const geometry = frames(layout, spec);
  let body = tickerHtml(ticker);
  if (geometry.web !== undefined) {
    const { outer, hole } = geometry.web;
    body += `<div class="win" style="left:${outer.x}px;top:${outer.y}px;width:${outer.width}px;height:${outer.height}px"><div class="bar"><b></b><b></b><b></b><u></u>${brand.logo ? `<img src="file:///${String(brand.logo).replace(/\\/gu, '/')}">` : ''}</div><div class="hole" style="left:${hole.x - outer.x}px;top:${hole.y - outer.y}px;width:${hole.width}px;height:${hole.height}px"></div></div>`;
  }
  if (geometry.phone !== undefined) {
    const { outer, hole } = geometry.phone;
    body += `<div class="phone" style="left:${outer.x}px;top:${outer.y}px;width:${outer.width}px;height:${outer.height}px"><div class="rim"></div><div class="notch"></div><div class="status"><span>9:41</span><span>5G</span></div><div class="scr" style="left:${hole.x - outer.x}px;top:${hole.y - outer.y}px;width:${hole.width}px;height:${hole.height}px"></div></div>`;
  }
  if (geometry.headline !== null) {
    const place = geometry.headline;
    body += `<div class="head" style="left:${place.x}px;top:${place.y}px;width:${place.width}px">${kicker ? `<small>${escapeHtml(kicker)}</small>` : ''}<h1>${escapeHtml(headline)}</h1><hr></div>`;
  }
  body += `<div class="brand">${logoMark(brand)}<span>${escapeHtml(brand.name)}</span></div>`;
  return page(FRAME_CSS, body, fonts);
}

/** A title, chapter or outro card on the animated background: logo, name, gold underline, tagline. */
export function cardHtml({ kicker, title, subtitle, footer, brand, fonts = '' }) {
  const css = `${FRAME_CSS}.card{position:absolute;left:150px;top:230px;width:1100px}.card .logo{height:120px;margin-bottom:34px}.card .mark{width:120px;height:120px;border-radius:30px;font-size:64px;margin-bottom:34px}
.card small{display:block;font-size:26px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;color:${PALETTE.tealLight};margin-bottom:22px}.card h1{font-size:84px;line-height:1.1;font-weight:700;text-wrap:balance}
.card hr{width:180px;height:8px;border:0;border-radius:4px;background:${PALETTE.gold};margin:36px 0}.card p{font-size:34px;line-height:1.4;color:${PALETTE.muted};font-weight:400}.card footer{margin-top:40px;font-size:22px;color:${PALETTE.tealLight}}`;
  const body = `<div class="card">${logoMark(brand)}${kicker ? `<small>${escapeHtml(kicker)}</small>` : ''}<h1>${escapeHtml(title)}</h1><hr>${subtitle ? `<p>${escapeHtml(subtitle)}</p>` : ''}${brand.tagline ? `<p>${escapeHtml(brand.tagline)}</p>` : ''}${footer ? `<footer>${escapeHtml(footer)}</footer>` : ''}</div>`;
  return page(css, body, fonts);
}

/** One subtitle cue: a dark rounded bar at the bottom of a 1920x124 transparent strip, the key term in the accent colour. */
export function barHtml(text, { fonts = '', accent = PALETTE.gold } = {}) {
  const [before, key, after] = splitKey(text.replace(/\n/gu, ' '));
  const css = `html,body{height:124px}.bar{position:absolute;left:50%;bottom:20px;transform:translateX(-50%);max-width:1560px;padding:16px 38px;border-radius:30px;background:rgba(9,24,32,.90);box-shadow:0 10px 30px rgba(0,0,0,.45);font-size:38px;line-height:1.3;font-weight:500;text-align:center}.bar em{font-style:normal;font-weight:700;color:${accent}}`;
  const content = `${escapeHtml(before)}${key === '' ? '' : `<em>${escapeHtml(key)}</em>`}${escapeHtml(after)}`;
  return page(css, `<div class="bar">${content}</div>`, fonts);
}

/** A callout chip with an arrow that points at (x, y) on the canvas from the upper left. Drawn on a full-canvas transparent page. */
export function chipHtml({ x, y, label, fonts = '', accent = PALETTE.gold }) {
  const left = Math.max(24, Math.min(1920 - 420, x - 300));
  const top = Math.max(70, y - 120);
  const css = `.chip{position:absolute;left:${left}px;top:${top}px;padding:12px 24px;border-radius:26px;background:${PALETTE.primary};box-shadow:0 8px 24px rgba(0,0,0,.4);font-size:28px;font-weight:700;border:3px solid ${PALETTE.tealLight};white-space:nowrap}
svg{position:absolute;inset:0}`;
  const arrow = `<svg width="1920" height="1080"><path d="M${left + 120} ${top + 56} Q ${x - 40} ${top + 70} ${x} ${y}" stroke="${accent}" stroke-width="5" fill="none" stroke-linecap="round"/><circle cx="${x}" cy="${y}" r="13" fill="none" stroke="${accent}" stroke-width="5"/></svg>`;
  return page(css, `${arrow}<div class="chip">${escapeHtml(label)}</div>`, fonts);
}

/** The ticker of the chapters of a cut: one cell per chapter, the current one filled by how many of its scenes are over. */
export function tickerOf(chapters, currentId, sceneIndex, sceneCount) {
  return {
    chapters: chapters.map((chapter, index) => {
      const currentAt = chapters.findIndex((candidate) => candidate.id === currentId);
      const state = index < currentAt ? 'done' : index === currentAt ? 'current' : 'todo';
      return { title: chapter.title, weight: Math.max(1, chapter.scenes ?? 1), state, fill: state === 'done' ? 1 : state === 'current' ? (sceneIndex + 1) / Math.max(1, sceneCount) : 0 };
    }),
  };
}
