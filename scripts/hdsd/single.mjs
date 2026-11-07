import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadChapters } from './chapters.mjs';
import { REPO_ROOT, cacheDir, loadFlow, mmss } from './lib.mjs';
import { coverageOf, screensById } from './site.mjs';
import { FFMPEG } from './tts.mjs';

const CATALOGUE = join('Design', 'MACHVON_Design', '03_Engineering', 'screen_catalog.json');

const ROUTES = join('apps', 'web', 'src', 'routes', 'routes.generated.json');

const escapeHtml = (text) => String(text).replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;').replace(/"/gu, '&quot;');

/** The bytes of a file as a `data:` address, so that the page needs nothing but itself. */
export const dataUri = (mime, bytes) => `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`;

/** How the film and the pictures are shrunk for the single file: the screens are still, so a low rate keeps the text readable. */
export const PACK = { fps: 10, crf: 34, audioKbps: 32, imageWidth: 960, imageQuality: 7 };

function ffmpeg(args) {
  const done = spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8' });
  if (done.status !== 0) throw new Error(`ffmpeg failed: ${done.stderr}`);
}

const fresh = (target, ...sources) => existsSync(target) && sources.every((source) => statSync(target).mtimeMs >= statSync(source).mtimeMs);

/** The film of a chapter shrunk for the single file (kept in the cache, made again only when the film changed). */
export function packFilm(id, { root = REPO_ROOT, cache = cacheDir(), pack = PACK } = {}) {
  const source = join(root, 'docs', 'hdsd', 'machvon', 'clips', `${id}.mp4`);
  const target = join(cache, 'pack', `${id}.mp4`);
  mkdirSync(dirname(target), { recursive: true });
  if (!fresh(target, source)) {
    ffmpeg(['-i', source, '-vf', `fps=${pack.fps}`, '-c:v', 'libx264', '-preset', 'slow', '-crf', String(pack.crf), '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', `${pack.audioKbps}k`, '-ac', '1', '-ar', '24000', '-movflags', '+faststart', target]);
  }
  return target;
}

/** A picture of a step as a small JPEG. */
export function packImage(png, target, { pack = PACK } = {}) {
  mkdirSync(dirname(target), { recursive: true });
  if (!fresh(target, png)) ffmpeg(['-i', png, '-vf', `scale=${pack.imageWidth}:-1`, '-q:v', String(pack.imageQuality), target]);
  return target;
}

/** The map of the menu: for each module its groups, each with the titles of its screens, from the route table of the web application. */
export function menuOf(routes, moduleNames) {
  const modules = new Map();
  for (const route of routes) {
    const groups = modules.get(route.module) ?? new Map();
    groups.set(route.group, [...(groups.get(route.group) ?? []), route.title]);
    modules.set(route.module, groups);
  }
  return [...modules].map(([module, groups]) => ({
    group: moduleNames.get(module) ?? module,
    items: [...groups].map(([group, titles]) => `${group}: ${titles.join('; ')}`).join('. '),
  }));
}

const chips = (ids, screens) =>
  ids
    .map((id) => `<a class="chip" href="#screen-${escapeHtml(id)}" title="${escapeHtml(screens.get(id)?.title ?? id)}">${escapeHtml(id)}${screens.has(id) ? ` · ${escapeHtml(screens.get(id).title)}` : ''}</a>`)
    .join(' ');

/** One chapter of the guide, with its film, captions and the steps (each with a button that moves the film to that moment). */
export function chapterSection(flow, timeline, screens, assets, number) {
  const steps = flow.steps
    .map((step, index) => {
      const entry = timeline.find((candidate) => candidate.id === step.id);
      if (entry === undefined) return '';
      return `<li class="step" id="${escapeHtml(flow.id)}--${escapeHtml(step.id)}">
  <button class="at" data-seek="${(entry.voiceMs / 1000).toFixed(1)}" aria-label="Phát từ ${mmss(entry.voiceMs)}">▶ ${mmss(entry.voiceMs)}</button>
  <div class="step-body">
    <h4>${index + 1}. ${escapeHtml(step.heading)}</h4>
    ${step.screens.length > 0 ? `<p class="screens">Màn hình: ${chips(step.screens, screens)}</p>` : ''}
    <p>${escapeHtml(step.text)}</p>
    ${step.note ? `<p class="note">${escapeHtml(step.note)}</p>` : ''}
    <img loading="lazy" src="${assets.image(flow.id, step.id)}" alt="Màn hình ở bước: ${escapeHtml(step.heading)}">
  </div>
</li>`;
    })
    .join('\n');
  return `<section class="chapter-block" id="ch-${escapeHtml(flow.id)}">
  <h3><span class="num">${number}</span>${escapeHtml(flow.title)}</h3>
  <p class="meta"><strong>Dành cho:</strong> ${escapeHtml(flow.audience)}<br><strong>Bạn sẽ làm được:</strong> ${escapeHtml(flow.outcome)}</p>
  <figure class="player">
    <video controls preload="none" playsinline poster="${assets.poster(flow.id)}" src="${assets.film(flow.id)}" aria-label="Clip hướng dẫn: ${escapeHtml(flow.title)}">
      <track kind="captions" srclang="vi" label="Tiếng Việt" src="${assets.captions(flow.id)}" default>
    </video>
    <figcaption>Clip có giọng đọc tiếng Việt và phụ đề. Bấm vào mốc thời gian bên dưới để nhảy tới đúng đoạn.</figcaption>
  </figure>
  <details class="steps"><summary>Các bước trong clip (${timeline.length})</summary><ol class="steps">
${steps}
  </ol></details>
</section>`;
}

/** The table of the screens with a search box: each screen has the chapter and the moment that shows it, or the reason it is not filmed. */
export function screensSection(catalogue, coverage, reasons) {
  const byModule = new Map();
  for (const screen of catalogue) byModule.set(screen.moduleName ?? screen.module, [...(byModule.get(screen.moduleName ?? screen.module) ?? []), screen]);
  const tables = [...byModule]
    .map(([module, list]) => {
      const rows = list
        .map((screen) => {
          const shown = coverage.shown.get(screen.id) ?? [];
          const cell =
            shown.length > 0
              ? shown.map((place) => `<a href="#${escapeHtml(place.flow)}--${escapeHtml(place.step)}" data-open>${escapeHtml(place.chapter)} · ${mmss(place.startMs)}</a>`).join('<br>')
              : `<span class="pending">${escapeHtml(reasons.get(screen.id) ?? 'Chưa quay')}</span>`;
          const detail = shown.length > 0 ? `<br><small>${escapeHtml(shown[0].text)}</small>` : '';
          return `<tr id="screen-${escapeHtml(screen.id)}" data-find="${escapeHtml(`${screen.id} ${screen.title}`.toLowerCase())}"><td><code>${escapeHtml(screen.id)}</code></td><td>${escapeHtml(screen.title)}${detail}</td><td>${cell}</td></tr>`;
        })
        .join('\n');
      return `<h4>${escapeHtml(module)} (${list.length})</h4>\n<table><thead><tr><th>Mã</th><th>Màn hình</th><th>Xem trong clip</th></tr></thead><tbody>\n${rows}\n</tbody></table>`;
    })
    .join('\n');
  return `<section id="tra-cuu"><h2>Tra cứu màn hình</h2>
<p>${coverage.covered} trên ${coverage.total} màn hình có đoạn hướng dẫn trong clip. Màn nào chưa quay thì ghi rõ lý do.</p>
<input id="find" type="search" placeholder="Gõ mã hoặc tên màn hình để lọc, ví dụ: PRJ-02 hoặc thanh toán" aria-label="Lọc màn hình">
${tables}
</section>`;
}

const SCRIPT = `
document.querySelectorAll('button.at').forEach((button) => button.addEventListener('click', () => {
  const clip = button.closest('.chapter-block').querySelector('video');
  clip.currentTime = Number(button.dataset.seek);
  clip.play();
  clip.scrollIntoView({ behavior: 'smooth', block: 'center' });
}));
const openTarget = () => {
  const target = location.hash ? document.getElementById(decodeURIComponent(location.hash.slice(1))) : null;
  const details = target && target.closest('details');
  if (details) details.open = true;
  if (target) target.scrollIntoView({ block: 'center' });
};
window.addEventListener('hashchange', openTarget);
openTarget();
const find = document.getElementById('find');
if (find) find.addEventListener('input', () => {
  const words = find.value.toLowerCase().trim();
  document.querySelectorAll('#tra-cuu tbody tr').forEach((row) => { row.hidden = words !== '' && !row.dataset.find.includes(words); });
});
`;

/** The whole guide in one page: nothing outside it is needed to read it or to play the clips. */
export function guideHtml({ intro, content, chapters, screens, assets, catalogue, coverage, reasons, built }) {
  const groups = new Map();
  chapters.forEach((chapter, index) => groups.set(chapter.group ?? 'Khác', [...(groups.get(chapter.group ?? 'Khác') ?? []), { ...chapter, number: index + 1 }]));
  const toc = [...groups]
    .map(
      ([group, list]) => `<h4>${escapeHtml(group)}</h4>
<ul class="toc">${list.map((chapter) => `<li><a href="#ch-${escapeHtml(chapter.id)}"><span class="num">${chapter.number}</span>${escapeHtml(chapter.title)}</a><small>${escapeHtml(chapter.audience)} · ${mmss(chapter.durationMs)}</small></li>`).join('\n')}</ul>`,
    )
    .join('\n');
  const roles = content.roles.length === 0 ? '' : `<section id="vai-tro"><h2>Ai dùng hệ thống</h2><p>${escapeHtml(content.rolesIntro)}</p><table><thead><tr><th>Vai trò</th><th>Làm được gì</th></tr></thead><tbody>${content.roles.map((role) => `<tr><td>${escapeHtml(role.name)}</td><td>${escapeHtml(role.does)}</td></tr>`).join('')}</tbody></table></section>`;
  const menu = content.menu.length === 0 ? '' : `<section id="thuc-don"><h2>Bản đồ thực đơn</h2>${content.menu.map((group) => `<h4>${escapeHtml(group.group)}</h4><p>${escapeHtml(group.items)}</p>`).join('')}</section>`;
  const faq = content.faq.length === 0 ? '' : `<section id="hoi-dap"><h2>Câu hỏi thường gặp</h2>${content.faq.map((item) => `<details class="faq"><summary>${escapeHtml(item.q)}</summary><p>${escapeHtml(item.a)}</p></details>`).join('')}</section>`;
  const glossary = content.glossary.length === 0 ? '' : `<section id="thuat-ngu"><h2>Thuật ngữ</h2><dl>${content.glossary.map((item) => `<dt>${escapeHtml(item.term)}</dt><dd>${escapeHtml(item.means)}</dd>`).join('')}</dl></section>`;
  const sections = chapters.map((chapter, index) => chapterSection(chapter.flow, chapter.timeline, screens, assets, index + 1)).join('\n');
  return `<!doctype html>
<html lang="vi">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(intro.title)}</title>
<style>${readFileSync(join(REPO_ROOT, 'docs', 'hdsd', 'machvon', 'style.css'), 'utf8')}
.top nav{display:inline-flex;gap:16px;margin-left:24px;flex-wrap:wrap}.top a{text-decoration:none}
section[id]{scroll-margin-top:60px}h4{margin:1.2em 0 .3em}details.steps>summary,details.faq>summary{cursor:pointer;font-weight:600;margin:6px 0}details.faq{background:#fff;border:1px solid var(--line);border-radius:8px;padding:8px 14px;margin:8px 0}
.chapter-block{background:#fbfaf9;border:1px solid var(--line);border-radius:14px;padding:18px 20px;margin:26px 0}.chapter-block h3{font-size:22px;margin:.2em 0 .5em}
#find{width:100%;padding:12px 14px;border:1px solid var(--line);border-radius:8px;font-size:16px;margin:10px 0}dt{font-weight:700;margin-top:.8em}dd{margin:0 0 0 1em}
</style>
</head>
<body>
<header class="top"><strong>MACHVON</strong><nav><a href="#gioi-thieu">Giới thiệu</a><a href="#vai-tro">Vai trò</a><a href="#muc-luc">Các chương</a><a href="#thuc-don">Thực đơn</a><a href="#tra-cuu">Tra cứu màn hình</a><a href="#hoi-dap">Hỏi đáp</a><a href="#thuat-ngu">Thuật ngữ</a></nav></header>
<main class="chapter home">
<section class="hero"><h1>${escapeHtml(intro.title)}</h1><p>${escapeHtml(intro.lead)}</p><span class="badge">${chapters.length} clip hướng dẫn · ${coverage.covered}/${coverage.total} màn hình · bản ${escapeHtml(built)}</span></section>
<section id="gioi-thieu"><h2>Giới thiệu</h2>${intro.paragraphs.map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`).join('\n')}</section>
${roles}
<section id="bat-dau"><h2>Bắt đầu nhanh</h2><ol>${intro.quickStart.map((item) => `<li>${escapeHtml(item)}</li>`).join('\n')}</ol></section>
<section id="muc-luc"><h2>Các chương theo thứ tự công việc</h2>${toc}</section>
<section id="cac-chuong"><h2>Nội dung các chương</h2>
${sections}
</section>
${menu}
${screensSection(catalogue, coverage, reasons)}
${faq}
${glossary}
<section id="ghi-chu"><h2>Ghi chú về tài liệu</h2>${(content.notes ?? []).map((note) => `<p>${escapeHtml(note)}</p>`).join('')}</section>
</main>
<script>${SCRIPT}</script>
</body>
</html>
`;
}

/** Gathers the chapters that were filmed and writes the one file. */
export function buildSingle({ root = REPO_ROOT, cache = cacheDir(), out, log = console.log } = {}) {
  const docs = join(root, 'docs', 'hdsd');
  const machvon = join(docs, 'machvon');
  const catalogue = JSON.parse(readFileSync(join(root, CATALOGUE), 'utf8'));
  const screens = screensById(catalogue);
  const chapters = loadChapters(root)
    .filter((chapter) => existsSync(join(machvon, `${chapter.id}.timeline.json`)))
    .map((chapter) => {
      const flow = loadFlow(chapter.id, root);
      const timeline = JSON.parse(readFileSync(join(machvon, `${chapter.id}.timeline.json`), 'utf8')).timeline;
      return { id: flow.id, title: flow.title, audience: flow.audience, group: flow.group, flow, timeline, durationMs: Math.max(...timeline.map((entry) => entry.endMs)) };
    });
  const timelines = new Map(chapters.map((chapter) => [chapter.id, chapter.timeline]));
  const coverage = coverageOf(catalogue, chapters.map((chapter) => chapter.flow), timelines);
  const reasonsFile = join(root, 'scripts', 'hdsd', 'not-filmed.json');
  const reasons = new Map(existsSync(reasonsFile) ? Object.entries(JSON.parse(readFileSync(reasonsFile, 'utf8'))) : []);
  const intro = JSON.parse(readFileSync(join(root, 'scripts', 'hdsd', 'site.json'), 'utf8'));
  const contentFile = join(root, 'scripts', 'hdsd', 'content.json');
  const content = { roles: [], rolesIntro: '', menu: [], faq: [], glossary: [], notes: [], ...(existsSync(contentFile) ? JSON.parse(readFileSync(contentFile, 'utf8')) : {}) };
  if (content.menu.length === 0) {
    const names = new Map(catalogue.filter((screen) => screen.platform === 'web').map((screen) => [screen.module, screen.moduleName]));
    content.menu = menuOf(JSON.parse(readFileSync(join(root, ROUTES), 'utf8')).routes, names);
  }

  const assets = {
    film: (id) => dataUri('video/mp4', readFileSync(packFilm(id, { root, cache }))),
    captions: (id) => dataUri('text/vtt', readFileSync(join(machvon, 'clips', `${id}.vi.vtt`))),
    poster: (id) => dataUri('image/jpeg', readFileSync(packImage(join(machvon, 'img', id, 'poster.jpg'), join(cache, 'pack', id, 'poster.jpg')))),
    image: (id, step) => dataUri('image/jpeg', readFileSync(packImage(join(machvon, 'img', id, `${step}.png`), join(cache, 'pack', id, `${step}.jpg`)))),
  };
  const html = guideHtml({ intro, content, chapters, screens, assets, catalogue, coverage, reasons, built: new Date().toISOString().slice(0, 10) });
  const target = out ?? join(docs, 'Huong-dan-su-dung-MACHVON.html');
  writeFileSync(target, html);
  const megabytes = statSync(target).size / 1_048_576;
  log(`${target}: ${megabytes.toFixed(1)} MB, ${chapters.length} chapters, ${coverage.covered}/${coverage.total} screens`);
  return { target, megabytes, chapters: chapters.length, covered: coverage.covered, total: coverage.total };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) buildSingle();
