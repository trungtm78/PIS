// Direction B v2, "Dòng việc": list first. One row pattern for every list, hairlines instead of boxes, large titles, one dark brand anchor (the command band of the leader home),
// decisions confirmed in a bottom sheet. Six required screens, then the states and modes that make it a system (sheet, empty, offline, loading, dark, 200% text, settings, quick create, project list).
import { icon } from './icons.mjs';
import { TOKENS_CSS, BASE_CSS } from './tokens.mjs';
import * as D from './data.mjs';

export const meta = { id: 'b', name: 'Hướng B v2: Dòng việc', tagline: 'Một kiểu hàng cho mọi danh sách, tiêu đề lớn, dải điều hành tối ở trang chủ lãnh đạo, xác nhận bằng bottom sheet' };

// Text scale demo: the system font at 200%. Rule of the design: Display and Title stop at 1.3x and so do the tab labels (they would not fit five to a row);
// body, label and caption follow the system up to 2.0x and no key text is cut (line clamps are lifted from 1.5x).
const scaleTokens = (k) => {
  const cap = 1.3;
  const f = (px, lh, kk = k) => `${Math.round(px * kk)}px/${Math.round(lh * kk)}px`;
  return `--t-display:600 ${f(32, 40, cap)} 'Be Vietnam Pro',sans-serif;--t-title:600 ${f(22, 30, cap)} 'Be Vietnam Pro',sans-serif;--t-heading:600 ${f(16, 24)} 'Be Vietnam Pro',sans-serif;--t-body:400 ${f(15, 22)} 'Be Vietnam Pro',sans-serif;--t-label:600 ${f(13, 20)} 'Be Vietnam Pro',sans-serif;--t-caption:400 ${f(12, 18)} 'Be Vietnam Pro',sans-serif;--t-body-strong:600 ${f(15, 22)} 'Be Vietnam Pro',sans-serif;--t-caption-strong:600 ${f(12, 16)} 'Be Vietnam Pro',sans-serif;`;
};

const CSS = `
${TOKENS_CSS}${BASE_CSS}
.screen{background:var(--mv2-surface);color:var(--mv2-ink)}
.t200{${scaleTokens(2)}}
.hd{background:var(--mv2-header);color:var(--mv2-on-header)}
.top{display:flex;align-items:center;min-height:48px;padding:0 4px;flex:none}
.top .sp{flex:1}
.ib{width:48px;height:48px;display:grid;place-items:center;border-radius:24px;flex:none}
.lt{padding:0 16px 8px;flex:none}
.lt h1{font:var(--t-display);letter-spacing:-.01em}
.lt .sub{font:var(--t-caption);color:var(--mv2-ink-2);margin-top:2px}
.hd .lt .sub{color:var(--mv2-on-header-2)}
.meta{font:var(--t-caption);color:var(--mv2-ink-2)}
.link{display:inline-flex;align-items:center;min-height:44px;padding:0 8px;font:var(--t-label);color:var(--mv2-primary-strong);white-space:nowrap}
.nav{display:flex;background:var(--mv2-surface);border-top:1px solid var(--mv2-line);min-height:64px;flex:none}
.nav .t{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;font:var(--t-caption-strong);color:var(--mv2-ink-2);position:relative}
.nav .on{color:var(--mv2-primary-strong)}
.nav .on::before{content:"";position:absolute;top:-1px;left:22%;right:22%;height:3px;border-radius:0 0 3px 3px;background:var(--mv2-primary)}
.nav .ic-w{position:relative;display:inline-flex}
.nav .cnt{position:absolute;top:-6px;left:14px;min-width:18px;height:18px;border-radius:9px;background:var(--mv2-late-mark);color:#fff;font:600 12px/18px 'Be Vietnam Pro',sans-serif;text-align:center;padding:0 4px}
[data-theme="dark"] .nav .cnt{color:#2A0905}
/* the three bands: shape + words + colour, never colour alone. late = bold text on a tinted glyph, soon = same with a triangle, ok = quiet with a clock */
.due{display:inline-flex;align-items:center;gap:4px;font:var(--t-label);white-space:nowrap}
.due-late{color:var(--mv2-late-fg)}.due-soon{color:var(--mv2-soon-fg)}.due-ok{color:var(--mv2-ok-fg)}
.glyph{width:40px;height:40px;border-radius:12px;display:grid;place-items:center;flex:none}
.glyph.late{background:var(--mv2-late-bg);color:var(--mv2-late-fg)}.glyph.soon{background:var(--mv2-soon-bg);color:var(--mv2-soon-fg)}.glyph.ok{background:var(--mv2-ok-bg);color:var(--mv2-ok-fg)}
.glyph.info{background:var(--mv2-info-bg);color:var(--mv2-info-fg)}.glyph.pri{background:var(--mv2-primary-soft);color:var(--mv2-primary-strong)}
/* the one row */
.rw{display:flex;gap:12px;padding:12px 16px;align-items:flex-start;position:relative;min-height:64px}
.rw+.rw::before{content:"";position:absolute;top:0;left:68px;right:0;height:1px;background:var(--mv2-line)}
.rw .t{font:var(--t-body-strong)}
.rw .tr{display:flex;flex-direction:column;align-items:flex-end;gap:4px;flex:none;max-width:116px;text-align:right}
.rw .m{min-width:0;flex:1}
.t200 .clamp2{display:block;-webkit-line-clamp:unset;overflow:visible}.t200 .clamp1{white-space:normal;overflow:visible}
.t200 .nav .t{font-size:16px;line-height:20px}.t200 .nav .t{text-align:center}
.t200 .rw{flex-wrap:wrap}
.t200 .rw .m{flex:1 1 60%}
.t200 .rw .tr{max-width:none;width:100%;flex-direction:row;align-items:center;justify-content:flex-start;gap:12px;margin-left:52px;text-align:left}
.grp{display:flex;align-items:center;gap:8px;padding:8px 16px;background:var(--mv2-bg);font:var(--t-label);color:var(--mv2-ink-2);border-top:1px solid var(--mv2-line);border-bottom:1px solid var(--mv2-line)}
.grp .n{margin-left:auto;font:var(--t-caption)}
.utabs{display:flex;padding:0 16px;gap:20px;border-bottom:1px solid var(--mv2-line);flex:none;overflow:hidden}
.utabs .u{min-height:48px;min-width:48px;justify-content:center;padding:0 4px;display:flex;align-items:center;gap:6px;font:var(--t-label);color:var(--mv2-ink-2);position:relative;white-space:nowrap}
.utabs .on{color:var(--mv2-ink)}
.utabs .on::after{content:"";position:absolute;left:0;right:0;bottom:-1px;height:3px;background:var(--mv2-primary);border-radius:3px 3px 0 0}
.chips{display:flex;gap:8px;padding:8px 16px;flex:none;overflow:hidden}
.chip{display:inline-flex;align-items:center;gap:6px;min-height:44px;padding:0 14px;border-radius:var(--r-chip);border:1.5px solid var(--mv2-outline);font:var(--t-label);white-space:nowrap}
.chip.on{background:var(--mv2-ink);color:var(--mv2-surface);border-color:var(--mv2-ink)}
/* leader command band */
.hero{padding:0 16px 20px}
.hero .lab{font:var(--t-label);color:var(--mv2-on-header-2)}
.hero .big{font:var(--t-display);display:flex;align-items:baseline;gap:8px;margin-top:2px}
.hero .big small{font:var(--t-label);color:var(--mv2-on-header-2)}
.hero .bar{height:10px;border-radius:5px;background:var(--mv2-header-2);overflow:hidden;margin-top:12px}
.hero .bar i{display:block;height:100%;background:var(--mv2-accent-on-dark);border-radius:5px}
.hero .foot{display:flex;justify-content:space-between;margin-top:8px;font:var(--t-caption);color:var(--mv2-on-header-2)}
.stat{display:grid;grid-template-columns:1fr 1fr 1fr;border-bottom:1px solid var(--mv2-line)}
.stat>div{padding:12px 0 12px 16px;border-left:1px solid var(--mv2-line)}
.stat>div:first-child{border-left:0}
.stat .n{font:var(--t-title)}
.stat .l{font:var(--t-caption);color:var(--mv2-ink-2)}
.stat .m{margin-top:4px}
/* project header */
.pname{font:var(--t-title);padding:0 16px}
.kvs{display:flex;gap:16px;padding:8px 16px 0;font:var(--t-caption);color:var(--mv2-ink-2)}
.kvs b{color:var(--mv2-ink);font-weight:600}
.segs{display:grid;grid-template-columns:repeat(6,1fr);gap:4px;margin:12px 16px 0}
.segs i{height:8px;border-radius:4px;background:var(--mv2-line)}
.segs i.d{background:var(--mv2-primary)}
.segs i.c{position:relative;overflow:hidden}.segs i.c::after{content:"";position:absolute;inset:0 42% 0 0;background:var(--mv2-primary)}
.seglab{display:flex;justify-content:space-between;gap:4px;margin:6px 16px 0;font:var(--t-caption);color:var(--mv2-ink-3)}
.seglab .c{color:var(--mv2-ink);font-weight:600}
.pbar{height:6px;border-radius:3px;background:var(--mv2-sunken);overflow:hidden;width:72px}
.pbar i{display:block;height:100%;background:var(--mv2-primary)}
/* detail */
.dl{display:flex;justify-content:space-between;gap:16px;padding:10px 16px;border-top:1px solid var(--mv2-line);font:var(--t-body)}
.dl .k{color:var(--mv2-ink-2);flex:none}.dl .v{font:var(--t-body-strong);text-align:right}
.stline{display:flex;align-items:center;gap:8px;padding:0 16px;font:var(--t-title)}
.stline.late{color:var(--mv2-late-fg)}.stline.soon{color:var(--mv2-soon-fg)}
.doc{display:flex;gap:12px;align-items:center;padding:12px 16px;position:relative}
.doc+.doc::before{content:"";position:absolute;top:0;left:56px;right:0;height:1px;background:var(--mv2-line)}
.doc .nm{font:var(--t-body)}
.actbar{flex:none;background:var(--mv2-surface);border-top:1px solid var(--mv2-line);box-shadow:var(--e2);padding:12px 16px 14px;display:flex;flex-direction:column;gap:8px;position:relative;z-index:1}
.actbar .why{display:flex;align-items:center;gap:6px;font:var(--t-caption);color:var(--mv2-late-fg)}
.acts{display:flex;gap:8px}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:48px;padding:0 16px;border-radius:var(--r-ctl);font:var(--t-body-strong);flex:1;text-align:center}
.btn-primary{background:var(--mv2-primary);color:var(--mv2-on-primary)}
.btn-quiet{background:var(--mv2-surface);color:var(--mv2-primary-strong);border:1.5px solid var(--mv2-outline)}
.btn-off{background:var(--mv2-sunken);color:var(--mv2-ink-3)}
.udot{width:10px;height:10px;border-radius:5px;background:var(--mv2-primary);flex:none;margin-top:7px}
.tag{font:var(--t-caption-strong);color:var(--mv2-ink-2);display:flex;align-items:center;gap:4px}
/* sheet */
.scrim{position:absolute;inset:0;background:rgba(10,32,41,.55);z-index:2}
.sheet{position:absolute;left:0;right:0;bottom:0;z-index:3;background:var(--mv2-surface);border-radius:20px 20px 0 0;box-shadow:var(--e2);padding:8px 16px 28px;display:flex;flex-direction:column;gap:12px}
.sheet .grab{width:36px;height:4px;border-radius:2px;background:var(--mv2-line-strong);align-self:center}
.sheet h2{font:var(--t-title)}
.fact{display:flex;gap:10px;font:var(--t-body);align-items:flex-start}
.fact .ic{margin-top:2px;color:var(--mv2-primary-strong)}
.actgrid{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.tile{display:flex;flex-direction:column;gap:8px;padding:14px;border:1.5px solid var(--mv2-line);border-radius:var(--r-card);font:var(--t-body-strong)}
.tile .glyph{width:44px;height:44px}
/* states */
.empty{display:flex;flex-direction:column;align-items:center;text-align:center;gap:12px;padding:56px 32px 0}
.empty .glyph{width:72px;height:72px;border-radius:36px}
.empty h2{font:var(--t-title)}
.empty p{font:var(--t-body);color:var(--mv2-ink-2)}
.banner{display:flex;gap:10px;align-items:flex-start;padding:12px 16px;background:var(--mv2-info-bg);color:var(--mv2-info-fg);font:var(--t-caption-strong);border-bottom:1px solid var(--mv2-line)}
.banner .ic{margin-top:1px}
.sk{background:var(--mv2-line);border-radius:6px}
/* settings */
.set{display:flex;align-items:center;gap:12px;padding:12px 16px;min-height:56px;position:relative}
.set+.set::before{content:"";position:absolute;top:0;left:16px;right:0;height:1px;background:var(--mv2-line)}
.set .k{font:var(--t-body);flex:1}
.step{display:inline-flex;align-items:center;border:1.5px solid var(--mv2-outline);border-radius:var(--r-ctl);overflow:hidden}
.step b{width:48px;height:48px;display:grid;place-items:center;color:var(--mv2-primary-strong)}
.step span{min-width:44px;text-align:center;font:var(--t-body-strong)}
.prev{display:flex;flex-direction:column;gap:8px;padding:0 16px 12px}
.prev .pv{display:flex;align-items:center;gap:10px;padding:8px 12px;border-radius:var(--r-ctl);font:var(--t-label)}
.pv.late{background:var(--mv2-late-bg);color:var(--mv2-late-fg)}.pv.soon{background:var(--mv2-soon-bg);color:var(--mv2-soon-fg)}.pv.ok{background:var(--mv2-ok-bg);color:var(--mv2-ok-fg)}
.fab{position:absolute;right:16px;bottom:16px;z-index:1;height:56px;padding:0 20px;border-radius:16px;background:var(--mv2-primary);color:var(--mv2-on-primary);display:flex;gap:8px;align-items:center;font:var(--t-body-strong);box-shadow:var(--e2)}
`;

const navItems = [['home', 'Trang chủ'], ['building', 'Dự án'], ['clipcheck', 'Phê duyệt'], ['bell', 'Thông báo'], ['user', 'Cá nhân']];
const nav = (active, counts = { 2: 4, 3: 3 }) => `<nav class="nav" aria-label="Điều hướng chính">${navItems.map(([ic, label], i) => `<div class="t ${i === active ? 'on' : ''}"><span class="ic-w">${icon(ic, 24)}${counts[i] ? `<span class="cnt">${counts[i]}</span>` : ''}</span>${label}</div>`).join('')}</nav>`;
const due = (b) => `<span class="due due-${b.key}">${icon(b.icon, 16)}${b.text}</span>`;
const shell = (inner, { theme, scale, topDark } = {}) => `<div class="screen ${scale ? 't200' : ''}" ${theme ? `data-theme="${theme}"` : ''}><div class="inset-top ${topDark ? 'hd' : ''}"></div>${inner}<div class="inset-bottom" style="background:var(--mv2-surface)"></div></div>`;
const proj = (k) => D.projects[k];
const gl = (b, size = 22) => `<div class="glyph ${b.key}">${icon(b.icon, size)}</div>`;
const row = (b, title, meta, trailing, opts = {}) => `<div class="rw">${gl(b)}<div class="m"><div class="t ${opts.clamp === 1 ? 'clamp1' : 'clamp2'}">${title}</div><div class="meta clamp1">${meta}</div></div><div class="tr">${trailing}</div></div>`;
const taskRow = (t) => { const b = D.band(t.days); const p = proj(t.project); return row(b, t.title, `${p.code} · ${t.docs[0]}/${t.docs[1]} chứng từ`, `${due(b)}<span class="meta">hạn ${t.due}</span>`); };
const officerGroups = () => [['Trễ hạn và đến hạn hôm nay', D.tasks.filter((t) => t.days <= 0)], ['Sắp đến hạn', D.tasks.filter((t) => t.days > 0 && t.days <= 3)], ['Còn thời gian', D.tasks.filter((t) => t.days > 3)]];
const groupsHtml = () => officerGroups().map(([name, ts]) => `<div class="grp">${name}<span class="n">${ts.length}</span></div>${ts.map(taskRow).join('')}`).join('');
const topBar = (right = [['search']]) => `<div class="top"><span class="sp"></span>${right.map(([ic]) => `<div class="ib">${icon(ic, 24)}</div>`).join('')}</div>`;

// 1. leader home
const leaderHome = () => shell(`
  <div class="hd">
    <div class="top"><span class="sp"></span><div class="ib">${icon('search', 24)}</div></div>
    <div class="lt"><h1>Tổng quan</h1><div class="sub">${D.scope} · ${D.month}</div></div>
    <div class="hero"><div class="lab">Giải ngân lũy kế 2026 theo Kho bạc Nhà nước</div>
      <div class="big num">1.058,3<small>tỷ đồng</small></div>
      <div class="bar" role="img" aria-label="Đã giải ngân 58,1% kế hoạch vốn"><i style="width:58.1%"></i></div>
      <div class="foot"><span>58,1% kế hoạch vốn năm</span><span>Kế hoạch 1.820 tỷ đồng</span></div></div>
  </div>
  <div class="scroll">
  <div class="stat">
    <div><div class="n num">6<span class="meta">/32</span></div><div class="l">Dự án chậm giải ngân</div><div class="m"><span class="due due-soon">${icon('alertTriangle', 16)}Theo dõi</span></div></div>
    <div><div class="n num">5</div><div class="l">Việc quá hạn</div><div class="m"><span class="due due-late">${icon('alertOctagon', 16)}Quá hạn</span></div></div>
    <div><div class="n num">4</div><div class="l">Chờ bạn duyệt</div><div class="m"><span class="due due-soon">${icon('alertTriangle', 16)}Hạn ngày mai</span></div></div>
  </div>
  <div class="grp">Cần bạn quyết định<span class="n">${D.decisions.length}</span></div>
  ${D.decisions.map((d) => { const b = D.band(d.days); return row(b, d.title, d.from, `${due(b)}${d.amount ? `<span class="num" style="font:var(--t-label)">${D.money(d.amount)}</span>` : ''}`); }).join('')}
  </div>${nav(0)}`, { topDark: true });

// 2. officer home
const officerHome = (opts = {}) => shell(`
  ${topBar([['search'], ['filter']])}
  <div class="lt"><h1>Việc hôm nay</h1><div class="sub">Thứ Năm, 12/11/2026 · ${D.people.officer.name}</div></div>
  ${opts.banner || ''}
  <div class="utabs"><span class="u on">Của tôi <b>6</b></span><span class="u">Cả nhóm</span><span class="u">Đã xong</span></div>
  <div class="scroll">${opts.body || groupsHtml()}${opts.fab === false ? '' : `<div class="fab">${icon('plus', 22)}Báo cáo</div>`}</div>
  ${nav(0)}`, opts);

// 3. project detail
const projectDetail = () => {
  const p = proj('P017');
  const bandOf = (t) => (t.done ? { key: 'pri', icon: 'checkCircle' } : D.band(t.days));
  const trow = (t) => { const b = bandOf(t); return `<div class="rw">${gl(b, 20)}<div class="m"><div class="t clamp2" ${t.done ? 'style="font-weight:400;color:var(--mv2-ink-2)"' : ''}>${t.title}</div><div class="meta">${t.who}</div></div><div class="tr">${t.done ? `<span class="meta">xong ${t.done}</span>` : `${due(b)}<span class="meta">hạn ${t.due}</span>`}</div></div>`; };
  const attention = D.stageTasks.filter((t) => !t.done && t.days <= 3); const next = D.stageTasks.filter((t) => !t.done && t.days > 3); const done = D.stageTasks.filter((t) => t.done);
  return shell(`
  <div class="top"><div class="ib">${icon('chevL', 24)}</div><span class="meta" style="font-weight:600">${p.code}</span><span class="sp"></span><div class="ib">${icon('more', 24)}</div></div>
  <div class="pname clamp2">${p.name}</div>
  <div class="kvs"><span>${p.group}</span><span>Giải ngân <b class="num">63%</b></span><span>Hoàn thành <b class="num">${p.progress}%</b></span></div>
  <div class="segs" role="img" aria-label="Giai đoạn 4 trên 6: Thực hiện"><i class="d"></i><i class="d"></i><i class="d"></i><i class="c"></i><i></i><i></i></div>
  <div class="seglab"><span class="c">Giai đoạn 4/6 · Thực hiện</span><span>Việc xong 7/12</span></div>
  <div class="utabs" style="margin-top:8px"><span class="u">Tổng quan</span><span class="u on">Tiến độ</span><span class="u">Vốn</span><span class="u">Hồ sơ</span></div>
  <div class="scroll"><div class="grp">Cần chú ý<span class="n">${attention.length}</span></div>${attention.map(trow).join('')}<div class="grp">Sắp tới<span class="n">${next.length}</span></div>${next.map(trow).join('')}<div class="grp">Đã xong<span class="n">${done.length}</span></div>${done.map(trow).join('')}</div>
  ${nav(1)}`);
};

// 4. approval inbox
const approvals = () => shell(`
  ${topBar([['search'], ['filter']])}
  <div class="lt"><h1>Phê duyệt</h1></div>
  <div class="utabs"><span class="u on">Chờ tôi <b>4</b></span><span class="u">Đã xử lý</span><span class="u">Tôi gửi</span></div>
  <div class="scroll">${D.decisions.map((d) => { const b = D.band(d.days); return `<div class="rw" style="padding:14px 16px">${gl(b)}<div class="m"><div class="meta">${d.kind}</div><div class="t clamp2">${d.title}</div>${d.amount ? `<div class="num" style="font:var(--t-title);margin-top:2px">${D.money(d.amount)}</div>` : ''}<div class="meta clamp1" style="margin-top:2px">${d.from}</div><div class="meta" style="display:flex;gap:6px;align-items:center;margin-top:2px;color:var(--mv2-ok-fg)">${icon('checkCircle', 14)}<span class="clamp1">${d.checks}</span></div></div><div class="tr">${due(b)}${icon('chevR', 20)}</div></div>`; }).join('')}</div>
  ${nav(2)}`);

// 5. task detail
const taskDetail = () => {
  const t = D.taskDetail; const p = proj(t.project);
  return shell(`
  <div class="top"><div class="ib">${icon('chevL', 24)}</div><span class="meta" style="font-weight:600">Việc ${t.id}</span><span class="sp"></span><div class="ib">${icon('more', 24)}</div></div>
  <div class="scroll">
  <div class="stline late">${icon('alertOctagon', 26)}Trễ 2 ngày</div>
  <div class="meta" style="padding:2px 16px 8px 50px">Hạn 10/11/2026 · chưa dời lần nào</div>
  <div class="pname" style="padding-bottom:12px">${t.title}</div>
  <div class="dl"><span class="k">Dự án</span><span class="v">${p.code}</span></div>
  <div class="dl"><span class="k">Giai đoạn</span><span class="v">${t.stage}</span></div>
  <div class="dl"><span class="k">Người làm</span><span class="v">${t.owner}</span></div>
  <div class="dl"><span class="k">Người duyệt hoàn thành</span><span class="v">Hoàng Văn Hải</span></div>
  <div class="dl"><span class="k">Bắt đầu · hạn cơ sở</span><span class="v">03/11 · 10/11</span></div>
  <div class="grp" style="margin-top:12px">Chứng từ bắt buộc<span class="n">3/4 đã có</span></div>
  ${t.docs.map((d) => `<div class="doc"><div class="glyph ${d.ok ? 'ok' : 'late'}" style="width:32px;height:32px;border-radius:10px">${icon(d.ok ? 'check' : 'alertOctagon', 18)}</div><div class="m" style="flex:1;min-width:0"><div class="nm">${d.name}</div><div class="meta">${d.meta}</div></div>${d.ok ? icon('chevR', 20) : `<span class="link" style="display:flex;align-items:center;gap:4px">${icon('upload', 18)}Tải lên</span>`}</div>`).join('')}
  </div>
  <div class="actbar"><div class="why">${icon('info', 16)}Còn thiếu 1 chứng từ bắt buộc nên chưa hoàn thành được</div>
    <div class="acts"><span class="btn btn-quiet">${icon('calendar', 18)}Xin dời hạn</span><span class="btn btn-off">${icon('check', 18)}Hoàn thành</span></div></div>`);
};

// 6. notifications
const notifications = () => shell(`
  <div class="top"><span class="sp"></span><span class="link">Đọc hết</span><div class="ib">${icon('filter', 24)}</div></div>
  <div class="lt"><h1>Thông báo</h1></div>
  <div class="utabs"><span class="u on">Tất cả</span><span class="u">Hạn việc <b>2</b></span><span class="u">Phê duyệt <b>2</b></span><span class="u">Hệ thống</span></div>
  <div class="scroll">${['Hôm nay', 'Hôm qua'].map((g) => `<div class="grp">${g}</div>${D.notices.filter((n) => n.group === g).map((n) => `<div class="rw" style="min-height:72px">${n.unread ? '<span class="udot" role="img" aria-label="Chưa đọc"></span>' : '<span style="width:10px;flex:none"></span>'}<div class="m"><div class="t" ${n.unread ? '' : 'style="font-weight:400"'}>${n.title}</div><div class="meta clamp2" style="margin-top:2px">${n.body}</div><div class="tag" style="margin-top:4px">${icon(n.icon, 14)}${n.tag}</div></div><span class="meta" style="flex:none">${n.time}</span></div>`).join('')}`).join('')}</div>
  ${nav(3)}`);

// 7. approval detail with the confirmation sheet
const approveSheet = () => {
  const d = D.decisions[0]; const b = D.band(d.days);
  return shell(`
  <div class="top"><div class="ib">${icon('chevL', 24)}</div><span class="meta" style="font-weight:600">Hồ sơ ${d.id}</span><span class="sp"></span><div class="ib">${icon('more', 24)}</div></div>
  <div class="scroll">
    <div class="stline soon">${icon('alertTriangle', 26)}Còn 1 ngày</div>
    <div class="meta" style="padding:2px 16px 8px 50px">Hạn xử lý 13/11/2026</div>
    <div class="pname" >${d.title}</div>
    <div class="num" style="font:var(--t-display);padding:8px 16px">12<span class="meta" style="margin-left:8px">tỷ đồng</span></div>
    <div class="dl"><span class="k">Người gửi</span><span class="v">Nguyễn Thị Lan</span></div>
    <div class="dl"><span class="k">Từ dự án</span><span class="v">DA-CB-017</span></div>
    <div class="dl"><span class="k">Sang dự án</span><span class="v">DA-CB-023</span></div>
    <div class="dl"><span class="k">Tổng kế hoạch vốn</span><span class="v">1.820 tỷ, không đổi</span></div>
  </div>
  <div class="actbar"><div class="acts"><span class="btn btn-quiet">${icon('undo', 18)}Trả lại</span><span class="btn btn-primary">${icon('check', 18)}Phê duyệt</span></div></div>
  <div class="scrim"></div>
  <div class="sheet"><div class="grab"></div><h2>Phê duyệt hồ sơ này?</h2>
    <div class="fact">${icon('wallet', 20)}<span>Điều chuyển <b>12 tỷ đồng</b> từ DA-CB-017 sang DA-CB-023, tổng kế hoạch vốn năm 2026 không đổi.</span></div>
    <div class="fact">${icon('file', 20)}<span>Đủ 3/3 chứng từ. Hồ sơ do Nguyễn Thị Lan gửi 11/11 lúc 09:20.</span></div>
    <div class="fact">${icon('info', 20)}<span>Quyết định được ghi vào nhật ký kiểm toán dưới tên bạn và không rút lại được.</span></div>
    <span class="btn btn-primary" style="flex:none">${icon('check', 18)}Xác nhận phê duyệt</span><span class="btn btn-quiet" style="flex:none">Xem lại hồ sơ</span></div>`);
};

// 8. project list
const projectList = () => {
  const items = [['P017', 'late', 'Chậm 6 ngày', 58], ['P023', 'soon', 'Chậm 2 ngày', 41], ['P031', 'ok', 'Đúng tiến độ', 20], ['P044', 'ok', 'Đúng tiến độ', 74], ['P052', 'ok', 'Đúng tiến độ', 12]];
  return shell(`
  ${topBar([['search'], ['filter']])}
  <div class="lt"><h1>Dự án</h1><div class="sub">32 dự án · ${D.month}</div></div>
  <div class="chips"><span class="chip on">Tất cả</span><span class="chip">${icon('alertOctagon', 16)}Chậm tiến độ 6</span><span class="chip">Đang thực hiện</span></div>
  <div class="scroll">${items.map(([k, band, txt, pct]) => { const p = proj(k); const b = { key: band, icon: band === 'late' ? 'alertOctagon' : band === 'soon' ? 'alertTriangle' : 'clock' }; return `<div class="rw" style="padding:14px 16px">${gl(b)}<div class="m"><div class="meta">${p.code} · ${p.group}</div><div class="t clamp2">${p.name}</div><div class="meta" style="display:flex;gap:8px;align-items:center;margin-top:4px"><span class="pbar"><i style="width:${pct}%"></i></span><span class="num">${pct}% · ${p.stage}</span></div></div><div class="tr"><span class="due due-${band}">${icon(b.icon, 16)}${txt}</span></div></div>`; }).join('')}</div>
  ${nav(1)}`);
};

// 9. empty state
const emptyState = () => shell(`
  ${topBar([['search'], ['filter']])}
  <div class="lt"><h1>Việc hôm nay</h1><div class="sub">Thứ Năm, 12/11/2026 · ${D.people.officer.name}</div></div>
  <div class="utabs"><span class="u on">Của tôi <b>0</b></span><span class="u">Cả nhóm</span><span class="u">Đã xong</span></div>
  <div class="scroll"><div class="empty"><div class="glyph ok">${icon('checkCircle', 36)}</div><h2>Hôm nay bạn đã xong việc</h2><p>Không còn việc trễ hạn hay đến hạn trong 3 ngày. Việc tiếp theo: Lập hồ sơ mời thầu gói thiết bị phòng học, còn 8 ngày.</p><span class="btn btn-quiet" style="flex:none;margin-top:8px">Xem việc sắp tới</span></div></div>
  ${nav(0)}`);

// 10. offline + stale, one banner only
const offline = () => officerHome({ banner: `<div class="banner">${icon('wifioff', 18)}<span>Đang xem bản lưu lúc 07:30. Chỉ đọc: chưa thể nhận việc, nộp chứng từ hay phê duyệt.</span><span class="link" style="color:var(--mv2-info-fg)">Thử lại</span></div>`, fab: false });

// 11. loading skeleton
const loading = () => shell(`
  ${topBar([['search'], ['filter']])}
  <div class="lt"><h1>Việc hôm nay</h1><div class="sub">Thứ Năm, 12/11/2026</div></div>
  <div class="utabs"><span class="u on">Của tôi</span><span class="u">Cả nhóm</span><span class="u">Đã xong</span></div>
  <div class="scroll">${[1, 2, 3, 4, 5, 6].map(() => `<div class="rw"><div class="glyph sk" style="background:var(--mv2-sunken)"></div><div class="m"><div class="sk" style="height:16px;width:88%;margin:3px 0 8px"></div><div class="sk" style="height:12px;width:55%"></div></div><div class="tr"><div class="sk" style="height:14px;width:76px"></div></div></div>`).join('')}</div>
  ${nav(0, {})}`);

// 12. dark, 13. 200% text
const dark = () => officerHome({ theme: 'dark' });
const big = () => officerHome({ scale: true, fab: false });

// 14. settings (personal deadline band thresholds, R40)
const settings = () => shell(`
  ${topBar([])}
  <div class="lt"><h1>Cá nhân</h1></div>
  <div class="rw" style="align-items:center"><div class="glyph pri" style="border-radius:20px;font:var(--t-label)">LM</div><div class="m"><div class="t">${D.people.officer.name}</div><div class="meta">${D.people.officer.role} · Cao Bằng</div></div>${icon('chevR', 20)}</div>
  <div class="scroll">
  <div class="grp">Nhắc hạn việc</div>
  <div class="set"><span class="k">Vàng khi còn tối đa</span><span class="step"><b>${icon('chevL', 18)}</b><span class="num">3 ngày</span><b>${icon('chevR', 18)}</b></span></div>
  <div class="set"><span class="k">Đỏ khi còn dưới</span><span class="step"><b>${icon('chevL', 18)}</b><span class="num">1 ngày</span><b>${icon('chevR', 18)}</b></span></div>
  <div class="prev" style="padding-top:8px">
    <div class="pv ok">${icon('clock', 18)}Còn 5 ngày: còn thời gian</div>
    <div class="pv soon">${icon('alertTriangle', 18)}Còn 2 ngày: sắp đến hạn</div>
    <div class="pv late">${icon('alertOctagon', 18)}Dưới 1 ngày: đến hạn</div>
    <div class="meta">Theo cài đặt của bạn, chỉ đổi màu và lúc nhắc trên máy này. Cảnh báo chính thức và KPI theo quy định của đơn vị.</div></div>
  <div class="grp">Thông báo</div>
  <div class="set"><span class="k">Thông báo đẩy</span>${icon('chevR', 20)}</div>
  <div class="set"><span class="k">Giờ yên lặng</span><span class="meta">21:00 đến 06:30</span>${icon('chevR', 20)}</div>
  <div class="grp">Công cụ</div>
  <div class="set"><span class="k">Tìm kiếm hồ sơ</span>${icon('chevR', 20)}</div>
  <div class="set"><span class="k">Hàng đợi gửi</span><span class="meta">0 mục</span>${icon('chevR', 20)}</div>
  <div class="set"><span class="k">Làm việc ngoại tuyến</span>${icon('chevR', 20)}</div>
  </div>${nav(4)}`);

// 15. quick create sheet from the "Báo cáo" button
const quick = () => shell(`
  ${topBar([['search'], ['filter']])}
  <div class="lt"><h1>Việc hôm nay</h1><div class="sub">Thứ Năm, 12/11/2026 · ${D.people.officer.name}</div></div>
  <div class="utabs"><span class="u on">Của tôi <b>6</b></span><span class="u">Cả nhóm</span><span class="u">Đã xong</span></div>
  <div class="scroll">${groupsHtml()}</div>${nav(0)}
  <div class="scrim"></div>
  <div class="sheet"><div class="grab"></div><h2>Báo cáo hiện trường</h2>
    <div class="meta">Dự án gần nhất: DA-CB-017 · Đường tỉnh ĐT.206. Gửi được cả khi không có mạng.</div>
    <div class="actgrid">
      <div class="tile"><div class="glyph pri">${icon('camera', 24)}</div>Chụp ảnh hiện trường</div>
      <div class="tile"><div class="glyph soon">${icon('alertTriangle', 24)}</div>Ghi nhận vướng mắc</div>
      <div class="tile"><div class="glyph pri">${icon('edit', 24)}</div>Viết nhật ký công trường</div>
      <div class="tile"><div class="glyph pri">${icon('list', 24)}</div>Ghi nhận khối lượng</div>
    </div></div>`);

export const screens = [
  ['1', 'Trang chủ lãnh đạo', leaderHome],
  ['2', 'Trang chủ cán bộ: Việc hôm nay', () => officerHome()],
  ['3', 'Chi tiết dự án: tab Tiến độ', projectDetail],
  ['4', 'Hộp phê duyệt', approvals],
  ['5', 'Chi tiết việc', taskDetail],
  ['6', 'Thông báo', notifications],
  ['7', 'Xác nhận phê duyệt (bottom sheet)', approveSheet],
  ['8', 'Danh sách dự án', projectList],
  ['9', 'Trạng thái rỗng', emptyState],
  ['10', 'Ngoại tuyến, chỉ một dải báo', offline],
  ['11', 'Đang tải (skeleton)', loading],
  ['12', 'Chế độ tối', dark],
  ['13', 'Cỡ chữ hệ thống 200%', big],
  ['14', 'Cá nhân, ngưỡng nhắc hạn', settings],
  ['15', 'Tạo nhanh báo cáo hiện trường', quick],
];
export const css = CSS;
