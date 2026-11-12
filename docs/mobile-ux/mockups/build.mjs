// Builds the self-contained mockups (fonts inlined, no network) and renders one PNG per phone screen.
//   node docs/mobile-ux/mockups/build.mjs [a|b|all] [--png]
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../../..');
const fontCss = () => {
  const f = (file, weight) => `@font-face{font-family:'Be Vietnam Pro';font-weight:${weight};font-style:normal;src:url(data:font/ttf;base64,${readFileSync(join(ROOT, 'apps/mobile/assets/fonts', file)).toString('base64')}) format('truetype')}`;
  return `${f('BeVietnamPro-Regular.ttf', 400)}${f('BeVietnamPro-Medium.ttf', 500)}${f('BeVietnamPro-SemiBold.ttf', 600)}`;
};

const which = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'all';
const png = process.argv.includes('--png');
const dirs = which === 'all' ? ['a', 'b'] : [which];

export function page(mod, { theme = 'light' } = {}) {
  const cells = mod.screens.map(([n, name, fn]) => `<div class="cell"><div class="cap">${n}. ${name}</div>${fn()}</div>`).join('');
  return `<!DOCTYPE html>
<html lang="vi" data-theme="${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${mod.meta.name} (mockup, dữ liệu minh họa)</title>
<style>${fontCss()}${mod.css}
.legend{padding:24px 32px 0;font:600 15px/22px 'Be Vietnam Pro',sans-serif;color:#122D3B}
.gallery{display:grid;grid-template-columns:repeat(6,390px);gap:32px 40px;width:max-content}
.legend small{display:block;font:400 13px/20px 'Be Vietnam Pro',sans-serif;color:#33505C}
</style></head><body>
<div class="legend">${mod.meta.name}: ${mod.meta.tagline}<small>Hệ thống quản lý đầu tư công, bản dành cho cơ quan nhà nước. Mọi tên, mã và số liệu là dữ liệu minh họa. Khung 390 x 844.</small></div>
<div class="gallery">${cells}</div></body></html>`;
}

const outDir = join(HERE);
mkdirSync(join(outDir, 'png'), { recursive: true });
for (const d of dirs) {
  const mod = await import(pathToFileURL(join(HERE, 'src', `direction-${d}.mjs`)).href);
  writeFileSync(join(outDir, `direction-${d}.html`), page(mod));
  console.log('wrote', `direction-${d}.html`);
}

if (png) {
  const { chromium } = await import(pathToFileURL(join(ROOT, 'node_modules/playwright-core/index.mjs')).href);
  const browser = await chromium.launch();
  for (const d of dirs) {
    const ctx = await browser.newContext({ viewport: { width: 2700, height: 1000 }, deviceScaleFactor: 2 });
    const pg = await ctx.newPage();
    await pg.goto(pathToFileURL(join(outDir, `direction-${d}.html`)).href);
    await pg.evaluate(() => document.fonts.ready);
    const shots = await pg.$$('.screen');
    const mod = await import(pathToFileURL(join(HERE, 'src', `direction-${d}.mjs`)).href);
    for (let i = 0; i < shots.length; i += 1) {
      const file = join(outDir, 'png', `direction-${d}-${mod.screens[i][0]}.png`);
      await shots[i].screenshot({ path: file });
    }
    console.log('rendered', shots.length, 'screens of direction', d);
    await ctx.close();
  }
  await browser.close();
}
