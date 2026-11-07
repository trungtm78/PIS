import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { narration, voice } from './bridge.ts';
import type { CatalogueScreen, Facts, TourChapter } from './bridge.ts';
import { Clip } from './recorder.ts';
import type { Ui } from './recorder.ts';

/**
 * The tours of the guide: one clip for each group of screens of a module. For each chapter the screens are opened first (to see what is really on them
 * with the data the system holds now), the words are made from the catalogue of the design and from what was found, the voice is made, and then the
 * clip is filmed. Chapters are chosen with `HDSD_CHAPTERS=id,id`.
 */
const ROOT = join(process.cwd(), '..', '..');
const chapters = (JSON.parse(readFileSync(join(ROOT, 'scripts', 'hdsd', 'chapters.json'), 'utf8')) as TourChapter[]).filter((chapter) => chapter.kind === 'tour');
const wanted = (process.env.HDSD_CHAPTERS ?? '').split(',').filter((id) => id !== '');
const catalogue = new Map((JSON.parse(readFileSync(join(ROOT, 'Design', 'MACHVON_Design', '03_Engineering', 'screen_catalog.json'), 'utf8')) as CatalogueScreen[]).map((screen) => [screen.id, screen]));
const paths = new Map(((JSON.parse(readFileSync(join(ROOT, 'apps', 'web', 'src', 'routes', 'routes.generated.json'), 'utf8')) as { routes: { id: string; path: string }[] }).routes).map((route) => [route.id, route.path]));
/** The people of a unit in the order they are tried: the one who does the work, the leader who decides, the one who pays, the administrator, the owner. A screen is shown with the first who may open it. */
const PERSONAS = ['projectManager', 'capApprover', 'treasuryMaker', 'unitAdmin', 'owner'];
/** The person each screen is shown with (found while the screens are looked at). */
const personaOf = new Map<string, string>();

const idOfPath = new Map([...paths].map(([id, path]) => [path, id]));
/** Where a record of a screen is opened: the links the other screens show (a row of a list leads to the workspace of its record), kept for the whole run. */
const harvested = new Map<string, string>();

const withUser = (url: string, persona: string): string => `${url}${url.includes('?') ? '&' : '?'}devUser=${persona}`;
const urlOf = (id: string, opened?: string, persona = personaOf.get(id) ?? PERSONAS[0] ?? 'owner'): string => withUser(opened ?? paths.get(id) ?? '/', persona);

/** The links in a screen to the other screens of the system, so that a screen that needs a record can be opened with one. */
async function harvest(page: Page): Promise<void> {
  const links = await page.evaluate(() => Array.from(document.querySelectorAll('[data-screen-id] a[href], main a[href]')).map((anchor) => anchor.getAttribute('href') ?? ''));
  for (const link of links) {
    const id = idOfPath.get(link.split('?')[0] ?? '');
    if (id === undefined) continue;
    const known = harvested.get(id);
    if (known === undefined || (link.includes('?') && !known.includes('?'))) harvested.set(id, link);
  }
}

/** Waits for a screen to have drawn: the screen itself, and no part of it still loading. */
async function settle(page: Page): Promise<void> {
  await page.waitForSelector('[data-screen-id], [role="alert"], [role="status"]', { timeout: 30_000 });
  await page.waitForFunction(() => document.querySelector('[aria-busy="true"]') === null, undefined, { timeout: 15_000 }).catch(() => undefined);
  await page.waitForTimeout(700);
}

/**
 * A screen that waits for a choice (a project, a period: the box shows a dash or "Chọn ...") is opened the way a person opens it: the first real
 * choice is made, and the screen shows its data. A filter that already says "all" is left alone.
 */
async function choose(page: Page, ui?: Ui): Promise<void> {
  for (let round = 0; round < 3; round += 1) {
    const boxes = page.locator('[data-screen-id] select, main select');
    const total = await boxes.count();
    let chose = false;
    for (let index = 0; index < total; index += 1) {
      const box = boxes.nth(index);
      const shown = (await box.evaluate((element) => (element as HTMLSelectElement).selectedOptions[0]?.textContent ?? '')).trim();
      const options = await box.locator('option').count();
      if (options > 1 && (shown === '' || shown === '—' || shown === '-' || /^chọn/i.test(shown))) {
        if (ui !== undefined) await ui.point(box);
        await box.selectOption({ index: 1 });
        await page.waitForTimeout(900);
        chose = true;
        break;
      }
    }
    if (!chose) return;
  }
}

async function probe(page: Page): Promise<Facts> {
  return page.evaluate(() => {
    const root = document.querySelector('[data-screen-id]') ?? document.querySelector('main') ?? document.body;
    const clean = (text: string | null | undefined): string => (text ?? '').replace(/\s+/g, ' ').trim();
    const unique = (items: string[]): string[] => [...new Set(items.filter((item) => item !== ''))];
    const labels = unique(Array.from(root.querySelectorAll('label, th, [role="columnheader"], dt, legend, h2, h3, [role="tab"]')).map((element) => clean(element.textContent)).filter((text) => text.length <= 60));
    // Only what a person can see is an action of the screen (the filter button of the kit is hidden on a desktop width and opens the panel on a phone).
    const buttons = unique(
      Array.from(root.querySelectorAll('button, [role="button"], [role="tab"]'))
        .filter((element) => element.getClientRects().length > 0)
        .map((element) => clean(element.getAttribute('aria-label') ?? element.textContent)),
    );
    // A record is a row of a table (not the row that carries the empty or the error message of the kit's table), a tree item, a list item or a card; the figure tiles of the kit are cards too but not records.
    const rows = root.querySelectorAll('tbody tr:not(.ui-table__row--message), [role="treeitem"], [role="listitem"], article:not(.ui-kpi)').length;
    const text = clean(root.textContent);
    const alert = clean(root.querySelector('[role="alert"]')?.textContent);
    return {
      labels,
      buttons,
      rows,
      empty: /chưa có dữ liệu|không có dữ liệu/i.test(text),
      denied: /không đủ quyền|không có quyền|bị từ chối/i.test(alert),
      needsRecord: /chưa chọn|hãy mở .* từ danh sách|không tìm thấy/i.test(text),
    };
  });
}

// A chapter that was filmed is not filmed again unless HDSD_REDO=1: a run that was cut short goes on where it stopped.
const done = (id: string): boolean => process.env.HDSD_REDO !== '1' && existsSync(join(ROOT, 'docs', 'hdsd', 'machvon', `${id}.timeline.json`));

for (const chapter of chapters.filter((candidate) => (wanted.length === 0 || wanted.includes(candidate.id)) && !done(candidate.id))) {
  test(`tour ${chapter.id}`, async ({ browser }) => {
    test.setTimeout(1_800_000);
    const screens = chapter.screens.map((id) => catalogue.get(id)).filter((screen): screen is CatalogueScreen => screen !== undefined);
    expect(screens.length).toBe(chapter.screens.length);

    // 1. What is on the screens now.
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, locale: 'vi-VN' });
    const page = await context.newPage();
    const facts = new Map<string, Facts>();
    const opened = new Map<string, string>();
    for (const screen of screens) {
      for (const persona of PERSONAS) {
        await page.goto(urlOf(screen.id, undefined, persona));
        await settle(page);
        await choose(page);
        await harvest(page);
        const seen = await probe(page);
        facts.set(screen.id, seen);
        personaOf.set(screen.id, persona);
        if (!seen.denied) break;
      }
    }
    // A screen that waits for a record is opened again with one, from a link that another screen showed.
    for (const screen of screens) {
      const link = harvested.get(screen.id);
      if (facts.get(screen.id)?.needsRecord !== true || link === undefined) continue;
      await page.goto(urlOf(screen.id, link));
      await settle(page);
      await choose(page);
      opened.set(screen.id, link);
      facts.set(screen.id, await probe(page));
    }
    await context.close();

    // 2. The words and the voice.
    const flow = (await narration()).composeTour(chapter, screens, facts);
    writeFileSync(join(ROOT, 'scripts', 'hdsd', 'flows', `${chapter.id}.json`), `${JSON.stringify(flow, null, 2)}\n`);
    const audio = (await voice()).narrate(chapter.id);

    // 3. The film.
    const clip = new Clip(flow, browser, { steps: audio.steps });
    const ui = await clip.open();
    for (const screen of screens) {
      await clip.step(screen.id.toLowerCase(), async (_ui, { budgetMs }) => {
        await ui.page.goto(urlOf(screen.id, opened.get(screen.id)));
        await settle(ui.page);
        await choose(ui.page, ui);
        const title = ui.page.getByRole('heading', { level: 1 }).first();
        if ((await title.count()) > 0) await ui.spot(title, () => ui.wait(900));
        await ui.scrollThrough(Math.max(1000, budgetMs - 2800));
      });
    }
    await clip.finish();
    // The film, the voice and the pictures of the chapter are put together at once, so that a cut run loses nothing that was filmed.
    execFileSync(process.execPath, [join(ROOT, 'scripts', 'hdsd', 'mux.mjs'), chapter.id], { stdio: 'inherit' });
  });
}
