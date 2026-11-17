import { fireEvent } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { DashboardDb } from '../db';
import { assemble, referenceProblems } from '../sources/assemble';
import { loadTemplateDb } from '../sources/template-db';
import { E } from './engine.js';
import { CHIP_FILTER, FILTERS, allLabel, applyFilters, chipText, chosen, cleared, computable, emptyFilters, engineFor, isSet, kindOf, optionsOf, periodOf, scoped, withFilter } from './filters.js';
import type { FilterKey } from './filters.js';
import { mountDashboard } from './index.js';
import type { MountedDashboard } from './index.js';

// jsdom lays nothing out: the charts of the template size themselves from the box they are drawn in, so every element is given one.
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 600 });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 300 });
});

const copyOf = (db: DashboardDb): DashboardDb => JSON.parse(JSON.stringify(db)) as DashboardDb;
const templateDb = async (): Promise<DashboardDb> => assemble(await loadTemplateDb()).db;
const set = (key: FilterKey, value: string | number) => ({ ...emptyFilters(), [key]: value });

let host: HTMLElement;
let board: MountedDashboard | undefined;
function mountOn(db: DashboardDb, page = 0): MountedDashboard {
  host = document.createElement('div');
  host.tabIndex = 0;
  document.body.append(host);
  board = mountDashboard(host, db, { page });
  return board;
}
afterEach(() => {
  board?.dispose();
  board = undefined;
  host?.remove();
});
const chip = (key: FilterKey): HTMLElement => host.querySelector<HTMLElement>(`[data-filter="${key}"]`) as HTMLElement;
const chipSays = (key: FilterKey): string | null => chip(key).querySelector('b')?.textContent ?? null;
const menu = (): HTMLElement | null => host.querySelector<HTMLElement>('.fmenu');
const rows = (): HTMLElement[] => Array.from(host.querySelectorAll<HTMLElement>('.fopt'));
const labels = (): string[] => rows().map((row) => row.firstElementChild?.textContent ?? '');
const pickRow = (label: string): void => { fireEvent.click(rows().find((row) => row.firstElementChild?.textContent === label) as HTMLElement); };
const message = (): string | null => host.querySelector('.fmsg')?.textContent ?? null;
const projectsDrawn = (): number => Number(/(\d+) dự án có kế hoạch vốn/.exec(host.textContent ?? '')?.[1]);
const BROKEN = /NaN|undefined|Infinity/;

describe('the tables a choice leaves', () => {
  it('are the tables themselves when nothing is chosen, and the closing month is the period', async () => {
    const db = await templateDb();
    expect(applyFilters(db, emptyFilters())).toBe(db);
    expect(periodOf(db, emptyFilters())).toBe(10);
    expect(periodOf(db, set('period', 4))).toBe(4);
    expect(periodOf(db, set('period', 11))).toBe(10);
    // Choosing the closing month is choosing no period; the year is the one year of the tables and is never set.
    expect(withFilter(db, emptyFilters(), 'period', 10).period).toBeNull();
    expect(withFilter(db, emptyFilters(), 'period', 6).period).toBe(6);
    expect(withFilter(db, emptyFilters(), 'year', 2026)).toEqual(emptyFilters());
    expect(isSet(emptyFilters(), 'inv')).toBe(false);
    expect(isSet(set('unit', 'CM-STC'), 'inv')).toBe(true);
    expect(isSet(set('unit', 'CM-STC'), 'gov')).toBe(false);
    expect(cleared({ ...set('unit', 'CM-STC'), theme: 'Chuyển đổi số' }, 'inv')).toEqual(set('theme', 'Chuyển đổi số'));
    expect(kindOf('sector')).toBe('inv');
    expect(kindOf('due')).toBe('gov');
  });

  it('keep, for an investor unit, its projects with their disbursement, its tasks and papers, and the units those rows name', async () => {
    const db = await templateDb();
    const cut = applyFilters(db, set('unit', 'CM-BQLDAXD'));
    expect(cut.du_an).toHaveLength(10);
    expect(new Set(cut.du_an.map((project) => project.don_vi))).toEqual(new Set(['CM-BQLDAXD']));
    const kept = new Set(cut.du_an.map((project) => project.ma));
    expect(cut.giai_ngan.length).toBeGreaterThan(0);
    expect(cut.giai_ngan.every((row) => kept.has(row.du_an))).toBe(true);
    expect(cut.nhiem_vu.length).toBeGreaterThan(0);
    expect(cut.nhiem_vu.every((task) => task.don_vi === 'CM-BQLDAXD' && (task.du_an === null || kept.has(task.du_an)))).toBe(true);
    expect(cut.ho_so_trinh.every((paper) => paper.don_vi === 'CM-BQLDAXD')).toBe(true);
    expect(cut.don_vi.map((unit) => unit.ma)).toEqual(['CM-BQLDAXD']);
    // The sources are not cut (the engine reads the four of them by their place); what is allocated to no project belongs to no unit and is not counted.
    expect(cut.nguon_von.map((source) => source.ma)).toEqual(db.nguon_von.map((source) => source.ma));
    expect(cut.nguon_von.every((source) => source.chua_phan_bo === 0)).toBe(true);
    expect(cut.nv_goc).toBe(db.nv_goc);
    expect(referenceProblems(cut)).toEqual([]);
    // The tables that were given are not changed.
    expect(db.du_an).toHaveLength(45);
    expect(db.nguon_von[1]?.chua_phan_bo).toBe(108_000);
  });

  it('give, for a source, the figures of that source alone: its projects with what they hold on it, its disbursement, and what of it is not allocated yet', async () => {
    const db = await templateDb();
    const central = applyFilters(db, set('source', 'NSTW'));
    expect(central.du_an).toHaveLength(21);
    expect(central.du_an.every((project) => project.kh_NSTW > 0 && project.kh_NSDP === 0 && project.kh_SUPPORT === 0 && project.kh_ODAV === 0)).toBe(true);
    expect(new Set(central.giai_ngan.map((row) => row.nguon))).toEqual(new Set(['NSTW']));
    // The four rows stay (the engine reads them by their place); the other three hold nothing.
    expect(central.nguon_von.map((source) => [source.ma, source.ke_hoach, source.thu_tuong_giao, source.chua_phan_bo])).toEqual([['NSTW', 1_500_000, 1_500_000, 0], ['NSDP', 0, 0, 0], ['SUPPORT', 0, 0, 0], ['ODAV', 0, 0, 0]]);
    const figures = (state: ReturnType<typeof emptyFilters>) => engineFor(E, db, state).invest(applyFilters(db, state)) as unknown as { plan: number; disb: number; pm: number; bySrc: { ma: string; plan: number; disb: number }[] };
    const whole = figures(emptyFilters());
    for (const source of ['NSTW', 'NSDP', 'SUPPORT', 'ODAV']) {
      const one = figures(set('source', source));
      const row = whole.bySrc.find((entry) => entry.ma === source);
      // The plan of the source with what of it is not allocated, and its disbursement: what the whole board says of that source.
      expect([source, one.plan, one.disb]).toEqual([source, row?.plan, row?.disb]);
      expect(one.bySrc.filter((entry) => entry.ma !== source).map((entry) => entry.plan)).toEqual([0, 0, 0]);
    }
    expect(figures(set('source', 'NSTW')).plan).toBe(1_500_000);
    expect(figures(set('source', 'NSDP')).plan).toBe(1_500_000);
    // What is not allocated belongs to no sector: beside a sector the source counts its projects alone.
    const local = applyFilters(db, { ...set('source', 'NSDP'), sector: 'Giao thông' });
    expect(local.nguon_von.map((source) => source.chua_phan_bo)).toEqual([0, 0, 0, 0]);
    expect(applyFilters(db, set('source', 'NSDP')).nguon_von[1]?.chua_phan_bo).toBe(108_000);
    // The tables that were given are not changed.
    expect(db.du_an.filter((project) => project.kh_NSTW > 0 && project.kh_NSDP > 0).length).toBeGreaterThan(0);
  });

  it('keep, for a sector, its projects; the tasks follow the projects and the directives of no project stay', async () => {
    const db = await templateDb();
    const health = applyFilters(db, set('sector', 'Y tế'));
    expect(health.du_an).toHaveLength(5);
    const kept = new Set(health.du_an.map((project) => project.ma));
    expect(health.nhiem_vu.every((task) => task.du_an === null || kept.has(task.du_an))).toBe(true);
    expect(health.nhiem_vu.some((task) => task.du_an === null)).toBe(true);
    expect(referenceProblems(health)).toEqual([]);
    // Two filters together keep what both keep.
    expect(applyFilters(db, { ...set('sector', 'Giao thông'), unit: 'CM-BQLDAGT' }).du_an.every((project) => project.linh_vuc === 'Giao thông' && project.don_vi === 'CM-BQLDAGT')).toBe(true);
  });

  it('keep, on the 360° pages, the root tasks of the choice with their assignments', async () => {
    const db = await templateDb();
    const central = applyFilters(db, set('origin', 'TW'));
    expect(central.nv_goc).toHaveLength(24);
    expect(central.luot_giao).toHaveLength(72);
    expect(applyFilters(db, set('theme', 'Chuyển đổi số')).nv_goc).toHaveLength(10);
    expect(applyFilters(db, set('due', '2026-12')).nv_goc).toHaveLength(12);
    expect(central.du_an).toBe(db.du_an);
  });

  it('keep, for a unit, the root tasks it takes part in with every assignment of theirs, so each root task is judged as on the whole board', async () => {
    const db = await templateDb();
    const state = set('actor', 'Văn phòng UBND tỉnh');
    const unit = applyFilters(db, state);
    expect(unit.nv_goc).toHaveLength(13);
    expect(unit.nv_goc.every((root) => db.luot_giao.some((assignment) => assignment.nhiem_vu_goc === root.ma && assignment.don_vi === 'Văn phòng UBND tỉnh'))).toBe(true);
    // Every assignment of those root tasks, of whichever unit.
    const kept = new Set(unit.nv_goc.map((root) => root.ma));
    expect(unit.luot_giao).toEqual(db.luot_giao.filter((assignment) => kept.has(assignment.nhiem_vu_goc)));
    expect(new Set(unit.luot_giao.map((assignment) => assignment.don_vi)).size).toBeGreaterThan(1);
    expect(referenceProblems(unit)).toEqual([]);
    // A root task waits for its report once every assignment of it is accepted: with the assignments of one unit alone these four would be read as waiting.
    const statusOf = (tables: DashboardDb) => { const gov = E.gov(tables) as unknown as { roots: { ma: string }[]; sR(root: unknown): string }; return Object.fromEntries(gov.roots.map((root) => [root.ma, gov.sR(root)])); };
    const whole = statusOf(db);
    const cut = statusOf(unit);
    for (const root of ['NV-015', 'NV-029', 'NV-043', 'NV-057']) expect([root, cut[root]]).toEqual([root, whole[root]]);
    expect(Object.entries(cut).every(([root, status]) => whole[root] === status)).toBe(true);
    expect(optionsOf(db, emptyFilters(), 'actor').find((option) => option.value === 'Văn phòng UBND tỉnh')?.count).toBe(13);
  });

  it('cut a page by the filters of its own kind only, and judge a choice by one run of the engine', async () => {
    const db = await templateDb();
    const both = { ...set('unit', 'CM-BQLDAXD'), origin: 'TW' };
    expect(scoped(both, 'inv')).toEqual(set('unit', 'CM-BQLDAXD'));
    expect(scoped(both, 'gov')).toEqual(set('origin', 'TW'));
    expect(computable(E, db, emptyFilters(), 'inv')).toBe(true);
    expect(computable(E, db, set('unit', 'CM-BQLDAXD'), 'inv')).toBe(true);
    expect(computable(E, db, set('origin', 'TW'), 'gov')).toBe(true);
    // A unit whose one project holds no plan: nothing to divide by.
    expect(computable(E, db, set('unit', 'CM-SNNMT'), 'inv')).toBe(false);
    // The filters of the other kind are not judged: they do not cut the page.
    expect(computable(E, db, set('unit', 'CM-SNNMT'), 'gov')).toBe(true);
    expect(computable(E, db, set('theme', 'no such theme'), 'gov')).toBe(false);
    expect(computable(E, db, set('theme', 'no such theme'), 'inv')).toBe(true);
    // An engine that throws is a choice that cannot be computed.
    expect(computable({ ...E, gov: () => { throw new Error('no'); } }, db, emptyFilters(), 'gov')).toBe(false);
  });

  it('list what each filter can be set to, with how many rows a choice leaves under the other filters as they are set', async () => {
    const db = await templateDb();
    const none = emptyFilters();
    expect(optionsOf(db, none, 'year')).toEqual([{ value: 2026, label: '2026', count: 45 }]);
    expect(optionsOf(db, none, 'period').map((option) => option.value)).toEqual([10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
    expect(optionsOf(db, none, 'period')[0]).toEqual({ value: 10, label: 'Lũy kế đến tháng 10', count: null });
    expect(optionsOf(db, none, 'source').map((option) => [option.value, option.count])).toEqual([['NSTW', 21], ['NSDP', 37], ['SUPPORT', 16], ['ODAV', 5]]);
    expect(optionsOf(db, none, 'sector').find((option) => option.value === 'Giao thông')).toEqual({ value: 'Giao thông', label: 'Giao thông', count: 10 });
    expect(optionsOf(db, none, 'unit')[0]).toMatchObject({ value: 'CM-BQLDAXD', count: 10 });
    expect(optionsOf(db, none, 'unit')).toHaveLength(13);
    expect(optionsOf(db, none, 'origin')).toEqual([{ value: 'TW', label: 'Trung ương giao', count: 24 }, { value: 'TINH', label: 'Lãnh đạo tỉnh giao', count: 20 }, { value: 'BCD', label: 'Ban chỉ đạo giao', count: 16 }]);
    expect(optionsOf(db, none, 'theme')).toHaveLength(6);
    expect(optionsOf(db, none, 'due')).toEqual([{ value: '2026-10', label: 'Tháng 10/2026', count: 8 }, { value: '2026-11', label: 'Tháng 11/2026', count: 40 }, { value: '2026-12', label: 'Tháng 12/2026', count: 12 }]);
    // For a unit that carries tasks out: the root tasks it takes part in.
    expect(optionsOf(db, none, 'actor').find((option) => option.value === 'Sở Tài chính')?.count).toBe(13);
    // Under a unit, only the sectors and the sources of its projects are listed, and no choice that would leave nothing.
    const underUnit = optionsOf(db, set('unit', 'CM-SYT'), 'sector');
    expect(underUnit).toEqual([{ value: 'Y tế', label: 'Y tế', count: 2 }]);
    expect(optionsOf(db, set('sector', 'Y tế'), 'unit').reduce((sum, option) => sum + (option.count ?? 0), 0)).toBe(5);
    expect(optionsOf(db, set('origin', 'BCD'), 'theme').reduce((sum, option) => sum + (option.count ?? 0), 0)).toBe(16);
  });

  it('say on the chip what is chosen, and the name of "all" when nothing is', async () => {
    const db = await templateDb();
    const none = emptyFilters();
    expect((['year', 'period', 'source', 'sector', 'unit', 'origin', 'theme', 'actor', 'due'] as const).map((key) => chipText(db, none, key))).toEqual(['2026', 'Lũy kế đến tháng 10', 'Tất cả', 'Tất cả', 'Toàn tỉnh', 'Tất cả nguồn giao', 'Tất cả', 'Toàn tỉnh', 'Tất cả kỳ']);
    expect(chipText(db, set('period', 3), 'period')).toBe('Lũy kế đến tháng 3');
    expect(chipText(db, set('source', 'ODAV'), 'source')).toBe('Vốn nước ngoài (vay lại)');
    expect(chipText(db, set('unit', 'CM-STC'), 'unit')).toBe(db.don_vi.find((unit) => unit.ma === 'CM-STC')?.ten_ngan);
    expect(chipText(db, set('origin', 'BCD'), 'origin')).toBe('Ban chỉ đạo giao');
    expect(chipText(db, set('due', '2026-12'), 'due')).toBe('Tháng 12/2026');
    expect(chipText(db, set('theme', 'Chuyển đổi số'), 'theme')).toBe('Chuyển đổi số');
    // A value the tables do not have is said as it is.
    expect([chipText(db, set('source', 'X'), 'source'), chipText(db, set('unit', 'Y'), 'unit'), chipText(db, set('origin', 'Z'), 'origin')]).toEqual(['X', 'Y', 'Z']);
    expect([allLabel('year'), allLabel('period'), allLabel('unit')]).toEqual([null, null, 'Toàn tỉnh']);
    expect([chosen(db, none, 'year'), chosen(db, none, 'period'), chosen(db, set('period', 2), 'period'), chosen(db, none, 'unit'), chosen(db, set('unit', 'CM-STC'), 'unit')]).toEqual([2026, 10, 2, null, 'CM-STC']);
    expect(CHIP_FILTER.inv['Kỳ số liệu vốn']).toBe('period');
    expect(CHIP_FILTER.gov['Nhóm chuyên đề']).toBe('theme');
  });

  it('give the engine the chosen month, and a decomposition without the sources no project of the choice holds', async () => {
    const db = await templateDb();
    const whole = engineFor(E, db, emptyFilters()).invest(db) as unknown as { ky: number; disb: number; decomp: unknown[] };
    const toJune = engineFor(E, db, set('period', 6)).invest(db) as unknown as { ky: number; disb: number };
    expect([whole.ky, toJune.ky]).toEqual([10, 6]);
    expect(toJune.disb).toBeLessThan(whole.disb);
    expect(whole.decomp).toHaveLength(4);
    const state = set('unit', 'CM-BQLDANN');
    const unit = engineFor(E, db, state).invest(applyFilters(db, state)) as unknown as { decomp: { k: string }[] };
    expect(unit.decomp.length).toBeLessThan(4);
  });
});

describe('the chips of the board', () => {
  it('are buttons that say what they are set to, on the pages of investment and on the pages of the 360° work', async () => {
    mountOn(await templateDb());
    expect(FILTERS.inv.map((key) => [chip(key).getAttribute('role'), chip(key).getAttribute('aria-haspopup'), chip(key).getAttribute('aria-expanded'), chip(key).tabIndex])).toEqual(FILTERS.inv.map(() => ['button', 'listbox', 'false', 0]));
    expect(FILTERS.inv.map(chipSays)).toEqual(['2026', 'Lũy kế đến tháng 10', 'Tất cả', 'Tất cả', 'Toàn tỉnh']);
    expect(host.querySelector('[data-clear]')).toBeNull();
    board?.go(7);
    expect(FILTERS.gov.map(chipSays)).toEqual(['Tất cả nguồn giao', 'Tất cả', 'Toàn tỉnh', 'Tất cả kỳ']);
    // A page whose chips the template names otherwise: the ones that are a filter are buttons, the others stay text.
    board?.go(8);
    expect(Array.from(host.querySelectorAll('.sl .s')).map((one) => one.getAttribute('data-filter'))).toEqual(['origin', 'theme', null, null]);
    board?.go(5);
    expect(Array.from(host.querySelectorAll('.sl .s')).map((one) => one.getAttribute('data-filter'))).toEqual([null, null, null, 'unit']);
  });

  it('open a list of choices with their counts, the one in force marked, and close it by a click outside or on the chip again', async () => {
    mountOn(await templateDb());
    fireEvent.click(chip('source'));
    expect(chip('source').getAttribute('aria-expanded')).toBe('true');
    expect(menu()?.getAttribute('role')).toBe('listbox');
    expect(menu()?.getAttribute('aria-label')).toBe('Nguồn vốn');
    expect(rows().map((row) => row.getAttribute('role'))).toEqual(['option', 'option', 'option', 'option', 'option']);
    expect(rows().map((row) => row.textContent)).toEqual(['Tất cả', 'Ngân sách trung ương21', 'Ngân sách địa phương37', 'Trung ương hỗ trợ có mục tiêu16', 'Vốn nước ngoài (vay lại)5']);
    expect(rows().map((row) => row.getAttribute('aria-selected'))).toEqual(['true', 'false', 'false', 'false', 'false']);
    expect(document.activeElement).toBe(rows()[0]);
    // The list is inside the page, so it is scaled with it.
    expect(host.querySelector('.pg')?.contains(menu())).toBe(true);
    fireEvent.click(chip('source'));
    expect(menu()).toBeNull();
    expect(chip('source').getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(chip('sector'));
    fireEvent.click(chip('unit'));
    expect(host.querySelectorAll('.fmenu')).toHaveLength(1);
    expect(menu()?.getAttribute('aria-label')).toBe('Đơn vị');
    fireEvent.click(document.body);
    expect(menu()).toBeNull();
    fireEvent.click(chip('year'));
    expect(labels()).toEqual(['2026']);
    fireEvent.click(host.querySelector('.bd') as HTMLElement);
    expect(menu()).toBeNull();
  });

  it('draw the whole board again for a choice, say the choice on the chip, keep it from page to page, and restore the whole with the chip that clears', async () => {
    mountOn(await templateDb(), 3);
    // The page of the portfolio says how many projects it draws: 33 of the province, 7 of the unit.
    expect(projectsDrawn()).toBe(33);
    fireEvent.click(chip('unit'));
    pickRow('Ban QLDA xây dựng');
    expect(menu()).toBeNull();
    expect(projectsDrawn()).toBe(7);
    expect(chipSays('unit')).toBe('Ban QLDA xây dựng');
    expect(chip('unit').classList.contains('set')).toBe(true);
    expect(message()).toBeNull();
    // The reader stays on the page, on the chip that was used.
    expect(host.querySelector('.ft .on')?.textContent).toBe('Danh mục dự án');
    expect(document.activeElement).toBe(chip('unit'));
    // A second filter narrows the first; its list counts what the first leaves.
    fireEvent.click(chip('sector'));
    expect(rows().slice(1).reduce((sum, row) => sum + Number(row.querySelector('.n')?.textContent), 0)).toBeLessThanOrEqual(10);
    fireEvent.click(document.body);
    // The choice holds on the other pages of investment, and does not touch the pages of the 360° work.
    board?.go(0);
    expect(chipSays('unit')).toBe('Ban QLDA xây dựng');
    board?.go(7);
    expect(FILTERS.gov.map(chipSays)).toEqual(['Tất cả nguồn giao', 'Tất cả', 'Toàn tỉnh', 'Tất cả kỳ']);
    expect(host.querySelector('[data-clear]')).toBeNull();
    const rootsBefore = host.textContent;
    fireEvent.click(chip('origin'));
    pickRow('Ban chỉ đạo giao');
    expect(chipSays('origin')).toBe('Ban chỉ đạo giao');
    expect(host.textContent).not.toBe(rootsBefore);
    board?.go(3);
    expect(projectsDrawn()).toBe(7);
    fireEvent.click(host.querySelector('[data-clear]') as HTMLElement);
    expect(projectsDrawn()).toBe(33);
    expect(chipSays('unit')).toBe('Toàn tỉnh');
    expect(host.querySelector('[data-clear]')).toBeNull();
    expect(host.contains(document.activeElement)).toBe(true);
    // Clearing the filters of investment leaves the filter of the 360° pages.
    board?.go(7);
    expect(chipSays('origin')).toBe('Ban chỉ đạo giao');
    fireEvent.click(host.querySelector('[data-clear]') as HTMLElement);
    expect(chipSays('origin')).toBe('Tất cả nguồn giao');
  });

  it('read the capital figures to the chosen month, and take the closing month as no choice', async () => {
    mountOn(await templateDb());
    const closing = host.textContent;
    fireEvent.click(chip('period'));
    expect(labels()).toEqual([10, 9, 8, 7, 6, 5, 4, 3, 2, 1].map((month) => `Lũy kế đến tháng ${month}`));
    expect(rows()[0]?.getAttribute('aria-selected')).toBe('true');
    pickRow('Lũy kế đến tháng 6');
    expect(chipSays('period')).toBe('Lũy kế đến tháng 6');
    expect(host.textContent).toContain('Giải ngân lũy kế đến T6');
    // The chart of the monthly rhythm forecasts every month from the next one to December (at the closing month: November and December, as the template draws).
    board?.go(1);
    expect(host.textContent).toContain('từ T7 là dự báo theo nhịp hiện tại');
    const figures = engineFor(E, await templateDb(), set('period', 6)).invest(await templateDb()) as unknown as { fc: { k: number }[] };
    expect(figures.fc.slice(0, 12 - 6).map((month) => month.k)).toEqual([7, 8, 9, 10, 11, 12]);
    board?.go(0);
    expect(host.querySelector('[data-clear]')).not.toBeNull();
    fireEvent.click(chip('period'));
    expect(rows()[4]?.getAttribute('aria-selected')).toBe('true');
    pickRow('Lũy kế đến tháng 10');
    expect(host.querySelector('[data-clear]')).toBeNull();
    expect(host.textContent).toBe(closing);
    board?.go(1);
    expect(host.textContent).toContain('T11, T12 là dự báo theo nhịp hiện tại');
    board?.go(0);
    // The one year of the tables: choosing it changes nothing.
    fireEvent.click(chip('year'));
    pickRow('2026');
    expect(host.textContent).toBe(closing);
  });

  it('are worked by the keyboard, and the arrow keys do not turn the page while a list is open', async () => {
    mountOn(await templateDb());
    chip('sector').focus();
    fireEvent.keyDown(chip('sector'), { key: 'Enter' });
    expect(menu()).not.toBeNull();
    expect(document.activeElement).toBe(rows()[0]);
    fireEvent.keyDown(document.activeElement as Element, { key: 'ArrowDown' });
    fireEvent.keyDown(document.activeElement as Element, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(rows()[2]);
    fireEvent.keyDown(document.activeElement as Element, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(rows()[1]);
    fireEvent.keyDown(document.activeElement as Element, { key: 'End' });
    expect(document.activeElement).toBe(rows()[rows().length - 1]);
    fireEvent.keyDown(document.activeElement as Element, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(rows()[rows().length - 1]);
    fireEvent.keyDown(document.activeElement as Element, { key: 'Home' });
    expect(document.activeElement).toBe(rows()[0]);
    // Left and right would turn the page: not while the list is open.
    for (const key of ['ArrowRight', 'ArrowLeft', 'PageDown', 'PageUp']) fireEvent.keyDown(document.activeElement as Element, { key });
    expect(host.querySelector('.ft .on')?.textContent).toBe('Tổng quan');
    expect(menu()).not.toBeNull();
    fireEvent.keyDown(document.activeElement as Element, { key: 'Escape' });
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(chip('sector'));
    // Space opens as Enter does, the down arrow too; Enter on a row chooses it.
    fireEvent.keyDown(chip('sector'), { key: ' ' });
    expect(menu()).not.toBeNull();
    fireEvent.keyDown(document.activeElement as Element, { key: 'Escape' });
    fireEvent.keyDown(chip('sector'), { key: 'ArrowDown' });
    fireEvent.keyDown(document.activeElement as Element, { key: 'ArrowDown' });
    const picked = document.activeElement?.firstElementChild?.textContent;
    fireEvent.keyDown(document.activeElement as Element, { key: 'Enter' });
    expect(menu()).toBeNull();
    expect(chipSays('sector')).toBe(picked);
    expect(document.activeElement).toBe(chip('sector'));
    // The list is closed: the arrows turn the page again, and Tab leaves an open list behind closed.
    fireEvent.keyDown(chip('sector'), { key: 'Enter' });
    expect(document.activeElement?.classList.contains('fopt')).toBe(true);
    fireEvent.keyDown(document.activeElement as Element, { key: 'Tab' });
    expect(menu()).toBeNull();
    // Tab leaves from the chip, so the browser goes on to the stop after it (or before it).
    expect(document.activeElement).toBe(chip('sector'));
    const clear = host.querySelector('[data-clear]') as HTMLElement;
    clear.focus();
    fireEvent.keyDown(clear, { key: 'Enter' });
    expect(chipSays('sector')).toBe('Tất cả');
    fireEvent.keyDown(host, { key: 'ArrowRight' });
    expect(host.querySelector('.ft .on')?.textContent).toBe('Vốn & giải ngân');
  });

  it('refuse a choice the pages cannot be drawn for: the board stays as it was, a line says so, and the choice is not offered again beside the same filters', async () => {
    const db = copyOf(await templateDb());
    // A sector whose name is what a page must never say: the engine computes it, the page that writes it is refused.
    for (const project of db.du_an) if (project.linh_vuc === 'Y tế') project.linh_vuc = 'Infinity';
    mountOn(db, 2);
    fireEvent.click(chip('sector'));
    pickRow('Giao thông');
    const drawn = projectsDrawn();
    const before = host.textContent;
    fireEvent.click(chip('sector'));
    expect(labels()).toContain('Infinity');
    pickRow('Infinity');
    expect(message()).toBe('Không đủ dữ liệu cho lựa chọn này');
    expect(host.querySelector('.fmsg')?.getAttribute('role')).toBe('status');
    // The filter that was set stays set, and the page is the one it was.
    expect(chipSays('sector')).toBe('Giao thông');
    expect(projectsDrawn()).toBe(drawn);
    expect(host.textContent).toBe(`${before}`.replace('Xóa lọc', 'Xóa lọcKhông đủ dữ liệu cho lựa chọn này'));
    expect(host.querySelector('.ft .on')?.textContent).toBe('Nguyên nhân & cơ cấu');
    fireEvent.click(chip('sector'));
    expect(labels()).not.toContain('Infinity');
    fireEvent.click(document.body);
    // The line goes with the next choice that can be drawn, and with the next page.
    fireEvent.click(chip('period'));
    pickRow('Lũy kế đến tháng 9');
    expect(message()).toBeNull();
    expect(chipSays('sector')).toBe('Giao thông');
  });

  it('never change a page by a filter of the other kind: the 360° pages stay whole under an investment filter, and the pages of investment under a 360° filter', async () => {
    mountOn(await templateDb());
    const wholePages: string[] = [];
    for (let page = 0; page < (board?.count ?? 0); page += 1) { board?.go(page); wholePages.push(host.textContent ?? ''); }
    board?.go(3);
    fireEvent.click(chip('unit'));
    pickRow('Ban QLDA xây dựng');
    for (const page of [7, 8, 9]) { board?.go(page); expect(host.textContent, `page ${page}`).toBe(wholePages[page]); }
    // The pages of investment are cut, the 360° tiles of the overview included in the page that changes.
    board?.go(0);
    expect(host.textContent).not.toBe(wholePages[0]);
    fireEvent.click(host.querySelector('[data-clear]') as HTMLElement);
    board?.go(7);
    fireEvent.click(chip('theme'));
    pickRow('Chuyển đổi số');
    expect(host.textContent).not.toBe(wholePages[7]);
    for (const page of [0, 1, 2, 3, 4, 5, 6, 10]) { board?.go(page); expect(host.textContent, `page ${page}`).toBe(wholePages[page]); }
  });

  it('draw only the page on screen for a choice, and clear the filters with a line when a page turned to later cannot be drawn for them', async () => {
    const db = copyOf(await templateDb());
    for (const project of db.du_an) if (project.linh_vuc === 'Y tế') project.linh_vuc = 'Infinity';
    // The page of tasks does not write the sectors: the choice is taken there.
    mountOn(db, 4);
    fireEvent.click(chip('sector'));
    pickRow('Infinity');
    expect(message()).toBeNull();
    expect(chipSays('sector')).toBe('Infinity');
    expect(host.querySelectorAll('.pg')).toHaveLength(1);
    // The page of causes writes them: it is drawn whole, and says why.
    board?.go(2);
    expect(message()).toBe('Không đủ dữ liệu cho lựa chọn này');
    expect(chipSays('sector')).toBe('Tất cả');
    expect(host.querySelector('[data-clear]')).toBeNull();
    expect(host.querySelector('.ft .on')?.textContent).toBe('Nguyên nhân & cơ cấu');
    expect(host.textContent).not.toMatch(/NaN|undefined/);
    board?.go(4);
    expect(message()).toBeNull();
    expect(chipSays('sector')).toBe('Tất cả');
  });

  it('do not offer a choice the engine cannot compute: a unit none of whose projects holds a plan', async () => {
    mountOn(await templateDb());
    fireEvent.click(chip('unit'));
    const offered = labels();
    expect(offered[0]).toBe('Toàn tỉnh');
    expect(offered).toHaveLength(13);
    const withheld = optionsOf(await templateDb(), emptyFilters(), 'unit').filter((option) => !offered.includes(option.label));
    expect(withheld.map((option) => option.value)).toEqual(['CM-SNNMT']);
  });
});

describe('every choice the board offers on the tables of the template', () => {
  const walk = (keys: readonly FilterKey[], page: number) => async () => {
    const mounted = mountOn(await templateDb(), page);
    let tried = 0;
    for (const key of keys) {
      fireEvent.click(chip(key));
      const offered = labels();
      fireEvent.click(document.body);
      for (const label of offered) {
        mounted.go(page);
        fireEvent.click(chip(key));
        pickRow(label);
        expect(message(), `${key}: ${label}`).toBeNull();
        expect(chipSays(key), `${key}: ${label}`).toBe(key === 'period' || key === 'year' || label !== offered[0] ? label : chipSays(key));
        for (let index = 0; index < mounted.count; index += 1) {
          mounted.go(index);
          expect(message(), `${key}: ${label}, page ${mounted.names[index]}`).toBeNull();
          const said = BROKEN.exec(host.textContent ?? '');
          expect(said, `${key}: ${label}, page ${mounted.names[index]}: ${(host.textContent ?? '').slice(Math.max(0, (said?.index ?? 0) - 40), (said?.index ?? 0) + 20)}`).toBeNull();
          expect(host.querySelectorAll('section.t').length).toBeGreaterThan(2);
        }
        tried += 1;
      }
      // Back to the whole before the next filter.
      mounted.go(page);
      const clear = host.querySelector<HTMLElement>('[data-clear]');
      if (clear !== null) fireEvent.click(clear);
    }
    return tried;
  };

  it('draws every page of the board for every choice of the investment filters, with no figure that could not be computed', async () => {
    // 1 year, 10 months, all + 4 sources, all + 8 sectors, all + 12 units (one unit is withheld: its project holds no plan).
    expect(await walk(FILTERS.inv, 0)()).toBe(1 + 10 + 5 + 9 + 13);
  }, 120_000);

  it('draws every page of the board for every choice of the 360° filters, with no figure that could not be computed', async () => {
    // All + 3 sources of tasks, all + 6 themes, all + 14 units, all + 3 months.
    expect(await walk(FILTERS.gov, 7)()).toBe(4 + 7 + 15 + 4);
  }, 120_000);
});
