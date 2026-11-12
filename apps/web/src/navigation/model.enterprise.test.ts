import { describe, expect, it } from 'vitest';
import { WEB_ROUTES } from '../routes/web-routes';
import { ARCHITECTURE } from './architecture';
import { ENTERPRISE_NAVIGATION } from '../editions/enterprise';
import { ALL_MODULES_VISIBLE, buildNavigation, resolveNavigationExtension } from './model';
import type { NavigationAccess } from './model';

const model = buildNavigation(ARCHITECTURE, WEB_ROUTES, ALL_MODULES_VISIBLE);

describe('buildNavigation with the entries of an edition', () => {
  const extension = resolveNavigationExtension(ENTERPRISE_NAVIGATION, (key) => key);

  it('is byte-identical to the design data without an extension', () => {
    const same = buildNavigation(ARCHITECTURE, WEB_ROUTES, ALL_MODULES_VISIBLE, []);
    expect(same.quick).toEqual(model.quick);
    expect(same.personal).toEqual(model.personal);
    expect(same.shortcuts).toEqual(model.shortcuts);
    expect(same.library).toEqual(model.library);
    expect(resolveNavigationExtension(undefined, (key) => key)).toEqual([]);
  });

  it('places the reporting chain after Giải ngân and keeps the relative order of the other modules', () => {
    const enterprise = buildNavigation(ARCHITECTURE, WEB_ROUTES, ALL_MODULES_VISIBLE, extension);
    expect(enterprise.quick.map((link) => link.module)).toEqual(['PRJ', 'CAP', 'DIS', 'RPT', 'HPM', 'DIR', 'CTR', 'PAY', 'BID', 'BI']);
    expect(enterprise.quick.filter((link) => model.quick.some((base) => base.module === link.module)).map((link) => link.module)).toEqual(model.quick.map((link) => link.module));
    expect(enterprise.quick.find((link) => link.module === 'HPM')).toMatchObject({ id: 'HPM-01', path: '/hpm/hpm-01', expandable: true, covers: ['EBS'] });
    expect(enterprise.quick.find((link) => link.module === 'RPT')?.path).toBe('/rpt/rpt-01');
    expect(enterprise.quick.find((link) => link.module === 'DIR')?.path).toBe('/dir/dir-01');
  });

  it('gives the shortcuts of each entry with the routes of their screens, EBS under HPM', () => {
    const enterprise = buildNavigation(ARCHITECTURE, WEB_ROUTES, ALL_MODULES_VISIBLE, extension);
    expect(enterprise.shortcuts.get('RPT')?.map((shortcut) => shortcut.id)).toEqual(['RPT-01', 'RPT-02', 'RPT-03', 'RPT-09']);
    expect(enterprise.shortcuts.get('HPM')?.map((shortcut) => shortcut.id)).toEqual(['HPM-01', 'HPM-02', 'EBS-01', 'EBS-02']);
    expect(enterprise.shortcuts.get('DIR')?.map((shortcut) => shortcut.id)).toEqual(['DIR-01', 'DIR-03', 'DIR-05']);
    for (const shortcut of enterprise.shortcuts.get('HPM') ?? []) expect(WEB_ROUTES.find((route) => route.id === shortcut.id)?.path).toBe(shortcut.path);
    expect(enterprise.shortcuts.get('PRJ')).toEqual(model.shortcuts.get('PRJ'));
  });

  it('shows an entry only to a session that may open the module, and drops a shortcut of a module it may not open', () => {
    const noHpm: NavigationAccess = { isModuleVisible: (module) => module !== 'HPM' };
    expect(buildNavigation(ARCHITECTURE, WEB_ROUTES, noHpm, extension).quick.map((link) => link.module)).toEqual(['PRJ', 'CAP', 'DIS', 'RPT', 'DIR', 'CTR', 'PAY', 'BID', 'BI']);
    const noEbs: NavigationAccess = { isModuleVisible: (module) => module !== 'EBS' };
    expect(buildNavigation(ARCHITECTURE, WEB_ROUTES, noEbs, extension).shortcuts.get('HPM')?.map((shortcut) => shortcut.id)).toEqual(['HPM-01', 'HPM-02']);
  });

  it('keeps an entry out of the list when its route is not in the edition', () => {
    const without = WEB_ROUTES.filter((route) => route.module !== 'RPT');
    expect(buildNavigation(ARCHITECTURE, without, ALL_MODULES_VISIBLE, extension).quick.map((link) => link.module)).not.toContain('RPT');
  });
});
