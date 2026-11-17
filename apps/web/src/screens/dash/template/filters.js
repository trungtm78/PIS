// The filters of the dashboard: what the chips at the top of a page can be set to, and the tables that are left for a choice. Hand-written (not part of the owner's
// template): the engine and the charts of the template are given a cut copy of the tables and draw it as they draw the whole.
//
// Two groups, one for each kind of page. The pages of public investment are cut by period, funding source, sector and investor unit; the pages of the 360° steering
// work by who gave the root task, its theme, the unit that carries it out and the month it is due.

export const FILTERS = {
  inv: ['year', 'period', 'source', 'sector', 'unit'],
  gov: ['origin', 'theme', 'actor', 'due'],
};

/** The label of a chip of the template, by kind of page, and the filter it sets. A chip with another label stays text. */
export const CHIP_FILTER = {
  inv: { 'Năm kế hoạch': 'year', 'Kỳ số liệu vốn': 'period', 'Nguồn vốn': 'source', 'Lĩnh vực': 'sector', 'Đơn vị': 'unit' },
  gov: { 'Nguồn nhiệm vụ': 'origin', 'Nguồn giao': 'origin', 'Chuyên đề': 'theme', 'Nhóm chuyên đề': 'theme', 'Đơn vị thực hiện': 'actor', 'Hạn nhiệm vụ gốc': 'due' },
};

/** What a chip says when its filter is not set. The year and the period have no "all": they say the year of the tables and the closing month. */
const ALL = { source: 'Tất cả', sector: 'Tất cả', unit: 'Toàn tỉnh', origin: 'Tất cả nguồn giao', theme: 'Tất cả', actor: 'Toàn tỉnh', due: 'Tất cả kỳ' };

export const kindOf = (key) => (FILTERS.inv.includes(key) ? 'inv' : 'gov');
export const emptyFilters = () => ({ year: null, period: null, source: null, sector: null, unit: null, origin: null, theme: null, actor: null, due: null });
export const isSet = (state, kind) => FILTERS[kind].some((key) => state[key] !== null);

const clock = (db) => db.moc_thoi_gian[0];
const monthOf = (day) => day.slice(0, 7);
const monthName = (month) => `Tháng ${Number(month.slice(5, 7))}/${month.slice(0, 4)}`;
const periodName = (month) => `Lũy kế đến tháng ${month}`;

/** The month the capital figures are read to: the one chosen, or the closing month of the tables. */
export function periodOf(db, state) {
  const last = clock(db).thang_chot;
  return state.period !== null && state.period >= 1 && state.period <= last ? state.period : last;
}

/** The projects a choice leaves: for a source, the ones that hold a plan on it. */
function projectsOf(db, state) {
  return db.du_an.filter((project) => (state.source === null || project[`kh_${state.source}`] > 0) && (state.sector === null || project.linh_vuc === state.sector) && (state.unit === null || project.don_vi === state.unit));
}
/**
 * The root tasks a choice leaves. A unit keeps the root tasks it takes part in (the ones it holds an assignment of): the filter selects root tasks, it does not cut
 * their assignments.
 */
function rootsOf(db, state) {
  const carried = state.actor === null ? null : new Set(db.luot_giao.filter((assignment) => assignment.don_vi === state.actor).map((assignment) => assignment.nhiem_vu_goc));
  return db.nv_goc.filter((root) => (state.origin === null || root.nguon === state.origin) && (state.theme === null || root.chuyen_de === state.theme) && (state.due === null || monthOf(root.han_bao_cao) === state.due) && (carried === null || carried.has(root.ma)));
}

/**
 * The tables for a choice. Nothing set gives the tables themselves.
 *
 * Investment: the projects that are left, their disbursement, the tasks and the papers of those projects (and, for a unit, of that unit), and the units those rows
 * name. A source gives the figures of that source alone: a project keeps what it holds on the source and nothing of the others, and so does its disbursement. The
 * table of sources keeps its four rows (the engine reads them by their place); the other three hold nothing. What a source says is not allocated to a project yet
 * belongs to no sector and no unit, so it is counted only while the projects are not cut by one.
 *
 * 360°: the root tasks that are left with every assignment of theirs, whichever unit holds it: the engine judges a root task by all of its assignments (it waits for
 * its report once every one is accepted), so a part of them would change what it says of the root task.
 */
export function applyFilters(db, state) {
  let out = db;
  if (state.source !== null || state.sector !== null || state.unit !== null) {
    const codes = db.nguon_von.map((source) => source.ma);
    const other = state.source === null ? [] : codes.filter((code) => code !== state.source);
    const projects = projectsOf(db, state).map((project) => (other.length === 0 ? project : { ...project, ...Object.fromEntries(other.map((code) => [`kh_${code}`, 0])) }));
    const kept = new Set(projects.map((project) => project.ma));
    const follows = (row) => (row.du_an === null || row.du_an === undefined || kept.has(row.du_an)) && (state.unit === null || row.don_vi === state.unit);
    const tasks = db.nhiem_vu.filter(follows);
    const papers = db.ho_so_trinh.filter(follows);
    const named = new Set([...projects, ...tasks, ...papers].map((row) => row.don_vi));
    const whole = state.sector === null && state.unit === null;
    out = {
      ...out, du_an: projects, giai_ngan: db.giai_ngan.filter((row) => kept.has(row.du_an) && (state.source === null || row.nguon === state.source)), nhiem_vu: tasks, ho_so_trinh: papers,
      don_vi: db.don_vi.filter((unit) => named.has(unit.ma)),
      nguon_von: db.nguon_von.map((source) => (state.source !== null && source.ma !== state.source ? { ...source, thu_tuong_giao: 0, ke_hoach: 0, chua_phan_bo: 0 } : { ...source, chua_phan_bo: whole ? source.chua_phan_bo : 0 })),
    };
  }
  if (state.origin !== null || state.theme !== null || state.actor !== null || state.due !== null) {
    const roots = rootsOf(db, state);
    const kept = new Set(roots.map((root) => root.ma));
    out = { ...out, nv_goc: roots, luot_giao: db.luot_giao.filter((assignment) => kept.has(assignment.nhiem_vu_goc)) };
  }
  return out;
}

const counted = (rows, valueOf, labelOf) => {
  const found = new Map();
  for (const row of rows) {
    const value = valueOf(row);
    const option = found.get(value) ?? { value, label: labelOf(row), count: 0 };
    option.count += 1;
    found.set(value, option);
  }
  return [...found.values()];
};
const byLabel = (a, b) => a.label.localeCompare(b.label, 'vi');

/**
 * What a filter can be set to, with how many rows each choice leaves (projects on the investment pages, root tasks on the 360° pages: for a unit, the root tasks it
 * takes part in), counted under the other filters of its kind as they are set. A choice that would leave nothing is not listed.
 */
export function optionsOf(db, state, key) {
  const others = { ...state, [key]: null };
  if (key === 'year') return [{ value: clock(db).nam, label: String(clock(db).nam), count: db.du_an.length }];
  if (key === 'period') return Array.from({ length: clock(db).thang_chot }, (_, index) => ({ value: index + 1, label: periodName(index + 1), count: null })).reverse();
  if (kindOf(key) === 'inv') {
    const projects = projectsOf(db, others);
    if (key === 'source') return db.nguon_von.map((source) => ({ value: source.ma, label: source.ten, count: projects.filter((project) => project[`kh_${source.ma}`] > 0).length })).filter((option) => option.count > 0);
    if (key === 'sector') return counted(projects, (project) => project.linh_vuc, (project) => project.linh_vuc).sort(byLabel);
    const units = Object.fromEntries(db.don_vi.map((unit) => [unit.ma, unit.ten_ngan]));
    return counted(projects, (project) => project.don_vi, (project) => units[project.don_vi] ?? project.don_vi).sort((a, b) => b.count - a.count || byLabel(a, b));
  }
  const roots = rootsOf(db, others);
  if (key === 'origin') return counted(roots, (root) => root.nguon, (root) => root.nguon_ten);
  if (key === 'theme') return counted(roots, (root) => root.chuyen_de, (root) => root.chuyen_de).sort(byLabel);
  if (key === 'due') return counted(roots, (root) => monthOf(root.han_bao_cao), (root) => monthName(monthOf(root.han_bao_cao))).sort((a, b) => (a.value < b.value ? -1 : 1));
  const kept = new Set(roots.map((root) => root.ma));
  const pairs = new Map(db.luot_giao.filter((assignment) => kept.has(assignment.nhiem_vu_goc)).map((assignment) => [`${assignment.don_vi}|${assignment.nhiem_vu_goc}`, assignment]));
  return counted([...pairs.values()], (assignment) => assignment.don_vi, (assignment) => assignment.don_vi).sort(byLabel);
}

/** What the filter is called when it is not set, or null for a filter that is always set (the year, the period). */
export const allLabel = (key) => ALL[key] ?? null;

/** What a chip says for the choice. */
export function chipText(db, state, key) {
  if (key === 'year') return String(clock(db).nam);
  if (key === 'period') return periodName(periodOf(db, state));
  if (state[key] === null) return ALL[key];
  if (key === 'source') return db.nguon_von.find((source) => source.ma === state.source)?.ten ?? String(state.source);
  if (key === 'unit') return db.don_vi.find((unit) => unit.ma === state.unit)?.ten_ngan ?? String(state.unit);
  if (key === 'origin') return db.nv_goc.find((root) => root.nguon === state.origin)?.nguon_ten ?? String(state.origin);
  if (key === 'due') return monthName(state.due);
  return String(state[key]);
}

/**
 * The engine as the charts are given it for a choice: the capital figures read to the chosen month, and the decomposition of the shortfall without the sources that
 * no project of the choice holds (the charts open its first branch, which must have one).
 */
export function engineFor(E, db, state) {
  const period = periodOf(db, state);
  return {
    ...E,
    invest: (tables) => {
      const figures = E.invest(tables, period);
      return { ...figures, decomp: figures.decomp.filter((source) => source.units.length > 0) };
    },
  };
}

/** The filter state with one filter set (null clears it). The closing month is the period when none is chosen, so choosing it is choosing none. */
export function withFilter(db, state, key, value) {
  if (key === 'year') return state;
  return { ...state, [key]: key === 'period' && value === clock(db).thang_chot ? null : value };
}

/** The filter state with every filter of a kind of page cleared. */
export function cleared(state, kind) {
  return { ...state, ...Object.fromEntries(FILTERS[kind].map((key) => [key, null])) };
}

/** The choice a chip is on: the value of its filter, or for the period the month it reads to. */
export const chosen = (db, state, key) => (key === 'year' ? clock(db).nam : key === 'period' ? periodOf(db, state) : state[key]);

/** The filters of one kind of page alone: a page is cut by the filters of its own kind, and never by the ones that are set on the pages of the other kind. */
export const scoped = (state, kind) => cleared(state, kind === 'inv' ? 'gov' : 'inv');

const finite = (value) => typeof value === 'number' && Number.isFinite(value);
/**
 * Whether the engine can compute the pages of a kind for a choice: it runs once on the tables the choice leaves, and the figures every page divides by or reads the
 * first row of must be there (a plan, a rate, a branch of the decomposition; a root task and an assignment). Nothing is drawn.
 */
export function computable(E, db, state, kind) {
  try {
    const own = scoped(state, kind);
    const tables = applyFilters(db, own);
    if (kind === 'inv') {
      const figures = engineFor(E, db, own).invest(tables);
      return figures.ps.length > 0 && finite(figures.plan) && figures.plan > 0 && finite(figures.rate) && finite(figures.t) && figures.decomp.length > 0;
    }
    const figures = E.gov(tables);
    return figures.roots.length > 0 && figures.acts.length > 0;
  } catch {
    return false;
  }
}
