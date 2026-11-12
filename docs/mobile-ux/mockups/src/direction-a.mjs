// Direction A, "Bảng điều hành": a dark teal command header on the home screens, cards with a deadline rail, a primary action on the card.
import { icon } from './icons.mjs';
import { TOKENS_CSS, BASE_CSS } from './tokens.mjs';
import * as D from './data.mjs';

export const meta = { id: 'a', name: 'Hướng A: Bảng điều hành', tagline: 'Thẻ có dải hạn, tiêu đề tối, hành động chính ngay trên thẻ' };

const CSS = `
${TOKENS_CSS}${BASE_CSS}
/* ---- chrome ---- */
.hd{background:var(--mv2-header);color:var(--mv2-on-header)}
.appbar{display:flex;align-items:center;height:56px;padding:0 4px 0 16px;gap:4px}
.appbar.back{padding-left:4px}
.appbar .ttl{flex:1;min-width:0}
.appbar h1{font:var(--t-heading);font-size:17px}
.appbar .sub{font:var(--t-caption);color:var(--mv2-on-header-2)}
.ib{width:48px;height:48px;display:grid;place-items:center;border-radius:24px;position:relative}
.ib .dot{position:absolute;top:9px;right:8px;min-width:18px;height:18px;border-radius:9px;background:var(--mv2-late-mark);color:#fff;font:600 12px/18px 'Be Vietnam Pro',sans-serif;text-align:center;padding:0 4px}
.nav{display:flex;background:var(--mv2-surface);border-top:1px solid var(--mv2-line);height:68px;flex:none}
.nav .t{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;font:600 12px/16px 'Be Vietnam Pro',sans-serif;color:var(--mv2-ink-2)}
.nav .pill{width:60px;height:30px;border-radius:15px;display:grid;place-items:center;position:relative}
.nav .on{color:var(--mv2-primary-strong)}
.nav .on .pill{background:var(--mv2-primary-soft)}
.nav .cnt{position:absolute;top:-4px;right:2px;min-width:18px;height:18px;border-radius:9px;background:var(--mv2-late-mark);color:#fff;font:600 12px/18px 'Be Vietnam Pro',sans-serif;text-align:center;padding:0 4px;border:2px solid var(--mv2-surface);box-sizing:content-box}
/* ---- bands: solid = needs you now, outlined = soon, quiet = fine; icon shape and words always present ---- */
.band{display:inline-flex;align-items:center;gap:4px;height:26px;padding:0 8px;border-radius:var(--r-chip);font:var(--t-label);font-size:13px;white-space:nowrap;flex:none}
.band-late{background:var(--mv2-late-mark);color:#fff}
.band-soon{background:var(--mv2-soon-bg);color:var(--mv2-soon-fg);border:1.5px solid var(--mv2-soon-mark)}
.band-ok{background:var(--mv2-ok-bg);color:var(--mv2-ok-fg)}
.rail{position:relative}
.rail::before{content:"";position:absolute;left:0;top:0;bottom:0;width:5px;border-radius:var(--r-card) 0 0 var(--r-card)}
.rail-late::before{background:var(--mv2-late-mark)}
.rail-soon::before{background:repeating-linear-gradient(180deg,var(--mv2-soon-mark) 0 8px,transparent 8px 11px)}
.rail-ok::before{background:var(--mv2-ok-mark);opacity:.55}
.card{background:var(--mv2-surface);border:1px solid var(--mv2-line);border-radius:var(--r-card);box-shadow:var(--e1)}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;height:48px;padding:0 16px;border-radius:var(--r-ctl);font:var(--t-label);font-size:15px;flex:none}
.btn-primary{background:var(--mv2-primary);color:var(--mv2-on-primary)}
.btn-quiet{background:var(--mv2-surface);color:var(--mv2-primary-strong);border:1.5px solid var(--mv2-outline)}
.btn-off{background:var(--mv2-sunken);color:var(--mv2-ink-3)}
.sect{display:flex;align-items:center;gap:8px;padding:0 16px;margin:20px 0 8px}
.sect h2{font:var(--t-heading);flex:1}
.sect .count{min-width:24px;height:24px;border-radius:12px;background:var(--mv2-ink);color:var(--mv2-surface);font:600 13px/24px 'Be Vietnam Pro',sans-serif;text-align:center;padding:0 7px}
.link{font:var(--t-label);color:var(--mv2-primary-strong)}
.cap{}
.meta{font:var(--t-caption);color:var(--mv2-ink-2)}
.ink3{color:var(--mv2-ink-3)}
.row{display:flex;align-items:center;gap:8px}
.sp{flex:1}
/* ---- leader home ---- */
.hero{padding:4px 16px 52px}
.hero .scope{font:var(--t-caption);color:var(--mv2-on-header-2);display:flex;align-items:center;gap:6px;margin-bottom:12px}
.hero .lab{font:var(--t-label);color:var(--mv2-on-header-2)}
.hero .big{font:var(--t-display);display:flex;align-items:baseline;gap:8px;margin-top:2px}
.hero .big small{font:var(--t-label);color:var(--mv2-on-header-2)}
.bar{height:10px;border-radius:5px;background:var(--mv2-header-2);overflow:hidden;margin-top:12px}
.bar i{display:block;height:100%;background:var(--mv2-accent-on-dark);border-radius:5px}
.hero .foot{display:flex;justify-content:space-between;margin-top:8px;font:var(--t-caption);color:var(--mv2-on-header-2)}
.tiles{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:-36px 16px 0;position:relative}
.tile{padding:12px 14px;display:flex;flex-direction:column;gap:4px}
.tile .n{font:600 28px/34px 'Be Vietnam Pro',sans-serif}
.tile .n small{font:var(--t-label);color:var(--mv2-ink-2)}
.tile .l{font:var(--t-label);color:var(--mv2-ink-2)}
.dcard{margin:0 16px 12px;padding:12px 16px 12px 20px;display:flex;flex-direction:column;gap:8px}
.dcard .k{font:var(--t-caption);color:var(--mv2-ink-2)}
.dcard .t{font:var(--t-heading);font-size:15px;line-height:22px}
.dcard .amt{font:600 20px/28px 'Be Vietnam Pro',sans-serif}
.dcard .amt small{font:var(--t-label);color:var(--mv2-ink-2);margin-left:4px}
.facts{display:flex;align-items:flex-start;gap:6px;font:var(--t-caption);color:var(--mv2-ink-2)}
.facts .ic{color:var(--mv2-ok-mark);margin-top:1px}
.acts{display:flex;gap:8px;margin-top:4px}
.acts .btn{flex:1}
/* ---- officer home ---- */
.filters{display:flex;gap:8px;padding:12px 16px;background:var(--mv2-surface);border-bottom:1px solid var(--mv2-line)}
.fchip{display:inline-flex;align-items:center;gap:6px;height:36px;padding:0 10px;border-radius:var(--r-chip);border:1.5px solid var(--mv2-outline);font:var(--t-label);font-size:13px;white-space:nowrap}
.fchip.on{background:var(--mv2-ink);color:var(--mv2-surface);border-color:var(--mv2-ink)}
.fchip b{font-weight:600}
.grp{padding:16px 16px 8px;font:var(--t-label);color:var(--mv2-ink-2);display:flex;align-items:center;gap:8px}
.tcard{margin:0 16px 10px;padding:12px 16px 12px 20px;display:flex;flex-direction:column;gap:6px}
.tcard .top{display:flex;align-items:flex-start;gap:8px}
.tcard .t{font:var(--t-heading);font-size:15px;line-height:22px;flex:1}
.tcard .p{font:var(--t-caption);color:var(--mv2-ink-2)}
.prog{display:flex;align-items:center;gap:8px;font:var(--t-caption);color:var(--mv2-ink-2)}
.prog .tr{flex:1;height:6px;border-radius:3px;background:var(--mv2-sunken);overflow:hidden}
.prog .tr i{display:block;height:100%;background:var(--mv2-primary)}
/* ---- project detail ---- */
.phead{padding:0 16px 14px}
.phead .code{font:var(--t-caption);color:var(--mv2-on-header-2)}
.phead .nm{font:var(--t-title);font-size:20px;line-height:28px;margin-top:2px}
.phead .chips{display:flex;gap:8px;margin-top:10px}
.hchip{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 10px;border-radius:14px;background:var(--mv2-header-2);color:var(--mv2-on-header);font:var(--t-caption);font-weight:600}
.tabs{display:flex;background:var(--mv2-surface);border-bottom:1px solid var(--mv2-line)}
.tabs .tb{flex:1;height:48px;display:grid;place-items:center;font:var(--t-label);font-size:14px;color:var(--mv2-ink-2);position:relative}
.tabs .on{color:var(--mv2-primary-strong)}
.tabs .on::after{content:"";position:absolute;left:12px;right:12px;bottom:0;height:3px;border-radius:3px 3px 0 0;background:var(--mv2-primary)}
.strip{display:flex;gap:0;padding:16px 0 4px 16px;overflow:hidden;background:var(--mv2-surface)}
.stg{width:80px;flex:none;display:flex;flex-direction:column;align-items:center;gap:6px;position:relative;font:var(--t-caption);color:var(--mv2-ink-2);text-align:center}
.stg .nd{width:32px;height:32px;border-radius:16px;display:grid;place-items:center;font:600 14px/1 'Be Vietnam Pro',sans-serif;background:var(--mv2-surface);border:2px solid var(--mv2-line-strong);color:var(--mv2-ink-2);position:relative;z-index:1}
.stg::before{content:"";position:absolute;top:15px;left:-40px;width:80px;height:3px;background:var(--mv2-line-strong)}
.stg:first-child::before{display:none}
.stg.done .nd{background:var(--mv2-primary);border-color:var(--mv2-primary);color:var(--mv2-on-primary)}
.stg.done::before,.stg.cur::before{background:var(--mv2-primary)}
.stg.cur .nd{background:var(--mv2-header);border-color:var(--mv2-header);color:#fff;box-shadow:0 0 0 4px var(--mv2-primary-soft)}
.stg.cur{color:var(--mv2-ink);font-weight:600}
.stsum{display:flex;align-items:center;gap:8px;padding:12px 16px;background:var(--mv2-surface);border-bottom:1px solid var(--mv2-line)}
.lrow{display:flex;gap:12px;padding:12px 16px;background:var(--mv2-surface);border-bottom:1px solid var(--mv2-line);align-items:flex-start}
.lrow .st{width:24px;height:24px;flex:none;margin-top:1px}
.lrow .st.late{color:var(--mv2-late-mark)}.lrow .st.soon{color:var(--mv2-soon-mark)}.lrow .st.ok{color:var(--mv2-ok-mark)}.lrow .st.done{color:var(--mv2-primary)}
.lrow .t{font:var(--t-body);font-weight:600;line-height:22px}
.lrow .t.dn{font-weight:400;color:var(--mv2-ink-2);text-decoration:line-through;text-decoration-color:var(--mv2-line-strong)}
/* ---- approvals ---- */
.seg{display:flex;margin:12px 16px 0;padding:4px;background:var(--mv2-sunken);border-radius:var(--r-ctl)}
.seg .s{flex:1;height:40px;display:flex;align-items:center;justify-content:center;gap:6px;font:var(--t-label);font-size:14px;color:var(--mv2-ink-2);border-radius:9px}
.seg .on{background:var(--mv2-surface);color:var(--mv2-ink);box-shadow:var(--e1)}
.acard{margin:12px 16px 0;padding:14px 16px 14px 20px;display:flex;flex-direction:column;gap:8px}
/* ---- task detail ---- */
.banner{display:flex;align-items:center;gap:10px;padding:12px 16px;font:var(--t-label);font-size:15px}
.banner.late{background:var(--mv2-late-bg);color:var(--mv2-late-fg);border-bottom:2px solid var(--mv2-late-mark)}
.kv{display:grid;grid-template-columns:1fr 1fr;gap:12px 16px;padding:16px}
.kv .k{font:var(--t-caption);color:var(--mv2-ink-2)}
.kv .v{font:var(--t-body);font-weight:600;line-height:20px}
.doc{display:flex;gap:12px;align-items:center;padding:12px 16px;border-top:1px solid var(--mv2-line)}
.doc .ok{color:var(--mv2-ok-mark)}.doc .no{color:var(--mv2-late-mark)}
.doc .nm{font:var(--t-body);line-height:20px}
.actbar{flex:none;background:var(--mv2-surface);border-top:1px solid var(--mv2-line);box-shadow:var(--e2);padding:12px 16px 14px;display:flex;flex-direction:column;gap:8px}
.actbar .why{display:flex;align-items:center;gap:6px;font:var(--t-caption);color:var(--mv2-late-fg)}
/* ---- notifications ---- */
.nrow{display:flex;gap:12px;padding:12px 16px;background:var(--mv2-surface);border-bottom:1px solid var(--mv2-line)}
.nic{width:40px;height:40px;border-radius:20px;display:grid;place-items:center;flex:none}
.nic.late{background:var(--mv2-late-bg);color:var(--mv2-late-fg)}.nic.soon{background:var(--mv2-soon-bg);color:var(--mv2-soon-fg)}.nic.ok{background:var(--mv2-ok-bg);color:var(--mv2-ok-fg)}.nic.info{background:var(--mv2-info-bg);color:var(--mv2-info-fg)}
.nrow .t{font:var(--t-body);line-height:22px}
.nrow.un .t{font-weight:600}
.udot{width:10px;height:10px;border-radius:5px;background:var(--mv2-primary);flex:none;margin-top:6px}
.tag{font:var(--t-caption);font-weight:600;color:var(--mv2-ink-2)}
`;

const navItems = [['home', 'Trang chủ'], ['building', 'Dự án'], ['clipcheck', 'Phê duyệt'], ['bell', 'Thông báo'], ['user', 'Cá nhân']];
const nav = (active, counts = {}) => `<nav class="nav" aria-label="Điều hướng chính">${navItems.map(([ic, label], i) => `<div class="t ${i === active ? 'on' : ''}"><div class="pill">${icon(ic, 24)}${counts[i] ? `<span class="cnt">${counts[i]}</span>` : ''}</div>${label}</div>`).join('')}</nav>`;
const chip = (b) => `<span class="band band-${b.key}">${icon(b.icon, 16)}${b.text}</span>`;
const shell = (inner, { dark = true } = {}) => `<div class="screen"><div class="inset-top ${dark ? 'hd' : ''}"></div>${inner}<div class="inset-bottom" style="background:var(--mv2-surface)"></div></div>`;
const proj = (k) => D.projects[k];

// 1. leader home
const leaderHome = () => {
  const pct = Math.round((D.kpi.paid / D.kpi.plan) * 1000) / 10;
  const first = D.decisions[0];
  const b0 = D.band(first.days);
  const rest = D.decisions.slice(1, 3);
  return shell(`
  <div class="hd"><div class="appbar"><div class="ttl"><h1>Tổng quan</h1></div><div class="ib">${icon('search', 24)}</div></div></div>
  <div class="scroll">
  <div class="hd hero">
    <div class="scope">${icon('mapPin', 14)}${D.scope} · ${D.month}</div>
    <div class="lab">Giải ngân lũy kế 2026 theo Kho bạc Nhà nước</div>
    <div class="big num">1.058,3<small>tỷ đồng</small></div>
    <div class="bar" role="img" aria-label="Đã giải ngân ${pct}% kế hoạch vốn"><i style="width:${pct}%"></i></div>
    <div class="foot"><span>${String(pct).replace('.', ',')}% kế hoạch vốn năm</span><span>Kế hoạch 1.820 tỷ đồng</span></div>
  </div>
  <div class="tiles">
    <div class="card tile"><span class="l">Dự án chậm giải ngân</span><span class="n num">${D.kpi.late}<small> / ${D.kpi.of}</small></span><span class="band band-soon" style="align-self:flex-start">${icon('alertTriangle', 16)}Cần theo dõi</span></div>
    <div class="card tile"><span class="l">Việc quá hạn</span><span class="n num">${D.kpi.overdue}</span><span class="band band-late" style="align-self:flex-start">${icon('alertOctagon', 16)}Quá hạn</span></div>
  </div>
  <div class="sect"><h2>Cần bạn quyết định</h2><span class="count">${D.decisions.length}</span><span class="link">Xem tất cả</span></div>
  <div class="card dcard rail rail-${b0.key}">
    <div class="row"><span class="k">${first.kind}</span><span class="sp"></span>${chip(b0)}</div>
    <div class="t clamp2">${first.title}</div>
    <div class="amt num">12<small>tỷ đồng</small></div>
    <div class="meta">${first.from} · gửi ${first.sent}</div>
    <div class="acts"><span class="btn btn-quiet">${icon('undo', 18)}Trả lại</span><span class="btn btn-primary">${icon('check', 18)}Phê duyệt</span></div>
  </div>
  ${rest.map((d) => { const b = D.band(d.days); return `<div class="card dcard rail rail-${b.key}"><div class="row"><span class="k">${d.kind}</span><span class="sp"></span>${chip(b)}</div><div class="t clamp2">${d.title}</div><div class="meta">${d.from}</div></div>`; }).join('')}
  </div>
  ${nav(0, { 2: 4, 3: 3 })}`);
};

// 2. officer home
const officerHome = () => {
  const groups = [
    ['Trễ hạn và đến hạn hôm nay', D.tasks.filter((t) => t.days <= 0)],
    ['Sắp đến hạn (3 ngày)', D.tasks.filter((t) => t.days > 0 && t.days <= 3)],
    ['Còn thời gian', D.tasks.filter((t) => t.days > 3)],
  ];
  const card = (t) => {
    const b = D.band(t.days);
    const p = proj(t.project);
    const miss = t.docs[1] - t.docs[0];
    const action = miss > 0 && t.docs[0] > 0 ? `<span class="btn btn-primary" style="height:40px">${icon('upload', 18)}Bổ sung chứng từ</span>` : (t.docs[0] === t.docs[1] ? `<span class="btn btn-primary" style="height:40px">${icon('check', 18)}Hoàn thành</span>` : `<span class="btn btn-quiet" style="height:40px">Mở việc</span>`);
    return `<div class="card tcard rail rail-${b.key}"><div class="top"><div class="t clamp2">${t.title}</div>${chip(b)}</div>
      <div class="p">${p.code} · ${p.stage} · hạn ${t.due}</div>
      <div class="prog"><span>${t.docs[0]}/${t.docs[1]} chứng từ</span><span class="tr"><i style="width:${(t.docs[0] / t.docs[1]) * 100}%"></i></span>${action}</div></div>`;
  };
  return shell(`
  <div class="hd"><div class="appbar"><div class="ttl"><h1>Việc hôm nay</h1><div class="sub">Thứ Năm, 12/11/2026 · ${D.people.officer.name}</div></div><div class="ib">${icon('search', 24)}</div><div class="ib">${icon('filter', 24)}</div></div></div>
  <div class="filters"><span class="fchip on">${icon('alertOctagon', 16)}Trễ hạn <b>2</b></span><span class="fchip">${icon('alertTriangle', 16)}Sắp đến hạn <b>2</b></span><span class="fchip">${icon('clock', 16)}Còn hạn <b>2</b></span></div>
  <div class="scroll">${groups.map(([name, ts]) => `<div class="grp">${name}<span class="meta">${ts.length}</span></div>${ts.map(card).join('')}`).join('')}</div>
  ${nav(0, { 2: 4, 3: 3 })}`);
};

// 3. project detail, tab "Tiến độ"
const projectDetail = () => {
  const p = proj('P017');
  const icoFor = (t) => (t.done ? ['checkCircle', 'done'] : ({ late: ['alertOctagon', 'late'], soon: ['alertTriangle', 'soon'], ok: ['clock', 'ok'] })[D.band(t.days).key]);
  return shell(`
  <div class="hd"><div class="appbar back"><div class="ib">${icon('chevL', 24)}</div><div class="ttl"><h1>${p.code}</h1></div><div class="ib">${icon('more', 24)}</div></div>
  <div class="phead"><div class="nm clamp2">${p.name}</div><div class="chips"><span class="hchip">${p.group}</span><span class="hchip">${p.stage}</span><span class="hchip">Hoàn thành ${p.progress}%</span></div></div></div>
  <div class="tabs"><div class="tb">Tổng quan</div><div class="tb on">Tiến độ</div><div class="tb">Vốn</div><div class="tb">Hồ sơ</div></div>
  <div class="scroll">
  <div class="strip" role="list" aria-label="Các giai đoạn của dự án">${D.stages.map((s, i) => `<div class="stg ${s.current ? 'cur' : (s.done === s.of ? 'done' : '')}" role="listitem"><div class="nd">${s.done === s.of ? icon('check', 18) : i + 1}</div>${s.name}</div>`).join('')}</div>
  <div class="stsum"><span class="meta">Giai đoạn 4/6 · <b style="color:var(--mv2-ink)">Thực hiện</b> · 7/12 việc xong</span><span class="sp"></span><span class="link" style="white-space:nowrap">Của tôi</span></div>
  ${D.stageTasks.map((t) => { const [ic, cls] = icoFor(t); return `<div class="lrow"><span class="st ${cls}">${icon(ic, 24)}</span><div style="flex:1;min-width:0"><div class="t ${t.done ? 'dn' : ''}">${t.title}</div><div class="meta">${t.who}${t.done ? ` · xong ${t.done}` : ` · hạn ${t.due}`}</div></div>${t.done ? '' : chip(D.band(t.days))}</div>`; }).join('')}
  </div>
  ${nav(1, { 2: 4, 3: 3 })}`);
};

// 4. approval inbox
const approvals = () => `${shell(`
  <div class="hd"><div class="appbar"><div class="ttl"><h1>Phê duyệt</h1><div class="sub">4 hồ sơ chờ bạn quyết định</div></div><div class="ib">${icon('search', 24)}</div><div class="ib">${icon('filter', 24)}</div></div></div>
  <div class="seg"><div class="s on">Chờ tôi <b>4</b></div><div class="s">Đã xử lý</div><div class="s">Tôi gửi</div></div>
  <div class="scroll">
  ${D.decisions.slice(0, 3).map((d, i) => { const b = D.band(d.days); return `<div class="card acard rail rail-${b.key}">
    <div class="row"><span class="k meta">${d.kind}</span><span class="sp"></span>${chip(b)}</div>
    <div class="t" style="font:var(--t-heading);font-size:15px;line-height:22px">${d.title}</div>
    ${d.amount ? `<div class="amt num" style="font:600 20px/28px 'Be Vietnam Pro',sans-serif">${D.vnd(d.amount).value}<small style="font:var(--t-label);color:var(--mv2-ink-2);margin-left:4px">${D.vnd(d.amount).unit}</small></div>` : ''}
    <div class="meta">${d.from} · gửi ${d.sent}</div>
    <div class="facts">${icon('checkCircle', 16)}<span>${d.checks}</span></div>
    <div class="meta">${icon('paperclip', 14)} ${d.attach} tệp đính kèm</div>
    ${i < 2 ? `<div class="acts"><span class="btn btn-quiet">${icon('undo', 18)}Trả lại</span><span class="btn btn-primary">${icon('check', 18)}Phê duyệt</span></div>` : ''}
  </div>`; }).join('')}
  </div>
  ${nav(2, { 2: 4, 3: 3 })}`)}`;

// 5. task detail
const taskDetail = () => {
  const t = D.taskDetail; const p = proj(t.project); const b = D.band(t.days);
  return shell(`
  <div class="hd"><div class="appbar back"><div class="ib">${icon('chevL', 24)}</div><div class="ttl"><h1>Việc ${t.id}</h1></div><div class="ib">${icon('more', 24)}</div></div></div>
  <div class="scroll" style="background:var(--mv2-surface)">
  <div class="banner late">${icon('alertOctagon', 24)}<span>Trễ 2 ngày · hạn ${t.due}/2026</span></div>
  <div style="padding:16px 16px 0"><div style="font:var(--t-title);font-size:20px;line-height:28px">${t.title}</div></div>
  <div class="kv">
    <div><div class="k">Dự án</div><div class="v">${p.code}</div></div><div><div class="k">Giai đoạn</div><div class="v">${t.stage}</div></div>
    <div><div class="k">Người làm</div><div class="v">${t.owner}</div></div><div><div class="k">Người duyệt hoàn thành</div><div class="v">Hoàng Văn Hải</div></div>
    <div><div class="k">Bắt đầu</div><div class="v">${t.start}/2026</div></div><div><div class="k">Hạn cơ sở</div><div class="v">${t.base}/2026</div></div>
  </div>
  <div style="height:8px;background:var(--mv2-bg)"></div>
  <div class="sect" style="margin-top:16px"><h2>Chứng từ bắt buộc</h2><span class="meta">3/4 đã có</span></div>
  ${t.docs.map((d) => `<div class="doc"><span class="${d.ok ? 'ok' : 'no'}">${icon(d.ok ? 'checkCircle' : 'alertOctagon', 24)}</span><div style="flex:1;min-width:0"><div class="nm">${d.name}</div><div class="meta">${d.meta}</div></div>${d.ok ? icon('chevR', 20, 'ink3') : `<span class="btn btn-primary" style="height:40px">${icon('upload', 18)}Tải lên</span>`}</div>`).join('')}
  <div class="doc"><span style="color:var(--mv2-primary)">${icon('file', 24)}</span><div style="flex:1"><div class="nm">${t.form}</div><div class="meta">Tạo từ mẫu, điền sẵn thông tin dự án</div></div><span class="link">Tạo</span></div>
  </div>
  <div class="actbar"><div class="why">${icon('info', 16)}Còn thiếu 1 chứng từ bắt buộc nên chưa hoàn thành được</div>
    <div class="acts"><span class="btn btn-quiet">${icon('calendar', 18)}Xin dời hạn</span><span class="btn btn-off">${icon('check', 18)}Hoàn thành</span></div></div>`, { dark: true });
};

// 6. notifications
const notifications = () => shell(`
  <div class="hd"><div class="appbar"><div class="ttl"><h1>Thông báo</h1></div><div class="ib" style="width:auto;padding:0 8px"><span class="link" style="color:var(--mv2-on-header);font-size:13px;white-space:nowrap">Đọc hết</span></div><div class="ib">${icon('filter', 24)}</div></div></div>
  <div class="filters"><span class="fchip on">Tất cả</span><span class="fchip">Hạn việc <b>2</b></span><span class="fchip">Phê duyệt <b>2</b></span><span class="fchip">Hệ thống</span></div>
  <div class="scroll">${['Hôm nay', 'Hôm qua'].map((g) => `<div class="grp">${g}</div>${D.notices.filter((n) => n.group === g).map((n) => `<div class="nrow ${n.unread ? 'un' : ''}"><div class="nic ${n.kind}">${icon(n.icon, 22)}</div><div style="flex:1;min-width:0"><div class="t">${n.title}</div><div class="meta clamp2" style="margin-top:2px">${n.body}</div><div class="tag" style="margin-top:4px">${n.tag} · ${n.time}</div></div>${n.unread ? '<span class="udot" role="img" aria-label="Chưa đọc"></span>' : ''}</div>`).join('')}`).join('')}</div>
  ${nav(3, { 2: 4, 3: 3 })}`);

export const screens = [
  ['1', 'Trang chủ lãnh đạo', leaderHome],
  ['2', 'Trang chủ cán bộ: Việc hôm nay', officerHome],
  ['3', 'Chi tiết dự án: tab Tiến độ', projectDetail],
  ['4', 'Hộp phê duyệt', approvals],
  ['5', 'Chi tiết việc', taskDetail],
  ['6', 'Thông báo', notifications],
];
export const css = CSS;
