import { mmss } from './lib.mjs';

const escapeHtml = (text) => String(text).replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;').replace(/"/gu, '&quot;');

/** The catalogue of the screens by id, from the screen catalogue of the design. */
export function screensById(catalogue) {
  return new Map(catalogue.map((screen) => [screen.id, screen]));
}

/** Where each screen is shown: the chapter and the moment, from the steps of the flows and the times the recording measured. */
export function coverageOf(catalogue, flows, timelines) {
  const shown = new Map();
  for (const flow of flows) {
    const timeline = timelines.get(flow.id);
    if (timeline === undefined) continue;
    for (const step of flow.steps) {
      const entry = timeline.find((candidate) => candidate.id === step.id);
      if (entry === undefined) continue;
      for (const id of step.screens) {
        const list = shown.get(id) ?? [];
        list.push({ flow: flow.id, chapter: flow.title, step: step.id, heading: step.heading, startMs: entry.voiceMs, text: step.text, note: step.note ?? '' });
        shown.set(id, list);
      }
    }
  }
  const covered = catalogue.filter((screen) => shown.has(screen.id));
  return { shown, covered: covered.length, total: catalogue.length };
}

const shell = ({ title, body, css = 'style.css' }) => `<!doctype html>
<html lang="vi">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="${css}">
</head>
<body>
${body}
</body>
</html>
`;

const screenChips = (ids, screens) =>
  ids
    .map((id) => {
      const screen = screens.get(id);
      return `<a class="chip" href="man-hinh.html#${escapeHtml(id)}" title="${escapeHtml(screen?.title ?? id)}">${escapeHtml(id)}${screen === undefined ? '' : ` · ${escapeHtml(screen.title)}`}</a>`;
    })
    .join(' ');

/** The page of one chapter: the film with its voice and captions, and the steps with the moment each begins (a click moves the film there). */
export function chapterHtml(flow, timeline, screens, { number, previous, next } = {}) {
  const steps = flow.steps
    .map((step, index) => {
      const entry = timeline.find((candidate) => candidate.id === step.id);
      if (entry === undefined) return '';
      const seconds = (entry.voiceMs / 1000).toFixed(1);
      return `<li class="step" id="${escapeHtml(step.id)}">
  <button class="at" data-seek="${seconds}" aria-label="Phát từ ${mmss(entry.voiceMs)}">▶ ${mmss(entry.voiceMs)}</button>
  <div class="step-body">
    <h3>${index + 1}. ${escapeHtml(step.heading)}</h3>
    ${step.screens.length > 0 ? `<p class="screens">Màn hình: ${screenChips(step.screens, screens)}</p>` : ''}
    <p>${escapeHtml(step.text)}</p>
    ${step.note ? `<p class="note">${escapeHtml(step.note)}</p>` : ''}
    <img loading="lazy" src="img/${escapeHtml(flow.id)}/${escapeHtml(step.id)}.png" alt="Màn hình ở bước: ${escapeHtml(step.heading)}">
  </div>
</li>`;
    })
    .join('\n');
  const body = `<header class="top"><a href="../Huong-dan-su-dung-MACHVON.html">← Mục lục</a></header>
<main class="chapter">
  <h1>${number === undefined ? '' : `<span class="num">${number}</span>`}${escapeHtml(flow.title)}</h1>
  <p class="meta"><strong>Dành cho:</strong> ${escapeHtml(flow.audience)}<br><strong>Bạn sẽ làm được:</strong> ${escapeHtml(flow.outcome)}</p>
  <figure class="player">
    <video id="clip" controls preload="metadata" playsinline poster="img/${escapeHtml(flow.id)}/poster.jpg" src="clips/${escapeHtml(flow.id)}.mp4" aria-label="Clip hướng dẫn: ${escapeHtml(flow.title)}">
      <track kind="captions" srclang="vi" label="Tiếng Việt" src="clips/${escapeHtml(flow.id)}.vi.vtt" default>
    </video>
    <figcaption>Clip có giọng đọc tiếng Việt và phụ đề. Bấm vào mốc thời gian bên dưới để nhảy tới đúng đoạn.</figcaption>
  </figure>
  <h2>Các bước trong clip (${timeline.length})</h2>
  <ol class="steps">
${steps}
  </ol>
  <nav class="pager">${previous ? `<a href="${escapeHtml(previous.id)}.html">← ${escapeHtml(previous.title)}</a>` : '<span></span>'}${next ? `<a href="${escapeHtml(next.id)}.html">${escapeHtml(next.title)} →</a>` : '<span></span>'}</nav>
</main>
<script>
document.querySelectorAll('button.at').forEach((button) => button.addEventListener('click', () => {
  const clip = document.getElementById('clip');
  clip.currentTime = Number(button.dataset.seek);
  clip.play();
  clip.scrollIntoView({ behavior: 'smooth', block: 'center' });
}));
</script>`;
  return shell({ title: `${flow.title} · Hướng dẫn sử dụng MACHVON`, body });
}

/** The table of the screens: each one with the chapter and the moment that shows it, or the reason it is not filmed. */
export function screensHtml(catalogue, coverage, reasons = new Map()) {
  const byModule = new Map();
  for (const screen of catalogue) byModule.set(screen.moduleName ?? screen.module, [...(byModule.get(screen.moduleName ?? screen.module) ?? []), screen]);
  const sections = [...byModule]
    .map(([module, list]) => {
      const rows = list
        .map((screen) => {
          const shown = coverage.shown.get(screen.id) ?? [];
          const cell =
            shown.length > 0
              ? shown.map((place) => `<a href="${escapeHtml(place.flow)}.html#${escapeHtml(place.step)}">${escapeHtml(place.chapter)} · ${mmss(place.startMs)}</a>`).join('<br>')
              : `<span class="pending">${escapeHtml(reasons.get(screen.id) ?? 'Chưa quay')}</span>`;
          const detail = shown.length > 0 ? `<br><small>${escapeHtml(shown[0].text)}</small>` : '';
          return `<tr id="${escapeHtml(screen.id)}"><td><code>${escapeHtml(screen.id)}</code></td><td>${escapeHtml(screen.title)}${detail}</td><td>${cell}</td></tr>`;
        })
        .join('\n');
      return `<h2>${escapeHtml(module)} (${list.length})</h2>\n<table><thead><tr><th>Mã</th><th>Màn hình</th><th>Xem trong clip</th></tr></thead><tbody>\n${rows}\n</tbody></table>`;
    })
    .join('\n');
  const body = `<header class="top"><a href="../Huong-dan-su-dung-MACHVON.html">← Mục lục</a></header>
<main class="chapter"><h1>Tra cứu màn hình</h1>
<p class="meta">${coverage.covered} trên ${coverage.total} màn hình đã có đoạn hướng dẫn trong clip. Các màn còn lại ghi rõ lý do chưa quay.</p>
${sections}
</main>`;
  return shell({ title: 'Tra cứu màn hình · Hướng dẫn sử dụng MACHVON', body });
}

/** The first page: what the system is, how to start, and the chapters in the order of the work. */
export function indexHtml({ chapters, coverage, intro }) {
  const groups = new Map();
  chapters.forEach((chapter, index) => groups.set(chapter.group ?? 'Khác', [...(groups.get(chapter.group ?? 'Khác') ?? []), { ...chapter, number: index + 1 }]));
  const toc = [...groups]
    .map(
      ([group, list]) => `<h3>${escapeHtml(group)}</h3>
<ul class="toc">${list.map((chapter) => `<li><a href="machvon/${escapeHtml(chapter.id)}.html"><span class="num">${chapter.number}</span>${escapeHtml(chapter.title)}</a><small>${escapeHtml(chapter.audience)} · ${mmss(chapter.durationMs)}</small></li>`).join('\n')}</ul>`,
    )
    .join('\n');
  const body = `<main class="chapter home">
<section class="hero"><h1>${escapeHtml(intro.title)}</h1><p>${escapeHtml(intro.lead)}</p><span class="badge">${chapters.length} clip hướng dẫn · ${coverage.covered}/${coverage.total} màn hình</span></section>
<section><h2>Giới thiệu</h2>${intro.paragraphs.map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`).join('\n')}</section>
<section><h2>Bắt đầu nhanh</h2><ol>${intro.quickStart.map((item) => `<li>${escapeHtml(item)}</li>`).join('\n')}</ol></section>
<section><h2>Các chương theo thứ tự công việc</h2>${toc}</section>
<section><h2>Tra cứu</h2><p><a href="machvon/man-hinh.html">Tra cứu theo màn hình</a>: mỗi màn hình dẫn tới đúng mốc trong clip.</p></section>
</main>`;
  return shell({ title: intro.title, body, css: 'machvon/style.css' });
}
