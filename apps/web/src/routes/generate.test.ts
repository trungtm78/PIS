import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildRoutes, pathOf, renderRoutesData } from './generate.ts';
import type { NavigationArchitecture, ScreenCatalogue } from './generate.ts';
import { WEB_ROUTES } from './web-routes.ts';

const ENGINEERING = resolve(__dirname, '..', '..', '..', '..', 'Design', 'MACHVON_Design', '03_Engineering');
const architecture = JSON.parse(readFileSync(resolve(ENGINEERING, 'navigation_architecture.json'), 'utf8')) as NavigationArchitecture;
const catalogue = JSON.parse(readFileSync(resolve(ENGINEERING, 'screen_catalog.json'), 'utf8')) as ScreenCatalogue;

const route = (id: string, module: string, parent: string | null = null) => ({
  id,
  title: `Title ${id}`,
  kind: 'form',
  area: 'overview',
  module,
  group: 'Group',
  role: 'workspace',
  parent,
});
const small = (routes: NavigationArchitecture['webRoutes']): NavigationArchitecture => ({ webRoutes: routes });
const known: ScreenCatalogue = [{ id: 'A-01', req: 'FR-A-01' }, { id: 'A-02' }, { id: 'B-01', req: 'FR-B-01' }];

describe('buildRoutes on the real design files', () => {
  const routes = buildRoutes(architecture, catalogue);

  it('builds the 593 web routes of the navigation architecture, in file order', () => {
    expect(routes).toHaveLength(593);
    expect(routes.map((entry) => entry.id)).toEqual(architecture.webRoutes.map((entry) => entry.id));
  });

  it('gives every route a unique id and a unique lower-case path of the form /module/id', () => {
    expect(new Set(routes.map((entry) => entry.id)).size).toBe(593);
    expect(new Set(routes.map((entry) => entry.path)).size).toBe(593);
    for (const entry of routes) expect(entry.path).toBe(`/${entry.module.toLowerCase()}/${entry.id.toLowerCase()}`);
  });

  it('points every parent at a route of the table', () => {
    const ids = new Set(routes.map((entry) => entry.id));
    for (const entry of routes) if (entry.parent !== null) expect(ids.has(entry.parent)).toBe(true);
  });

  it('carries the requirement id of the screen catalogue', () => {
    expect(routes.find((entry) => entry.id === 'ADM-01')?.req).toBe('FR-ADM-01');
    expect(routes.filter((entry) => entry.req === null)).toEqual([]);
  });

  it('is what the committed data file holds, byte for byte', () => {
    expect(renderRoutesData(routes)).toBe(renderRoutesData(WEB_ROUTES));
    expect(WEB_ROUTES).toEqual(routes);
  });
});

describe('buildRoutes and renderRoutesData', () => {
  it('is deterministic: two runs give identical text', () => {
    const routes = buildRoutes(architecture, catalogue);
    expect(renderRoutesData(routes)).toBe(renderRoutesData(buildRoutes(architecture, catalogue)));
  });

  it('changes the output when a title changes', () => {
    const base = small([route('A-01', 'A')]);
    const edited = small([{ ...route('A-01', 'A'), title: 'Another title' }]);
    expect(renderRoutesData(buildRoutes(edited, known))).not.toBe(renderRoutesData(buildRoutes(base, known)));
  });

  it('puts one route per line between the generated header and the closing bracket, with LF endings', () => {
    const text = renderRoutesData(buildRoutes(small([route('A-01', 'A'), route('A-02', 'A', 'A-01')]), known));
    expect(text).not.toContain('\r');
    expect(text.split('\n').filter((line) => line.startsWith('    {"id"'))).toHaveLength(2);
    expect(text.endsWith('  ]\n}\n')).toBe(true);
  });

  it('uses null for a screen the catalogue gives no requirement', () => {
    expect(buildRoutes(small([route('A-02', 'A')]), known)[0]?.req).toBeNull();
  });

  it('rejects a duplicate id, a duplicate path, an unknown parent and a screen missing from the catalogue', () => {
    expect(() => buildRoutes(small([route('A-01', 'A'), route('A-01', 'A')]), known)).toThrow('Duplicate route id A-01');
    expect(() => buildRoutes(small([route('A-01', 'A'), route('A-01', 'B')]), known)).toThrow('Duplicate route id');
    expect(() => buildRoutes(small([route('A-01', 'A', 'Z-99')]), known)).toThrow('unknown parent Z-99');
    expect(() => buildRoutes(small([route('C-01', 'C')]), known)).toThrow('not in the screen catalogue');
  });

  it('rejects two different ids that give one path', () => {
    const clash = small([route('A-01', 'A'), { ...route('a-01', 'A') }]);
    expect(() => buildRoutes(clash, [...known, { id: 'a-01' }])).toThrow('Duplicate route path /a/a-01');
  });

  it('builds the path in lower case', () => {
    expect(pathOf('HOME', 'HOME-01')).toBe('/home/home-01');
  });
});
