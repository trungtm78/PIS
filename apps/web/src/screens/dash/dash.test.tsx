import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import vi_ from '../../i18n/vi.json';
import { harness, mount, routeOf } from '../mne/test-support';
import DashboardScreen, { pageOf } from './DashboardScreen';
import HomeLandingScreen from './HomeLandingScreen';
import type { DashboardDb } from './db';
import { isCaMauTenant } from './scope';
import { assemble, plainText, referenceProblems, TABLES } from './sources/assemble';
import { loadTemplateDb } from './sources/template-db';
import { E } from './template/engine.js';
import { mountDashboard } from './template/index.js';

const ROUTE = routeOf('HOME-01', 'FR-HOME-01');
const CA_MAU = { id: '00000000-0000-4000-8000-0000000000c1', name: 'UBND tỉnh Cà Mau', monogram: 'CM', membershipId: '00000000-0000-4000-8000-0000000000f1', theme: { themeId: 'theme-a', version: 1, overlay: {} } };
const PAGES = ['Tổng quan', 'Vốn & giải ngân', 'Nguyên nhân & cơ cấu', 'Danh mục dự án', 'Nhiệm vụ & chỉ đạo', 'Đôn đốc đầu tư', 'Trách nhiệm đơn vị', 'Điều hành 360°', 'Đôn đốc 360°', 'Tồn việc & quyết định', 'Rủi ro & hành động'];
const text = (key: string): string => (vi_ as Record<string, string>)[key] ?? key;
const copyOf = (db: DashboardDb): DashboardDb => JSON.parse(JSON.stringify(db)) as DashboardDb;

// jsdom lays nothing out: the charts of the template size themselves from the box they are drawn in, so every element is given one.
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 600 });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 300 });
});
afterEach(cleanup);

const tabs = (): HTMLElement[] => Array.from(screen.getByTestId('dash9').querySelectorAll<HTMLElement>('[data-pg]'));
const shownPage = (): string | null => screen.getByTestId('dash9').querySelector('.ft .on')?.textContent ?? null;

describe('the tenant the dashboard belongs to', () => {
  it('is the province of Cà Mau by its whole name, with or without tone marks, and no other tenant', () => {
    expect(isCaMauTenant({ name: 'UBND tỉnh Cà Mau' })).toBe(true);
    expect(isCaMauTenant({ name: 'Ủy ban nhân dân tỉnh CA MAU' })).toBe(true);
    expect(isCaMauTenant({ name: 'Cà Mau' })).toBe(true);
    expect(isCaMauTenant({ name: 'Cao Bằng' })).toBe(false);
    expect(isCaMauTenant(undefined)).toBe(false);
    // A department, a commune or a company of the province is another tenant: only the whole name of the province is the province.
    expect(isCaMauTenant({ name: 'Sở Y tế Cà Mau' })).toBe(false);
    expect(isCaMauTenant({ name: 'Ca Mau Holdings' })).toBe(false);
    expect(isCaMauTenant({ name: 'UBND phường Tân Thành, Cà Mau' })).toBe(false);
  });
});

describe('the tables of the dashboard', () => {
  it('come from the template when the system supplies none, hold together, and say where they came from', async () => {
    const template = await loadTemplateDb();
    const data = assemble(template);
    expect(Object.keys(data.db).sort()).toEqual([...TABLES].sort());
    expect(new Set(Object.values(data.origins))).toEqual(new Set(['template']));
    expect(referenceProblems(data.db)).toEqual([]);
    expect(data.db.du_an).toHaveLength(45);
    expect(data.db.nv_goc).toHaveLength(60);
    expect(data.db.luot_giao).toHaveLength(180);
  });

  it('take a whole bundle the system supplied in place of the template bundle, and leave the other bundles', async () => {
    const template = await loadTemplateDb();
    const papers: DashboardDb['ho_so_trinh'] = [{ ma: 'P1', loai: 'Tờ trình chờ duyệt', noi_dung: 'Tờ trình một', don_vi: 'CM-STC', du_an: null, ngay_nhan: '2026-11-10', han: '2026-11-20' }];
    const data = assemble(template, { ho_so_trinh: papers });
    expect(data.db.ho_so_trinh).toEqual(papers);
    expect(data.origins.ho_so_trinh).toBe('system');
    expect(data.origins.du_an).toBe('template');
    expect(template.ho_so_trinh).toHaveLength(7);
  });

  it('refuse a bundle supplied in part, a row that names a unit the tables do not have, and a day that is not a day', async () => {
    const template = await loadTemplateDb();
    const units: DashboardDb['don_vi'] = [{ ma: 'U1', ten: 'Đơn vị một', ten_ngan: 'ĐV 1', khoi: 'Sở, ban, ngành', da_nop_so: 1 }];
    expect(() => assemble(template, { don_vi: units })).toThrow(/in part/);
    const { moc_thoi_gian, nguon_von, muc_tieu, du_an, giai_ngan } = template;
    expect(() => assemble(template, { moc_thoi_gian, nguon_von, muc_tieu, don_vi: units, du_an, giai_ngan })).toThrow(/do not hold together/);
    // The engine walks from day to day: a day it cannot read is refused before it gets there, not looped on.
    const badDay = copyOf(template);
    (badDay.nhiem_vu[0] as { han: string | null }).han = '17/11/2026';
    expect(() => assemble(badDay)).toThrow(/is not a day/);
    const noDay = copyOf(template);
    (noDay.luot_giao[0] as { han_noi_bo: string }).han_noi_bo = '2026-02-31x';
    expect(() => assemble(noDay)).toThrow(/is not a day/);
  });

  it('carry no word that calls the figures illustrative', async () => {
    const template = await loadTemplateDb();
    expect(JSON.stringify(template)).not.toMatch(/minh họa|mô phỏng|mockup/i);
  });

  it('let no text reach the charts as markup: a name typed into the system stays text on every page', async () => {
    expect(plainText('<img src=x onerror="alert(1)">')).not.toMatch(/[<>"]/);
    const attack = ' <img src=x onerror="alert(1)"><script>alert(2)</script>';
    const hostile = copyOf(await loadTemplateDb());
    // Every free text of every table: names, contents, document numbers, reasons.
    const FREE_TEXT = new Set(['ten', 'ten_ngan', 'noi_dung', 'van_ban', 'nguyen_nhan', 'vuong_mac', 'chu_tri', 'cuoc_hop', 'dia_ban']);
    for (const rows of Object.values(hostile) as Record<string, unknown>[][]) for (const row of rows) for (const [key, value] of Object.entries(row)) if (FREE_TEXT.has(key) && typeof value === 'string') row[key] = value + attack;
    // The code of a root task is written into the page too.
    const first = hostile.nv_goc[0] as { ma: string };
    for (const assignment of hostile.luot_giao) if (assignment.nhiem_vu_goc === first.ma) assignment.nhiem_vu_goc = `${first.ma}${attack}`;
    first.ma = `${first.ma}${attack}`;
    const { db } = assemble(hostile);
    const host = document.createElement('div');
    document.body.append(host);
    const board = mountDashboard(host, db);
    for (let page = 0; page < board.count; page += 1) {
      board.go(page);
      expect(host.querySelectorAll('img, script').length).toBe(0);
      expect(host.querySelectorAll('[onerror]').length).toBe(0);
    }
    board.dispose();
    host.remove();
  });

  it('give the engine the headline figures of the template: 3.900 billion planned, 60 root tasks and 180 assignments', async () => {
    const { db } = assemble(await loadTemplateDb());
    const invest = E.invest(db) as unknown as { plan: number; ps: unknown[]; tc: { total: number }; alerts: unknown[] };
    const gov = E.gov(db) as unknown as { roots: unknown[]; acts: unknown[]; funnel: [string, number][]; a: { done: number; late: number } };
    expect(invest.plan).toBe(3_900_000);
    expect(invest.ps).toHaveLength(45);
    expect(invest.tc.total).toBe(930);
    expect(invest.alerts).toHaveLength(13);
    expect(gov.roots).toHaveLength(60);
    expect(gov.acts).toHaveLength(180);
    expect(gov.funnel.map((step) => step[1])).toEqual([180, 156, 100, 76]);
    expect(gov.a.done).toBe(76);
    expect(gov.a.late).toBe(60);
  });
});

describe('HOME-01 of Cà Mau: the dashboard of the steering work', () => {
  it('reads the page of the address, and takes anything else as the first page', () => {
    expect(pageOf('3')).toBe(2);
    expect(pageOf(null)).toBe(0);
    expect(pageOf('0')).toBe(0);
    expect(pageOf('x')).toBe(0);
  });

  it('draws the first page with a tab for every page and no label that calls the figures illustrative', async () => {
    mount(<DashboardScreen route={ROUTE} />, harness(() => ({})), { tenant: CA_MAU });
    await waitFor(() => expect(tabs()).toHaveLength(PAGES.length));
    expect(tabs().map((tab) => tab.textContent)).toEqual(PAGES);
    expect(shownPage()).toBe('Tổng quan');
    const board = screen.getByTestId('dash9');
    expect(board.textContent).toContain('UBND TỈNH CÀ MAU');
    expect(board.textContent).not.toMatch(/minh họa|mô phỏng|mockup/i);
    // jsdom cannot show an element full screen: the button is offered only where the browser can.
    expect(screen.queryByRole('button', { name: text('home.dash.full.label') })).toBeNull();
  });

  it('draws every page without an error, by its tab and by the arrow keys, and keeps the focus on the board', async () => {
    mount(<DashboardScreen route={ROUTE} />, harness(() => ({})), { tenant: CA_MAU });
    await waitFor(() => expect(tabs()).toHaveLength(PAGES.length));
    for (let index = 0; index < PAGES.length; index += 1) {
      fireEvent.click(tabs()[index] as HTMLElement);
      await waitFor(() => expect(shownPage()).toBe(PAGES[index]));
      expect(screen.getByTestId('dash9').querySelectorAll('section.t').length).toBeGreaterThan(2);
    }
    // The reader is on the last tab: drawing a page replaces that tab, and the focus follows to the tab of the new page, so the next arrow key still reaches the board.
    (tabs()[PAGES.length - 1] as HTMLElement).focus();
    fireEvent.keyDown(document.activeElement as Element, { key: 'ArrowLeft' });
    await waitFor(() => expect(shownPage()).toBe(PAGES[PAGES.length - 2]));
    expect(screen.getByTestId('dash9').contains(document.activeElement)).toBe(true);
    expect(document.activeElement?.textContent).toBe(PAGES[PAGES.length - 2]);
    fireEvent.keyDown(document.activeElement as Element, { key: 'ArrowRight' });
    await waitFor(() => expect(shownPage()).toBe(PAGES[PAGES.length - 1]));
    expect(document.activeElement?.textContent).toBe(PAGES[PAGES.length - 1]);
  });

  it('opens on the page the address names', async () => {
    mount(<DashboardScreen route={ROUTE} />, harness(() => ({})), { tenant: CA_MAU }, '/?trang=8');
    await waitFor(() => expect(shownPage()).toBe('Điều hành 360°'));
  });
});

describe('HOME-01, the leader home', () => {
  it('is the dashboard for Cà Mau', async () => {
    mount(<HomeLandingScreen route={ROUTE} />, harness(() => ({})), { tenant: CA_MAU });
    await waitFor(() => expect(screen.queryByTestId('dash9')).not.toBeNull());
  });

  it('is the executive overview for a reader of Cà Mau the server refuses the figures of the province: no board of template figures in their place', async () => {
    mount(<HomeLandingScreen route={ROUTE} />, harness(() => Object.assign(new Error('SCOPE_DENIED'), { status: 403 })), { tenant: CA_MAU });
    await waitFor(() => expect(document.querySelector('[data-screen-id="HOME-01"]:not(.dash9-screen)')).not.toBeNull());
    expect(screen.queryByTestId('dash9')).toBeNull();
  });

  it('stays the executive overview for every other tenant', async () => {
    mount(<HomeLandingScreen route={ROUTE} />, harness(() => ({})));
    await waitFor(() => expect(document.querySelector('[data-screen-id="HOME-01"]')).not.toBeNull());
    expect(screen.queryByTestId('dash9')).toBeNull();
  });
});
