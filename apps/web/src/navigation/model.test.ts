import { describe, expect, it } from 'vitest';
import { WEB_ROUTES } from '../routes/web-routes';
import { ARCHITECTURE } from './architecture';
import { ALL_MODULES_VISIBLE, buildNavigation, normalizeSearch } from './model';
import type { NavigationAccess } from './model';

const model = buildNavigation(ARCHITECTURE, WEB_ROUTES, ALL_MODULES_VISIBLE);

describe('buildNavigation for the real architecture file', () => {
  it('has the personal destinations, seven quick modules and six library areas', () => {
    expect(model.personal.map((link) => link.id)).toEqual(['HOME-01', 'HOME-02', 'NOT-01']);
    expect(model.personal.map((link) => link.expandable)).toEqual([false, false, true]);
    expect(model.quick.map((link) => link.module)).toEqual(['PRJ', 'CAP', 'DIS', 'CTR', 'PAY', 'BID', 'BI']);
    expect(model.quick.every((link) => link.expandable && link.id === `${link.module}-01`)).toBe(true);
    expect(model.library.map((area) => area.id)).toEqual(['overview', 'investment', 'insights', 'engagement', 'data', 'admin']);
  });

  it('gives the contextual shortcuts of PRJ in the architecture order, with their routes', () => {
    const shortcuts = model.shortcuts.get('PRJ') ?? [];
    expect(shortcuts.map((shortcut) => shortcut.id)).toEqual(['PRJ-07', 'PRJ-04', 'PRJ-09', 'PRJ-12']);
    for (const shortcut of shortcuts) expect(WEB_ROUTES.find((route) => route.id === shortcut.id)?.path).toBe(shortcut.path);
    expect(shortcuts[0]?.label).toBe('Tiến độ & mốc');
  });

  it('lists the administration library modules separately and keeps them in their area of the full library', () => {
    expect(model.adminLibrary.flatMap((area) => area.modules.map((module) => module.code)).sort()).toEqual([...ARCHITECTURE.adminLibraryModules].sort());
    const all = model.library.flatMap((area) => area.modules.map((module) => module.code));
    for (const code of ARCHITECTURE.adminLibraryModules) expect(all).toContain(code);
    expect(model.adminLibrary.every((area) => area.modules.length > 0)).toBe(true);
  });

  it('describes a library module with its name, description and root route', () => {
    const adm = model.adminLibrary.flatMap((area) => area.modules).find((module) => module.code === 'ADM');
    expect(adm).toEqual({
      code: 'ADM',
      name: 'Quản trị tổ chức',
      description: ARCHITECTURE.moduleDescriptions.ADM,
      path: WEB_ROUTES.find((route) => route.id === 'ADM-01')?.path,
    });
  });

  it('builds the directory of a module from its task groups', () => {
    const groups = model.directory('ADM');
    expect(groups.map((group) => group.title)).toEqual(['Tổ chức & con người', 'Quy trình & cấu hình', 'Tích hợp & an toàn', 'Quy tắc quản trị']);
    // The governance rule screens are one group: the catalogue and the alert type registry lead, the rest hang under the catalogue.
    expect(groups[3]?.links.map((link) => link.id)).toEqual(expect.arrayContaining(['ADM-19', 'ADM-23']));
    const first = groups[0]?.links.map((link) => link.id) ?? [];
    expect(first.slice(0, 4)).toEqual(['ADM-01', 'ADM-02', 'ADM-03', 'ADM-04']);
    expect(first).toEqual(expect.arrayContaining(['ADM-15', 'ADM-16', 'ADM-17']));
    expect(model.directory('NOPE')).toEqual([]);
  });

  it('names the module of a route for the breadcrumb', () => {
    const route = WEB_ROUTES.find((candidate) => candidate.id === 'ADM-01');
    expect(route).toBeDefined();
    expect(model.breadcrumb(route as NonNullable<typeof route>)).toEqual({ module: 'Quản trị tổ chức', title: 'Cây tổ chức' });
    expect(model.moduleName('UNKNOWN')).toBe('UNKNOWN');
  });
});

describe('access filtering', () => {
  const only = (...modules: string[]): NavigationAccess => ({ isModuleVisible: (code) => modules.includes(code) });

  it('hides modules the user cannot see from quick links, shortcuts, library and directory', () => {
    const limited = buildNavigation(ARCHITECTURE, WEB_ROUTES, only('PRJ', 'ADM'));
    expect(limited.quick.map((link) => link.module)).toEqual(['PRJ']);
    expect(limited.shortcuts.has('CAP')).toBe(false);
    expect(limited.shortcuts.has('PRJ')).toBe(true);
    expect(limited.library.flatMap((area) => area.modules.map((module) => module.code)).sort()).toEqual(['ADM', 'PRJ']);
    expect(limited.adminLibrary.flatMap((area) => area.modules.map((module) => module.code))).toEqual(['ADM']);
    expect(limited.directory('CAP')).toEqual([]);
    expect(limited.personal).toHaveLength(3);
  });

  it('answers whether a module is visible, for the links that are built outside the model', () => {
    const limited = buildNavigation(ARCHITECTURE, WEB_ROUTES, only('PRJ'));
    expect(limited.isModuleVisible('PRJ')).toBe(true);
    expect(limited.isModuleVisible('ISS')).toBe(false);
  });
});

describe('normalizeSearch', () => {
  it('lower-cases, strips Vietnamese diacritics and maps đ to d', () => {
    expect(normalizeSearch('  Quản trị Đơn vị ')).toBe('quan tri don vi');
  });
});
