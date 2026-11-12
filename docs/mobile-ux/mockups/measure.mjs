// Measures the rendered mockups (runtime audit of the proposal, same idea as ui-runtime-audit): rows or cards fully visible in the first view,
// smallest interactive element, distinct font sizes, distinct component classes, shadows and gradients per screen.
//   node docs/mobile-ux/mockups/measure.mjs > docs/mobile-ux/mockups/measure.json
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../../..');
const { chromium } = await import(pathToFileURL(join(ROOT, 'node_modules/playwright-core/index.mjs')).href);
const browser = await chromium.launch();
const out = {};
for (const d of ['a', 'b']) {
  const pg = await (await browser.newContext({ viewport: { width: 2700, height: 1000 } })).newPage();
  await pg.goto(pathToFileURL(join(HERE, `direction-${d}.html`)).href);
  await pg.evaluate(() => document.fonts.ready);
  out[d] = await pg.evaluate(() => {
    const res = [];
    document.querySelectorAll('.cell').forEach((cell) => {
      const name = cell.querySelector('.cap').textContent;
      const screen = cell.querySelector('.screen');
      const sr = screen.getBoundingClientRect();
      const scroll = screen.querySelector('.scroll');
      const vis = scroll ? scroll.getBoundingClientRect() : sr;
      const items = [...screen.querySelectorAll('.rw,.tcard,.dcard,.acard,.lrow,.nrow')];
      const full = items.filter((e) => { const r = e.getBoundingClientRect(); return r.top >= vis.top - 1 && r.bottom <= vis.bottom + 1; });
      const targets = [...screen.querySelectorAll('.btn,.ib,.chip,.fchip,.u,.tb,.seg .s,.nav .t,.set,.fab,.link')].map((e) => { const r = e.getBoundingClientRect(); return { cls: e.className.toString().split(' ')[0], w: Math.round(r.width), h: Math.round(r.height) }; }).filter((t) => t.w > 0);
      const small = targets.filter((t) => t.h < 44 || t.w < 44).map((t) => `${t.cls} ${t.w}x${t.h}`);
      const sizes = new Set(); const shadows = []; let gradients = 0;
      screen.querySelectorAll('*').forEach((e) => {
        const cs = getComputedStyle(e);
        if (e.childNodes.length && [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) sizes.add(cs.fontSize);
        if (cs.boxShadow && cs.boxShadow !== 'none') shadows.push(1);
        if (cs.backgroundImage && cs.backgroundImage.includes('gradient')) gradients += 1;
      });
      res.push({ name, itemsFullyVisible: full.length, itemsTotal: items.length, smallTargets: [...new Set(small)].slice(0, 6), fontSizes: [...sizes].sort((x, y) => parseFloat(x) - parseFloat(y)).join(' '), shadows: shadows.length, gradients });
    });
    return res;
  });
}
await browser.close();
console.log(JSON.stringify(out, null, 1));
