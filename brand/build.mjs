// Builds the brand files from one master shape (apps/web/src/pwa/icon-art.ts):
//   brand/logo/*.svg          the sources (icon, mark, horizontal and stacked lockups, hero), words drawn as outlines, no font needed
//   <out>/logo-*.png          2048 px exports for the film composition and the documents (Playwright, no new dependency)
//   <out>/brand.json          the index: colours, files, taglines
// Usage: node --disable-warning=ExperimentalWarning brand/build.mjs [--out D:\PIS-clips-out\brand] [--no-png]
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MARK_PALETTES } from '../apps/web/src/brand/palettes.ts';
import { MARK, markElements } from '../apps/web/src/pwa/icon-art.ts';
import { loadFont, textPath } from './font-paths.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const argv = process.argv.slice(2);
const outAt = argv.indexOf('--out');
const outDir = outAt >= 0 ? resolve(argv[outAt + 1]) : 'D:\\PIS-clips-out\\brand';
const logoDir = join(here, 'logo');

const fontFile = (weight) => join(root, 'apps', 'mobile', 'assets', 'fonts', `BeVietnamPro-${weight}.ttf`);
const fonts = { bold: loadFont(fontFile('Bold')), semi: loadFont(fontFile('SemiBold')), medium: loadFont(fontFile('Medium')), regular: loadFont(fontFile('Regular')) };

/** The wordmark is the Vietnamese name of the capital flow behind the internal code name MACHVON. */
const WORDMARK = 'MẠCH VỐN';

/** The colours come from the web source (apps/web/src/brand/palettes.ts), the one place both the product and these files read. */
const dark = (id) => {
  const p = MARK_PALETTES[id];
  return { top: p.top, bottom: p.bottom, ...p.mark, background: p.tile, text: p.text.onDark, textSoft: p.text.onDarkSoft };
};
const light = (id) => {
  const p = MARK_PALETTES[id];
  return { ...p.onLight, text: p.text.onLight, textSoft: p.text.onLightSoft };
};

export const EDITIONS = {
  public: {
    id: 'public',
    wordmark: WORDMARK,
    productName: 'Hệ thống quản lý đầu tư công',
    productNameEn: 'Public Investment Management System',
    tagline: 'Mạch vốn thông suốt, đầu tư công minh bạch',
    dark: dark('public'),
    light: light('public'),
  },
  enterprise: {
    id: 'enterprise',
    wordmark: WORDMARK,
    productName: 'Phần mềm quản lý đầu tư xây dựng',
    productNameEn: 'Construction Investment Management Software',
    tagline: 'Vốn đến đúng công trình, việc đúng tiến độ',
    dark: dark('enterprise'),
    light: light('enterprise'),
  },
};

const num = (n) => Math.round(n * 100) / 100;
const colorsOf = (palette) => ({ background: palette.background, barLow: palette.barLow, barMid: palette.barMid, barHigh: palette.barHigh, accent: palette.accent });

function svgDoc(width, height, body, { defs = '', title }) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${num(width)} ${num(height)}" width="${num(width)}" height="${num(height)}" role="img" aria-label="${title}">\n<title>${title}</title>\n${defs ? `<defs>${defs}</defs>\n` : ''}${body}\n</svg>\n`;
}

/** The rounded-square app icon (512 units): gradient ground, the master mark, and on a dark page a hairline so the tile does not melt into it. */
function tile(edition, { id, rim }) {
  const p = edition.dark;
  const defs = `<linearGradient id="${id}" x1="0" y1="0" x2="0.35" y2="1"><stop offset="0" stop-color="${p.top}"/><stop offset="1" stop-color="${p.bottom}"/></linearGradient>`;
  const body =
    `<rect width="512" height="512" rx="112" fill="url(#${id})"/>` +
    (rim ? '<rect x="1.5" y="1.5" width="509" height="509" rx="110.5" fill="none" stroke="#FFFFFF" stroke-opacity="0.22" stroke-width="3"/>' : '') +
    markElements(colorsOf(p));
  return { defs, body };
}

/** The bare mark (no tile) with its own tight box, for a light or a dark page. */
function bareMark(palette) {
  return markElements(colorsOf(palette));
}

const MARK_BOX = { x: 96, y: 116, width: 320, height: 280 };

function lockupHorizontal(edition, tone) {
  const dark = tone === 'ondark';
  const palette = dark ? edition.dark : edition.light;
  const iconSize = 320;
  const textX = iconSize + 72;
  const nameSize = 104;
  const name = textPath(fonts.bold, edition.wordmark, { size: nameSize, tracking: 0.22, x: textX, y: 150 });
  const descriptor = textPath(fonts.medium, edition.productName, { size: 38, tracking: 0.01, x: textX, y: 274 });
  const width = Math.max(name.x + name.width, descriptor.x + descriptor.width);
  const t = tile(edition, { id: `g-h-${edition.id}-${tone}`, rim: dark });
  const body =
    `<g transform="scale(${iconSize / 512})">${t.body}</g>` +
    `<path d="${name.d}" fill="${palette.text}"/>` +
    `<rect x="${textX}" y="212" width="132" height="7" rx="3.5" fill="${palette.accent}"/>` +
    `<path d="${descriptor.d}" fill="${palette.textSoft}"/>`;
  return { width, height: iconSize, body, defs: t.defs };
}

function lockupStacked(edition, tone) {
  const dark = tone === 'ondark';
  const palette = dark ? edition.dark : edition.light;
  const iconSize = 360;
  const runs = [
    { font: fonts.bold, text: edition.wordmark, size: 112, tracking: 0.26, y: iconSize + 190 },
    { font: fonts.medium, text: edition.productName, size: 40, tracking: 0.02, y: iconSize + 304 },
    { font: fonts.regular, text: edition.tagline, size: 32, tracking: 0.01, y: iconSize + 362 },
  ];
  const width = Math.max(...runs.map((run) => textPath(run.font, run.text, run).width));
  const cx = width / 2;
  const [n, d, g] = runs.map((run) => textPath(run.font, run.text, { ...run, x: cx, anchor: 'middle' }));
  const t = tile(edition, { id: `g-s-${edition.id}-${tone}`, rim: dark });
  const body =
    `<g transform="translate(${num(cx - iconSize / 2)} 0) scale(${iconSize / 512})">${t.body}</g>` +
    `<path d="${n.d}" fill="${palette.text}"/>` +
    `<rect x="${num(cx - 66)}" y="${iconSize + 238}" width="132" height="7" rx="3.5" fill="${palette.accent}"/>` +
    `<path d="${d.d}" fill="${palette.text}"/>` +
    `<path d="${g.d}" fill="${palette.textSoft}"/>`;
  return { width, height: iconSize + 362 + 12, body, defs: t.defs };
}

/** The film still: gradient, concentric rings, the stacked lockup in the middle (1920 x 1080). */
function hero(edition) {
  const p = edition.dark;
  const stacked = lockupStacked(edition, 'ondark');
  const scale = 0.9;
  const w = stacked.width * scale;
  const h = stacked.height * scale;
  const cx = 960;
  const cy = 540;
  const rings = [250, 380, 520, 680, 860]
    .map((r, i) => `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#FFFFFF" stroke-opacity="${[0.16, 0.12, 0.09, 0.06, 0.04][i]}" stroke-width="2"/>`)
    .join('');
  const defs =
    `<linearGradient id="hero-bg-${edition.id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${p.top}"/><stop offset="1" stop-color="${p.bottom}"/></linearGradient>` +
    `<radialGradient id="hero-glow-${edition.id}" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="${p.barMid}" stop-opacity="0.28"/><stop offset="1" stop-color="${p.barMid}" stop-opacity="0"/></radialGradient>` +
    stacked.defs;
  const body =
    `<rect width="1920" height="1080" fill="url(#hero-bg-${edition.id})"/>` +
    `<rect width="1920" height="1080" fill="url(#hero-glow-${edition.id})"/>` +
    rings +
    `<circle cx="${cx}" cy="${cy}" r="330" fill="none" stroke="${p.accent}" stroke-opacity="0.45" stroke-width="2" stroke-dasharray="2 14" stroke-linecap="round"/>` +
    `<g transform="translate(${num(cx - w / 2)} ${num(cy - h / 2)}) scale(${scale})">${stacked.body}</g>`;
  return { width: 1920, height: 1080, body, defs };
}

function markOnly(edition, tone) {
  const palette = tone === 'ondark' ? edition.dark : edition.light;
  return { width: MARK_BOX.width, height: MARK_BOX.height, body: `<g transform="translate(${-MARK_BOX.x} ${-MARK_BOX.y})">${bareMark(palette)}</g>`, defs: '' };
}

function iconOnly(edition) {
  const t = tile(edition, { id: `g-i-${edition.id}`, rim: false });
  return { width: 512, height: 512, body: t.body, defs: t.defs };
}

export function build() {
  mkdirSync(logoDir, { recursive: true });
  const jobs = [];
  const index = { name: 'MẠCH VỐN', codeName: 'MACHVON', version: 1, generatedBy: 'brand/build.mjs', font: 'Be Vietnam Pro (OFL), words drawn as outlines', output: outDir, editions: {} };
  for (const edition of Object.values(EDITIONS)) {
    const id = edition.id;
    const files = {};
    const add = (key, name, lockup, { svg = true, png = true, pngWidth = 2048, background } = {}) => {
      const title = `${edition.wordmark} - ${edition.productName}`;
      const svgText = svgDoc(lockup.width, lockup.height, lockup.body, { defs: lockup.defs, title });
      if (svg) writeFileSync(join(logoDir, `${name}.svg`), svgText);
      if (png) jobs.push({ svg: svgText, width: lockup.width, height: lockup.height, pngWidth, name: `${name}.png`, background });
      files[key] = { svg: svg ? `brand/logo/${name}.svg` : undefined, png: png ? `${name}.png` : undefined, aspect: num(lockup.width / lockup.height) };
    };
    add('icon', `logo-${id}-icon`, iconOnly(edition));
    add('markOnLight', `logo-${id}-mark`, markOnly(edition, 'onlight'));
    add('markOnDark', `logo-${id}-mark-ondark`, markOnly(edition, 'ondark'));
    add('horizontal', `logo-${id}-horizontal`, lockupHorizontal(edition, 'onlight'));
    add('horizontalOnDark', `logo-${id}-horizontal-ondark`, lockupHorizontal(edition, 'ondark'));
    add('stacked', `logo-${id}-stacked`, lockupStacked(edition, 'onlight'));
    add('stackedOnDark', `logo-${id}-stacked-ondark`, lockupStacked(edition, 'ondark'));
    add('hero', `logo-${id}-hero`, hero(edition), { pngWidth: 3840 });
    index.editions[id] = {
      wordmark: edition.wordmark,
      productName: { vi: edition.productName, en: edition.productNameEn },
      tagline: { vi: edition.tagline },
      colors: {
        onDark: { gradientTop: edition.dark.top, gradientBottom: edition.dark.bottom, tile: edition.dark.background, pillarLow: edition.dark.barLow, chevron: edition.dark.barMid, pillarHigh: edition.dark.barHigh, accent: edition.dark.accent, text: edition.dark.text, textSoft: edition.dark.textSoft },
        onLight: { pillarLow: edition.light.barLow, chevron: edition.light.barMid, pillarHigh: edition.light.barHigh, accent: edition.light.accent, text: edition.light.text, textSoft: edition.light.textSoft },
      },
      files,
    };
  }
  return { jobs, index };
}

async function exportPng(jobs) {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch();
  try {
    for (const job of jobs) {
      const scale = job.pngWidth / job.width;
      const page = await browser.newPage({ viewport: { width: Math.ceil(job.width), height: Math.ceil(job.height) }, deviceScaleFactor: scale });
      await page.setContent(`<!doctype html><html><body style="margin:0;background:${job.background ?? 'transparent'}">${job.svg.replace('<svg ', `<svg style="display:block" `)}</body></html>`);
      await page.screenshot({ path: join(outDir, job.name), omitBackground: true, clip: { x: 0, y: 0, width: job.width, height: job.height } });
      await page.close();
    }
  } finally {
    await browser.close();
  }
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const { jobs, index } = build();
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'brand.json'), `${JSON.stringify(index, null, 2)}\n`);
  if (!argv.includes('--no-png')) await exportPng(jobs);
  process.stdout.write(`brand: ${jobs.length} files, index at ${join(outDir, 'brand.json')}; mark shapes: ${MARK.length}\n`);
}
