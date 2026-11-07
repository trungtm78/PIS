import { buildTokens, generateTokens, kebabCase } from '../src/generate.ts';
import { contrastRatio } from '../src/contrast.ts';
import { CONTRAST_PAIRS, MIN_TEXT_CONTRAST, THEME_COLOR_KEYS } from '../src/theme-rules.ts';
import { realDesignTokens } from './support.ts';

describe('generateTokens', () => {
  const json = realDesignTokens();
  const { css, ts } = generateTokens(json);

  it('is deterministic: two runs give identical text', () => {
    expect(generateTokens(json)).toEqual({ css, ts });
  });

  it('writes the generated TypeScript in plain ASCII, so design text with accents never lands in a source file', () => {
    expect(ts).toMatch(/^[\n -~]*$/);
    const literal = ts.slice(ts.indexOf('= {') + 2, ts.lastIndexOf('};') + 1);
    expect((JSON.parse(literal) as { displayName: string }).displayName).toBe(json.displayName);
  });

  it('emits every colour as a custom property', () => {
    for (const [name, value] of Object.entries(json.color)) {
      expect(css).toContain(`--mv-color-${kebabCase(name)}: ${value};`);
    }
    expect(css).toContain('--mv-color-text-secondary: #5B6E77;');
    expect(css).toContain('--mv-color-primary-hover: #00635E;');
  });

  it('emits every space step, radius, font size and navigation metric', () => {
    for (const step of json.space) expect(css).toContain(`--mv-space-${step}: ${step}px;`);
    for (const [name, value] of Object.entries(json.radius)) expect(css).toContain(`--mv-radius-${kebabCase(name)}: ${value}px;`);
    expect(css).toContain('--mv-font-family: Be Vietnam Pro, Segoe UI, Arial, sans-serif;');
    expect(css).toContain('--mv-font-body: 14px;');
    expect(css).toContain('--mv-font-title: 28px;');
    expect(css).toContain('--mv-nav-sidebar-width: 252px;');
    expect(css).toContain('--mv-nav-compact-sidebar-width: 236px;');
    expect(css).toContain('--mv-nav-mobile-drawer-breakpoint: 980px;');
  });

  it('emits the twelve tenant theme colours from the base theme', () => {
    for (const key of THEME_COLOR_KEYS) expect(css).toMatch(new RegExp(`--mv-theme-${kebabCase(key)}: #[0-9A-F]{6};`));
    expect(css).toContain('--mv-theme-primary: #007D77;');
  });

  it('writes the TypeScript module with the typed token object and a generated-file header', () => {
    expect(ts).toContain('Do not edit');
    expect(ts).toContain("import type { Tokens } from './types.ts';");
    expect(ts).toContain('export const TOKENS: Tokens =');
    expect(ts).toContain('"primary": "#007D77"');
    expect(ts.endsWith('\n')).toBe(true);
    expect(css.endsWith('\n')).toBe(true);
  });

  it('changes both outputs when one colour token changes (AC-ST-KERNEL-031-1)', () => {
    const changed = generateTokens({ ...json, color: { ...json.color, primary: '#123456' } });
    expect(changed.css).toContain('--mv-color-primary: #123456;');
    expect(changed.ts).toContain('"primary": "#123456"');
    expect(changed.css).not.toBe(css);
    expect(changed.ts).not.toBe(ts);
  });
});

describe('buildTokens', () => {
  const tokens = buildTokens(realDesignTokens());

  it('derives the base tenant theme from the design tokens', () => {
    expect(tokens.tenantTheme.primary).toBe('#007D77');
    expect(tokens.tenantTheme.menu).toBe('#102E3B');
    expect(tokens.tenantTheme.selectedText).toBe('#FFFFFF');
    expect(tokens.tenantTheme.background).toBe('#F3F6F5');
    expect(Object.keys(tokens.tenantTheme).sort()).toEqual([...THEME_COLOR_KEYS].sort());
  });

  it('gives a base theme that passes every contrast rule it declares', () => {
    for (const pair of CONTRAST_PAIRS) {
      expect(contrastRatio(tokens.tenantTheme[pair.foreground], tokens.tenantTheme[pair.background])).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
    }
  });

  it('keeps the source tokens untouched', () => {
    expect(tokens.color.primary).toBe('#007D77');
    expect(tokens.space).toEqual([4, 8, 12, 16, 20, 24, 32, 48]);
  });

  it('refuses a design token file that lacks a colour the theme needs', () => {
    const json = realDesignTokens();
    const colors = { ...json.color };
    delete colors.sidebar;
    expect(() => buildTokens({ ...json, color: colors })).toThrow(/sidebar/);
  });
});

describe('kebabCase', () => {
  it.each([
    ['primary', 'primary'],
    ['textSecondary', 'text-secondary'],
    ['primaryHover', 'primary-hover'],
    ['headerBg', 'header-bg'],
    ['ios_pt', 'ios-pt'],
  ])('%s becomes %s', (input, expected) => {
    expect(kebabCase(input)).toBe(expected);
  });
});
