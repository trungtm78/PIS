const escapeHtml = (text) => String(text).replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;').replace(/"/gu, '&quot;');

/** A link to the row of a screen in the table of the screens (the row opens the chapter and the moment that shows it). */
const chip = (id, screens) =>
  `<a class="chip" href="#screen-${escapeHtml(id)}" title="${escapeHtml(screens.get(id)?.title ?? id)}">${escapeHtml(id)}${screens.has(id) ? ` · ${escapeHtml(screens.get(id).title)}` : ''}</a>`;

/** The screens each module has, by platform: what the card of a module says about how much of it there is to see. */
export function countsOf(catalogue) {
  const counts = new Map();
  for (const screen of catalogue) {
    const entry = counts.get(screen.module) ?? { web: 0, mobile: 0, name: screen.moduleName };
    if (screen.platform === 'mobile') entry.mobile += 1;
    else entry.web += 1;
    entry.name = entry.name ?? screen.moduleName;
    counts.set(screen.module, entry);
  }
  return counts;
}

/** The modules a chapter belongs to: a tour names its module, a flow is listed in the overview. */
export const modulesOfChapter = (chapter, flowModules) => (chapter.module === undefined ? (flowModules[chapter.id] ?? []) : [chapter.module]);

const moduleLinks = (codes) => codes.map((code) => `<a class="chip" href="#pm-${escapeHtml(code)}">${escapeHtml(code)}</a>`).join(' ');

/** The part of the guide that says what the system is for: its value, the business chain, the controls, the modules and the phone. */
export function overviewHtml(overview, { catalogue, screens, chapters }) {
  const counts = countsOf(catalogue);
  const names = (code) => counts.get(code)?.name ?? code;
  const values = `<section id="gia-tri"><h2>${escapeHtml(overview.valueTitle)}</h2><p>${escapeHtml(overview.valueLead)}</p>
<div class="cards">${overview.values.map((value) => `<article class="card"><h4>${escapeHtml(value.title)}</h4><p>${escapeHtml(value.text)}</p></article>`).join('\n')}</div></section>`;
  const chain = `<section id="chuoi-nghiep-vu"><h2>${escapeHtml(overview.lifecycleTitle)}</h2><p>${escapeHtml(overview.lifecycleLead)}</p>
<ol class="chain">${overview.lifecycle
    .map(
      (step) => `<li><h4>${escapeHtml(step.name)}</h4>
<p class="mods">${moduleLinks(step.modules)}</p>
<dl><dt>Ai làm</dt><dd>${escapeHtml(step.who)}</dd><dt>Làm gì</dt><dd>${escapeHtml(step.does)}</dd><dt>Hệ thống kiểm soát</dt><dd>${escapeHtml(step.control)}</dd><dt>Kết quả</dt><dd>${escapeHtml(step.result)}</dd></dl></li>`,
    )
    .join('\n')}</ol></section>`;
  const governance = `<section id="quan-tri"><h2>${escapeHtml(overview.governanceTitle)}</h2><p>${escapeHtml(overview.governanceLead)}</p>
<div class="cards">${overview.governance
    .map(
      (control) => `<article class="card"><h4>${escapeHtml(control.name)}</h4><p>${escapeHtml(control.what)}</p><p><strong>Với người lãnh đạo:</strong> ${escapeHtml(control.forLeader)}</p><p class="screens">Xem ở: ${control.see.map((id) => chip(id, screens)).join(' ')}</p></article>`,
    )
    .join('\n')}</div></section>`;
  const modules = `<section id="phan-he"><h2>${escapeHtml(overview.modulesTitle)}</h2><p>${escapeHtml(overview.modulesLead)}</p>
<div class="cards">${overview.modules
    .map((module) => {
      const count = counts.get(module.code) ?? { web: 0, mobile: 0 };
      const related = chapters.filter((chapter) => modulesOfChapter(chapter, overview.flowModules ?? {}).includes(module.code));
      const sizes = [count.web > 0 ? `${count.web} màn hình web` : '', count.mobile > 0 ? `${count.mobile} màn hình điện thoại` : ''].filter((part) => part !== '').join(' · ');
      return `<article class="card" id="pm-${escapeHtml(module.code)}"><h4>${escapeHtml(names(module.code))} <small>(${escapeHtml(module.code)})</small></h4><p>${escapeHtml(module.does)}</p>
<p><strong>Ai dùng:</strong> ${escapeHtml(module.users)}</p><p><strong>Đóng góp cho quản trị:</strong> ${escapeHtml(module.governance)}</p>
<p class="meta">${escapeHtml(sizes)}${related.length > 0 ? ` · Clip: ${related.map((chapter) => `<a href="#ch-${escapeHtml(chapter.id)}">${escapeHtml(chapter.title)}</a>`).join('; ')}` : ''}</p></article>`;
    })
    .join('\n')}</div></section>`;
  const phone = `<section id="dien-thoai"><h2>${escapeHtml(overview.phoneTitle)}</h2><p>${escapeHtml(overview.phoneLead)}</p>
<table><thead><tr><th>Người dùng</th><th>Làm được gì trên điện thoại</th></tr></thead><tbody>${overview.phoneItems.map((item) => `<tr><td>${escapeHtml(item.who)}</td><td>${escapeHtml(item.does)}</td></tr>`).join('')}</tbody></table></section>`;
  return { values, chain, governance, modules, phone };
}
