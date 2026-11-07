import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadChapters } from './chapters.mjs';
import { REPO_ROOT, loadFlow } from './lib.mjs';
import { chapterHtml, coverageOf, indexHtml, screensById, screensHtml } from './site.mjs';

const CATALOGUE = join('Design', 'MACHVON_Design', '03_Engineering', 'screen_catalog.json');

/** Writes the pages of the guide from the flows, the measured timelines and the catalogue of screens. */
export function build(root = REPO_ROOT, log = console.log) {
  const docs = join(root, 'docs', 'hdsd');
  const out = join(docs, 'machvon');
  mkdirSync(out, { recursive: true });
  const catalogue = JSON.parse(readFileSync(join(root, CATALOGUE), 'utf8'));
  const screens = screensById(catalogue);
  // The chapters follow the order of the work (scripts/hdsd/chapters.json); a chapter that was not filmed yet is not in the guide.
  const flows = loadChapters(root)
    .filter((chapter) => existsSync(join(out, `${chapter.id}.timeline.json`)))
    .map((chapter) => loadFlow(chapter.id, root));
  const timelines = new Map(flows.map((flow) => [flow.id, JSON.parse(readFileSync(join(out, `${flow.id}.timeline.json`), 'utf8')).timeline]));
  const coverage = coverageOf(catalogue, flows, timelines);
  const reasonsFile = join(root, 'scripts', 'hdsd', 'not-filmed.json');
  const reasons = new Map(existsSync(reasonsFile) ? Object.entries(JSON.parse(readFileSync(reasonsFile, 'utf8'))) : []);

  flows.forEach((flow, index) => {
    const timeline = timelines.get(flow.id);
    const page = chapterHtml(flow, timeline, screens, { number: index + 1, previous: flows[index - 1], next: flows[index + 1] });
    writeFileSync(join(out, `${flow.id}.html`), page);
  });
  writeFileSync(join(out, 'man-hinh.html'), screensHtml(catalogue, coverage, reasons));
  const chapters = flows.map((flow) => ({ id: flow.id, title: flow.title, audience: flow.audience, group: flow.group, durationMs: Math.max(...timelines.get(flow.id).map((entry) => entry.endMs)) }));
  const intro = JSON.parse(readFileSync(join(root, 'scripts', 'hdsd', 'site.json'), 'utf8'));
  writeFileSync(join(docs, 'Huong-dan-su-dung-MACHVON.html'), indexHtml({ chapters, coverage, intro }));
  const missing = catalogue.filter((screen) => !coverage.shown.has(screen.id) && !reasons.has(screen.id)).length;
  log(`${flows.length} chapters; ${coverage.covered}/${coverage.total} screens shown; ${reasons.size} with a reason; ${missing} neither shown nor explained`);
  return { chapters: flows.length, covered: coverage.covered, total: coverage.total, missing };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) build();
