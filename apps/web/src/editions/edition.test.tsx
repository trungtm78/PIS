import { ALLOW_ALL, EditionError, PUBLIC_EDITION_MANIFEST, defineEditionManifest } from '@machvon/kernel/src/edition.ts';
import type { EditionManifest } from '@machvon/kernel/src/edition.ts';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import en from '../i18n/en.json';
import { translator } from '../i18n/index';
import viCatalogue from '../i18n/vi.json';
import { ARCHITECTURE } from '../navigation/architecture';
import { ALL_MODULES_VISIBLE, buildNavigation } from '../navigation/model';
import { routeById, routeByPath } from '../routes/registry';
import { WEB_ROUTES } from '../routes/web-routes';
import { mockMatchMedia, renderApp } from '../test/render';
import { applyBrand, faviconHref } from './brand';
import { PUBLIC_BUNDLE, editionAccess, editionRoutes, getEdition, installEdition, resetEdition, routeInEdition, subscribeEdition } from './edition';
import type { WebEditionBundle } from './edition';
import { EditionProvider, useEdition } from './EditionContext';
import { loadWebEdition } from './load';

const manifestOf = (patch: Partial<EditionManifest> = {}): EditionManifest =>
  defineEditionManifest({
    edition: 'enterprise',
    productName: { vi: 'Sản phẩm thử', en: 'Test product' },
    brand: { mark: { vi: 'TH', en: 'TP' }, themeColor: '#0F3B57' },
    modules: ALLOW_ALL,
    screens: ALLOW_ALL,
    menu: ALLOW_ALL,
    terminology: { web: ['shell.brand.name.text', 'shell.app.name.title', 'shell.brand.mark.text'], mobile: [] },
    rulePacks: ['enterprise-investment'],
    ...patch,
  });

const OVERLAY = {
  vi: { 'shell.brand.name.text': 'Sản phẩm thử', 'shell.app.name.title': 'Sản phẩm thử', 'shell.brand.mark.text': 'TH' },
  en: { 'shell.brand.name.text': 'Test product', 'shell.app.name.title': 'Test product', 'shell.brand.mark.text': 'TP' },
};

const bundleOf = (patch: Partial<EditionManifest> = {}, overlay: WebEditionBundle['overlay'] = OVERLAY): WebEditionBundle => ({ manifest: manifestOf(patch), overlay });

afterEach(() => {
  cleanup();
  act(() => {
    resetEdition();
    translator.setLocale('vi');
  });
  window.history.pushState({}, '', '/');
  document.head.querySelectorAll('meta[name="theme-color"]').forEach((node) => node.remove());
});

describe('the public edition as the default', () => {
  it('is installed from the start, with every route, every module and no overlay', () => {
    expect(getEdition()).toBe(PUBLIC_BUNDLE);
    expect(getEdition().manifest).toBe(PUBLIC_EDITION_MANIFEST);
    expect(getEdition().overlay).toBeUndefined();
    expect(editionRoutes(WEB_ROUTES)).toBe(WEB_ROUTES);
    expect(editionAccess(ALL_MODULES_VISIBLE)).toBe(ALL_MODULES_VISIBLE);
    expect(WEB_ROUTES.every((route) => routeInEdition(route))).toBe(true);
    expect(translator.t('shell.brand.name.text')).toBe(viCatalogue['shell.brand.name.text']);
  });

  it('builds the same navigation as before', () => {
    const before = buildNavigation(ARCHITECTURE, WEB_ROUTES, ALL_MODULES_VISIBLE);
    const now = buildNavigation(ARCHITECTURE, editionRoutes(WEB_ROUTES), editionAccess(ALL_MODULES_VISIBLE));
    expect(now.quick).toEqual(before.quick);
    expect(now.library).toEqual(before.library);
    expect(now.personal).toEqual(before.personal);
  });
});

describe('route and menu filtering by manifest', () => {
  const narrowed = manifestOf({ modules: { allow: '*', deny: ['CAP'] }, screens: { allow: '*', deny: ['PRJ-02'] }, menu: { allow: '*', deny: ['PAY'] } });

  it('drops the routes of a denied module and of a denied screen, and keeps the order of the rest', () => {
    const routes = editionRoutes(WEB_ROUTES, narrowed);
    expect(routes.some((route) => route.module === 'CAP')).toBe(false);
    expect(routes.some((route) => route.id === 'PRJ-02')).toBe(false);
    expect(routes.some((route) => route.id === 'PRJ-01')).toBe(true);
    expect(routes.length).toBe(WEB_ROUTES.filter((route) => route.module !== 'CAP' && route.id !== 'PRJ-02').length);
    expect(routes).toEqual(WEB_ROUTES.filter((route) => routes.includes(route)));
  });

  it('keeps only the listed modules when the manifest lists them', () => {
    const only = editionRoutes(WEB_ROUTES, manifestOf({ modules: { allow: ['HOME', 'ADM'], deny: [] } }));
    expect([...new Set(only.map((route) => route.module))].sort()).toEqual(['ADM', 'HOME']);
  });

  it('hides a module from the menu without removing its routes, and a denied module from the menu as well', () => {
    const model = buildNavigation(ARCHITECTURE, editionRoutes(WEB_ROUTES, narrowed), editionAccess(ALL_MODULES_VISIBLE, narrowed));
    const quick = model.quick.map((link) => link.module);
    expect(quick).not.toContain('CAP');
    expect(quick).not.toContain('PAY');
    expect(quick).toContain('PRJ');
    expect(model.library.flatMap((area) => area.modules.map((module) => module.code))).not.toContain('PAY');
    expect(model.isModuleVisible('PAY')).toBe(false);
    expect(routeInEdition({ id: 'PAY-01', module: 'PAY' }, narrowed)).toBe(true);
  });

  it('still asks the session: a module the session may not open stays hidden', () => {
    const access = editionAccess({ isModuleVisible: (module) => module !== 'ADM' }, narrowed);
    expect(access.isModuleVisible('ADM')).toBe(false);
    expect(access.isModuleVisible('PRJ')).toBe(true);
    expect(access.isModuleVisible('PAY')).toBe(false);
  });

  it('makes the registry lookups follow the installed edition', () => {
    expect(routeById('CAP-01')?.module).toBe('CAP');
    act(() => installEdition({ manifest: narrowed }));
    expect(routeById('CAP-01')).toBeUndefined();
    expect(routeByPath('/cap/cap-01')).toBeUndefined();
    expect(routeById('PRJ-01')).toBeDefined();
    act(() => resetEdition());
    expect(routeByPath('/cap/cap-01')?.id).toBe('CAP-01');
  });
});

describe('the terminology overlay', () => {
  it('replaces the words of the catalogue in both languages and leaves every other key alone', () => {
    act(() => installEdition(bundleOf()));
    expect(translator.t('shell.brand.name.text')).toBe('Sản phẩm thử');
    expect(translator.t('shell.nav.main.label')).toBe(viCatalogue['shell.nav.main.label']);
    act(() => translator.setLocale('en'));
    expect(translator.t('shell.brand.name.text')).toBe('Test product');
    expect(translator.t('shell.nav.main.label')).toBe(en['shell.nav.main.label']);
  });

  it('reads the overlay of the language first, then the catalogue of the language: a Vietnamese overlay does not speak for English', () => {
    act(() => installEdition(bundleOf({}, { vi: { 'shell.brand.name.text': 'Chỉ tiếng Việt' }, en: {} })));
    expect(translator.t('shell.brand.name.text')).toBe('Chỉ tiếng Việt');
    act(() => translator.setLocale('en'));
    expect(translator.t('shell.brand.name.text')).toBe(en['shell.brand.name.text']);
  });

  it('is removed when the public edition is installed again, and tells the listeners', () => {
    const seen = vi.fn();
    const stop = subscribeEdition(seen);
    act(() => installEdition(bundleOf()));
    act(() => resetEdition());
    stop();
    expect(seen).toHaveBeenCalledTimes(2);
    expect(translator.t('shell.brand.name.text')).toBe(viCatalogue['shell.brand.name.text']);
  });

  it('never adds a key: an unknown key still reads as unknown', () => {
    act(() => installEdition(bundleOf({}, { vi: { 'no.such.key.here': 'x' }, en: {} })));
    expect(translator.has('shell.brand.name.text')).toBe(true);
    expect(translator.t('no.such.key.here')).toBe('x');
    expect(translator.has('no.such.key.here')).toBe(false);
  });
});

describe('the brand', () => {
  it('draws the favicon like index.html does, with the mark and the colour of the edition', () => {
    const href = decodeURIComponent(faviconHref('XD', '#0F3B57'));
    expect(href).toContain("fill='#0F3B57'");
    expect(href).toContain('>XD</text>');
    expect(href.startsWith('data:image/svg+xml,')).toBe(true);
  });

  it('touches nothing in the head for the public edition', () => {
    const before = document.head.innerHTML;
    applyBrand(document, PUBLIC_EDITION_MANIFEST, 'vi');
    expect(document.head.innerHTML).toBe(before);
  });

  it('sets the colour of the browser chrome and the icon for another edition, in the language asked, creating or reusing the elements', () => {
    const manifest = manifestOf();
    applyBrand(document, manifest, 'vi');
    expect(document.head.querySelector('meta[name="theme-color"]')?.getAttribute('content')).toBe('#0F3B57');
    expect(decodeURIComponent(document.head.querySelector('link[rel="icon"]')?.getAttribute('href') ?? '')).toContain('>TH</text>');
    applyBrand(document, manifest, 'en');
    expect(document.head.querySelectorAll('meta[name="theme-color"]')).toHaveLength(1);
    expect(document.head.querySelectorAll('link[rel="icon"]')).toHaveLength(1);
    expect(decodeURIComponent(document.head.querySelector('link[rel="icon"]')?.getAttribute('href') ?? '')).toContain('>TP</text>');
    document.head.querySelector('link[rel="icon"]')?.remove();
  });
});

describe('the edition context', () => {
  function Probe() {
    return <span>{useEdition().manifest.edition}</span>;
  }

  it('reads the installed edition, follows a new installation and lets a provider override it', () => {
    const { rerender } = render(<Probe />);
    expect(screen.getByText('public')).toBeInTheDocument();
    act(() => installEdition(bundleOf()));
    expect(screen.getByText('enterprise')).toBeInTheDocument();
    act(() => resetEdition());
    rerender(
      <EditionProvider edition={bundleOf()}>
        <Probe />
      </EditionProvider>,
    );
    expect(screen.getByText('enterprise')).toBeInTheDocument();
  });
});

describe('loadWebEdition', () => {
  it('gives the public bundle without a loader', async () => {
    await expect(loadWebEdition('public', null)).resolves.toBe(PUBLIC_BUNDLE);
  });

  it('fails, naming the edition, when this build does not carry the enterprise bundle', async () => {
    await expect(loadWebEdition('enterprise', null)).rejects.toBeInstanceOf(EditionError);
  });

  it('gives what the loader hands over, and refuses a bundle that is not an enterprise one', async () => {
    const bundle = bundleOf();
    await expect(loadWebEdition('enterprise', () => Promise.resolve({ enterpriseBundle: bundle }))).resolves.toBe(bundle);
    await expect(loadWebEdition('enterprise', () => Promise.resolve({ enterpriseBundle: PUBLIC_BUNDLE }))).rejects.toBeInstanceOf(EditionError);
  });

  it('follows VITE_EDITION at build time: a public build carries no enterprise loader, an enterprise build carries the real bundle', async () => {
    if (import.meta.env.VITE_EDITION === 'enterprise') {
      const bundle = await loadWebEdition('enterprise');
      expect(bundle.manifest.edition).toBe('enterprise');
      expect(bundle.overlay?.vi['shell.brand.name.text']).toBe('Phần mềm quản lý đầu tư xây dựng');
    } else {
      await expect(loadWebEdition('enterprise')).rejects.toBeInstanceOf(EditionError);
    }
  });
});

describe('the application under another edition', () => {
  beforeEach(() => mockMatchMedia(() => false));

  it('says the product name of the edition in the shell and the tab, and drops what the manifest drops', async () => {
    act(() => installEdition(bundleOf({ modules: { allow: '*', deny: ['CAP'] }, menu: { allow: '*', deny: ['PAY'] } })));
    renderApp('/home/home-01');
    const sidebar = screen.getByRole('navigation', { name: viCatalogue['shell.nav.main.label'] });
    expect(screen.getByText('Sản phẩm thử')).toBeInTheDocument();
    expect(screen.getByText('TH')).toBeInTheDocument();
    expect(screen.queryByText(viCatalogue['shell.brand.name.text'])).toBeNull();
    expect(within(sidebar).queryByRole('link', { name: 'Kế hoạch vốn' })).toBeNull();
    expect(within(sidebar).queryByRole('link', { name: 'Thanh toán' })).toBeNull();
    expect(within(sidebar).getByRole('link', { name: 'Dự án' })).toBeInTheDocument();
  });

  it('answers a screen of a denied module with the not-found state, inside the shell', async () => {
    act(() => installEdition(bundleOf({ modules: { allow: '*', deny: ['CAP'] } })));
    renderApp('/cap/cap-01');
    expect(await screen.findByRole('heading', { level: 1, name: viCatalogue['shell.notFound.title'] })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: viCatalogue['shell.nav.main.label'] })).toBeInTheDocument();
  });

  it('keeps a screen of a module that is only out of the menu reachable by its address', async () => {
    act(() => installEdition(bundleOf({ menu: { allow: '*', deny: ['ADM'] } })));
    renderApp('/adm/adm-01');
    expect(screen.queryByRole('heading', { level: 1, name: viCatalogue['shell.notFound.title'] })).toBeNull();
    expect(await screen.findByRole('heading', { level: 1, name: 'Cây tổ chức' })).toBeInTheDocument();
  });
});
