import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string): string => readFileSync(resolve(__dirname, path), 'utf8');
const BRAND = read('../../../../Design/MACHVON_Design/02_Prototype/brand-theme.css');
const APP = read('./app.css');
const TENANT = read('./tenant-theme.css');
const TOKENS = read('../../../../packages/design-tokens/dist-css/tokens.css');
const FONTS = resolve(__dirname, '../../public/fonts');

const withoutComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, '');
const BRAND_CODE = withoutComments(BRAND);

describe('brand-theme.css ("Xanh dầu điều hành")', () => {
  it('names a colour only through the tokens: a hex literal appears only as the fallback inside var()', () => {
    const hexes = [...BRAND_CODE.matchAll(/#[0-9a-fA-F]{3,8}\b/g)];
    expect(hexes.length).toBeGreaterThan(20);
    const loose = hexes.filter((match) => !/,\s*$/.test(BRAND_CODE.slice(0, match.index)) || BRAND_CODE[(match.index ?? 0) + match[0].length] !== ')');
    expect(loose.map((match) => match[0])).toEqual([]);
  });

  it('reads only tokens the token file defines', () => {
    const defined = new Set([...TOKENS.matchAll(/(--mv-[a-z0-9-]+):/g)].map((match) => match[1]));
    const derived = new Set([...TENANT.matchAll(/(--mv-derived-[a-z-]+):/g)].map((match) => match[1]));
    const used = new Set([...BRAND_CODE.matchAll(/var\((--mv-[a-z0-9-]+)/g)].map((match) => match[1]));
    expect(used.size).toBeGreaterThan(15);
    const unknown = [...used].filter((name) => !defined.has(name) && !derived.has(name));
    expect(unknown).toEqual([]);
  });

  it('puts the base tokens under the shell: sidebar, workspace card, selected bar, table head, primary', () => {
    for (const token of ['--mv-color-sidebar', '--mv-color-workspace-card', '--mv-color-selected', '--mv-color-selected-bar', '--mv-color-table-head', '--mv-color-primary', '--mv-color-primary-hover']) {
      expect(BRAND_CODE).toContain(`var(${token}`);
    }
    expect(BRAND_CODE).toMatch(/box-shadow: inset 3px 0 var\(--sel-bar/);
    expect(BRAND_CODE).toContain("[aria-current='page']");
  });

  it('defines the classes and variables the screens use but no stylesheet defined', () => {
    for (const selector of ['.sr-only', '.visually-hidden', '.btn', 'a.button', '.field-error', '.pill.success', '.pill.info', '.pill.neutral', '.pill.danger', '.callout.danger']) {
      expect(BRAND_CODE, selector).toContain(selector);
    }
    for (const variable of ['--shell-line', '--shell-warning', '--shell-success', '--shell-danger', '--shell-accent', '--shell-accent-ink', '--shell-border', '--border', '--danger', '--primary', '--selected', '--surface', '--ok', '--warn', '--warn-soft']) {
      expect(BRAND_CODE, variable).toMatch(new RegExp(`${variable}:`));
    }
  });

  it('draws the page title at 28px weight 700, rows by min-height and the 3-layer header without the module eyebrow', () => {
    expect(BRAND_CODE).toMatch(/\.workspace-app \.heading h1 \{[^}]*font-size: var\(--mv-font-title, 28px\);[^}]*font-weight: 700/);
    expect(BRAND_CODE).toMatch(/\.workspace-app \.heading \.eyebrow \{\s*display: none/);
    expect(BRAND_CODE).toMatch(/\.workspace-app td,\s*td \{[^}]*height: 44px/);
    const rowRules = BRAND_CODE.split('}').filter((rule) => /(^|[\s,])tr([\s:.,]|$)/.test(rule.slice(0, rule.indexOf('{'))));
    expect(rowRules.length).toBeGreaterThan(0);
    for (const rule of rowRules) expect(rule).not.toMatch(/(^|[\s;{])height:/);
    expect(BRAND_CODE).toMatch(/th\s*\{[^}]*position: sticky/);
  });

  it('shows focus with a 2px ring that is never animated, and a light ring inside the sidebar', () => {
    expect(BRAND_CODE).toMatch(/button:focus-visible,[\s\S]*?\{\s*outline: 2px solid var\(--focus,/);
    expect(BRAND_CODE).toMatch(/\.workspace-sidebar :focus-visible[\s\S]*?outline: 2px solid var\(--focus-on-dark/);
    expect(BRAND_CODE).not.toMatch(/focus[^{]*\{[^}]*transition: [^n]/);
  });

  it('turns the sidebar into a drawer below 980px with 44px controls and keeps the page from scrolling sideways', () => {
    expect(BRAND_CODE).toMatch(/@media \(max-width: 980px\)[\s\S]*?\.workspace-menu-toggle[\s\S]*?width: 44px/);
    expect(BRAND_CODE).toMatch(/\.tablewrap \{[^}]*overflow: auto/);
    expect(BRAND_CODE).toMatch(/\.appbody \{\s*min-width: 0/);
  });
});

describe('the bundled font', () => {
  const FILES = [...APP.matchAll(/url\('\/fonts\/([^']+)'\)/g)].map((match) => match[1] ?? '');

  it('declares Be Vietnam Pro for 400, 500, 600 and 700 with the Vietnamese subset first, from local files only', () => {
    expect(APP).not.toMatch(/https?:\/\//);
    for (const weight of [400, 500, 600, 700]) {
      expect(APP).toMatch(new RegExp(`font-weight: ${weight};`));
      expect(FILES).toContain(`be-vietnam-pro-vietnamese-${weight}.woff2`);
      expect(FILES).toContain(`be-vietnam-pro-latin-${weight}.woff2`);
    }
    expect(APP).toContain('U+1EA0-1EF9');
  });

  it('has every declared file in public/fonts, with the licence next to them', () => {
    expect(FILES.length).toBe(12);
    for (const file of FILES) expect(existsSync(resolve(FONTS, file)), file).toBe(true);
    expect(existsSync(resolve(FONTS, 'OFL.txt'))).toBe(true);
  });

  it('is the first family of the token font stack', () => {
    expect(TOKENS).toMatch(/--mv-font-family: Be Vietnam Pro, Segoe UI/);
  });
});

describe('tenant-theme.css derived tokens', () => {
  it('derives selectedBar, tableHead, focus, focusOnDark and primaryHover from colours the tenant set', () => {
    for (const [name, key] of [
      ['--mv-derived-selected-bar', 'selectedText'],
      ['--mv-derived-table-head', 'titleColor'],
      ['--mv-derived-focus', 'primary'],
      ['--mv-derived-focus-on-dark', 'menuText'],
      ['--mv-derived-primary-hover', 'primary'],
    ] as const) {
      const rule = TENANT.split('}').find((part) => part.includes(`[data-mv-theme-keys~="${key}"] {`) && part.includes(`${name}:`));
      expect(rule, name).toBeDefined();
    }
  });

  it('keeps the application stylesheet free of colour literals', () => {
    expect(withoutComments(APP).replace(/unicode-range:[^;]+;/g, '')).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(withoutComments(TENANT)).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });
});

describe('app.css over the prototype sheets', () => {
  const rules = withoutComments(APP).split('}').map((part) => part.trim());
  const declaring = (selector: string, property: string): string | undefined => {
    const rule = rules.find((part) => (part.split('{').at(-2) ?? '').split(',').map((name) => name.trim()).includes(selector) && part.includes(`${property}:`));
    return rule?.split(`${property}:`)[1]?.split(';')[0]?.trim();
  };

  it('lifts the fine print of the prototype to the 12px floor of design.md, also where the workspace sheet repeats the footer note', () => {
    for (const selector of ['.prototype-note', '.workspace-app .prototype-note', '.sub', '.tiny', 'small', '.pill', '.badge', '.eyebrow']) expect(declaring(selector, 'font-size'), selector).toBe('12px');
  });

  it('lets the one-column grids of a narrow page shrink to the page, so that a wide table scrolls in its own region', () => {
    expect(declaring('.two', 'grid-template-columns')).toBe('minmax(0, 1fr)');
    expect(declaring('.grid', 'grid-template-columns')).toBe('repeat(2, minmax(0, 1fr))');
  });
});
