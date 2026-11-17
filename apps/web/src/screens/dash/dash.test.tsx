import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import vi_ from '../../i18n/vi.json';
import { harness, mount, routeOf } from '../mne/test-support';
import DashboardScreen, { pageOf } from './DashboardScreen';
import HomeLandingScreen from './HomeLandingScreen';
import type { DashboardDb } from './db';
import { isCaMauTenant } from './scope';
import { assemble, TABLES } from './sources/assemble';
import { loadTemplateDb } from './sources/template-db';
import { E } from './template/engine.js';

const ROUTE = routeOf('HOME-01', 'FR-HOME-01');
const CA_MAU = { id: '00000000-0000-4000-8000-0000000000c1', name: 'UBND tỉnh Cà Mau', monogram: 'CM', membershipId: '00000000-0000-4000-8000-0000000000f1', theme: { themeId: 'theme-a', version: 1, overlay: {} } };
const PAGES = ['Tổng quan', 'Vốn & giải ngân', 'Nguyên nhân & cơ cấu', 'Danh mục dự án', 'Nhiệm vụ & chỉ đạo', 'Đôn đốc đầu tư', 'Trách nhiệm đơn vị', 'Điều hành 360°', 'Đôn đốc 360°', 'Tồn việc & quyết định', 'Rủi ro & hành động'];
const text = (key: string): string => (vi_ as Record<string, string>)[key] ?? key;

// jsdom lays nothing out: the charts of the template size themselves from the box they are drawn in, so every element is given one.
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 600 });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 300 });
});
afterEach(cleanup);

const tabs = (): HTMLElement[] => Array.from(screen.getByTestId('dash9').querySelectorAll<HTMLElement>('[data-pg]'));
const shownPage = (): string | null => screen.getByTestId('dash9').querySelector('.ft .on')?.textContent ?? null;

describe('the tenant the dashboard belongs to', () => {
  it('is the province of Cà Mau by its name, with or without tone marks, and no other tenant', () => {
    expect(isCaMauTenant({ name: 'UBND tỉnh Cà Mau' })).toBe(true);
    expect(isCaMauTenant({ name: 'Ủy ban nhân dân tỉnh CA MAU' })).toBe(true);
    expect(isCaMauTenant({ name: 'Cao Bằng' })).toBe(false);
    expect(isCaMauTenant({ name: 'Tỉnh Camau Holdings' })).toBe(false);
    expect(isCaMauTenant(undefined)).toBe(false);
  });
});

describe('the tables of the dashboard', () => {
  it('come from the template when the system supplies none, and say so table by table', async () => {
    const template = await loadTemplateDb();
    const data = assemble(template);
    expect(Object.keys(data.db).sort()).toEqual([...TABLES].sort());
    expect(new Set(Object.values(data.origins))).toEqual(new Set(['template']));
    expect(data.db.du_an).toHaveLength(45);
    expect(data.db.nv_goc).toHaveLength(60);
    expect(data.db.luot_giao).toHaveLength(180);
  });

  it('take a table the system supplied in place of the template table, and leave the others', async () => {
    const template = await loadTemplateDb();
    const units: DashboardDb['don_vi'] = [{ ma: 'U1', ten: 'Đơn vị một', ten_ngan: 'ĐV 1', khoi: 'Sở, ban, ngành', da_nop_so: 1 }];
    const data = assemble(template, { don_vi: units });
    expect(data.db.don_vi).toBe(units);
    expect(data.origins.don_vi).toBe('system');
    expect(data.origins.du_an).toBe('template');
    expect(template.don_vi).toHaveLength(26);
  });

  it('carry no word that calls the figures illustrative', async () => {
    const template = await loadTemplateDb();
    expect(JSON.stringify(template)).not.toMatch(/minh họa|mô phỏng|mockup/i);
  });

  it('give the engine the headline figures of the template: 3.900 billion planned, 60 root tasks and 180 assignments', async () => {
    const template = await loadTemplateDb();
    const invest = E.invest(template) as unknown as { plan: number; ps: unknown[]; tc: { total: number }; alerts: unknown[] };
    const gov = E.gov(template) as unknown as { roots: unknown[]; acts: unknown[]; funnel: [string, number][]; a: { done: number; late: number } };
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
    expect(screen.getByRole('button', { name: text('home.dash.full.label') })).toBeTruthy();
  });

  it('draws every page without an error, by its tab and by the arrow keys', async () => {
    mount(<DashboardScreen route={ROUTE} />, harness(() => ({})), { tenant: CA_MAU });
    await waitFor(() => expect(tabs()).toHaveLength(PAGES.length));
    for (let index = 0; index < PAGES.length; index += 1) {
      fireEvent.click(tabs()[index] as HTMLElement);
      await waitFor(() => expect(shownPage()).toBe(PAGES[index]));
      expect(screen.getByTestId('dash9').querySelectorAll('section.t').length).toBeGreaterThan(2);
    }
    fireEvent.keyDown(screen.getByTestId('dash9'), { key: 'ArrowLeft' });
    await waitFor(() => expect(shownPage()).toBe(PAGES[PAGES.length - 2]));
    fireEvent.keyDown(screen.getByTestId('dash9'), { key: 'ArrowRight' });
    fireEvent.keyDown(screen.getByTestId('dash9'), { key: 'ArrowRight' });
    await waitFor(() => expect(shownPage()).toBe(PAGES[PAGES.length - 1]));
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

  it('stays the executive overview for every other tenant', async () => {
    mount(<HomeLandingScreen route={ROUTE} />, harness(() => ({})));
    await waitFor(() => expect(document.querySelector('[data-screen-id="HOME-01"]')).not.toBeNull());
    expect(screen.queryByTestId('dash9')).toBeNull();
  });
});
