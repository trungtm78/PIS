import { ENTERPRISE_ONLY_MODULES } from '@machvon/kernel/src/edition.ts';
import { afterEach, describe, expect, it } from 'vitest';
import { NotImplementedScreen } from '../routes/NotImplementedScreen';
import { resolveScreen, routeById } from '../routes/registry';
import { screenModules } from '../routes/screens/index';
import { WEB_ROUTES } from '../routes/web-routes';
import { editionAccess, editionRoutes, installEdition, resetEdition } from './edition';
import { enterpriseBundle } from './enterprise';

// This test names the enterprise folder, so it carries `.enterprise.` in its name: the edition check lets only such tests, the loader and the folder itself do so.
const IDS = ['EBS-01', 'EBS-02', 'HPM-01', 'HPM-02', 'ORG-01', 'RML-01'];

afterEach(() => resetEdition());

describe('the screens the enterprise edition brings with it (ENT-2)', () => {
  it('are exactly the five screens of the modules that exist in the enterprise edition only', () => {
    expect(Object.keys(enterpriseBundle.screens ?? {}).sort()).toEqual(IDS);
    expect(WEB_ROUTES.filter((route) => ENTERPRISE_ONLY_MODULES.includes(route.module)).map((route) => route.id).sort()).toEqual(IDS);
  });

  it('are not in the table of the public screens, so a public build never loads them', () => {
    for (const id of IDS) expect(screenModules[id]).toBeUndefined();
    expect(resolveScreen('HPM-01')).toBe(NotImplementedScreen);
  });

  it('open in the enterprise edition and are not found in the public one', () => {
    for (const id of IDS) expect(routeById(id)).toBeUndefined();
    installEdition(enterpriseBundle);
    for (const id of IDS) {
      expect(routeById(id)?.id).toBe(id);
      expect(resolveScreen(id)).not.toBe(NotImplementedScreen);
    }
    expect(editionRoutes(WEB_ROUTES)).toBe(WEB_ROUTES);
    expect(editionAccess({ isModuleVisible: () => true }).isModuleVisible('HPM')).toBe(true);
  });
});
