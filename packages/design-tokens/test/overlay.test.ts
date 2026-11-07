import { buildTokens } from '../src/generate.ts';
import { contrastRatio } from '../src/contrast.ts';
import { validateTenantOverlay } from '../src/overlay.ts';
import type { Finding } from '../src/overlay.ts';
import { MIN_TEXT_CONTRAST } from '../src/theme-rules.ts';
import { realDesignTokens } from './support.ts';

const base = buildTokens(realDesignTokens());

function codes(result: ReturnType<typeof validateTenantOverlay>): Finding['code'][] {
  return result.ok ? [] : result.findings.map((finding) => finding.code);
}

/** A grey for primaryText on the white primary with the requested contrast (found by search, not by hand). */
function greyWithRatio(background: string, minimum: number, side: 'below' | 'above'): string {
  for (let level = 0; level <= 255; level += 1) {
    const hex = level.toString(16).padStart(2, '0').toUpperCase();
    const colour = `#${hex}${hex}${hex}`;
    const ratio = contrastRatio(colour, background);
    if (side === 'above' ? ratio >= minimum : ratio < minimum && ratio > minimum - 0.2) return colour;
  }
  throw new Error('no grey found');
}

describe('validateTenantOverlay: accepted overlays', () => {
  it('accepts an empty overlay and returns the base theme unchanged', () => {
    const result = validateTenantOverlay(base, {});
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.tokens.tenantTheme).toEqual(base.tenantTheme);
      expect(result.css).toContain('[data-mv-tenant-theme]');
      expect(result.css).toContain('--mv-theme-primary: #007D77;');
    }
  });

  it('accepts a navy theme, normalises the colours and leaves the base object untouched', () => {
    const before = JSON.stringify(base);
    const result = validateTenantOverlay(base, { primary: '#244c78', selected: '#eaf1f8', selectedText: '#244c78', menu: '#fff', menuText: '#244c78' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.tokens.tenantTheme.primary).toBe('#244C78');
      expect(result.tokens.tenantTheme.menu).toBe('#FFFFFF');
      expect(result.css).toContain('--mv-theme-primary: #244C78;');
      expect(result.css).toContain('--mv-theme-selected: #EAF1F8;');
    }
    expect(JSON.stringify(base)).toBe(before);
  });

  it('keeps an accepted logo asset id in the tokens but never in the CSS', () => {
    const assetId = '00000000-0000-4000-8000-0000000000a1';
    const result = validateTenantOverlay(base, { logoAssetId: assetId });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.tokens.logoAssetId).toBe(assetId);
      expect(result.css).not.toContain(assetId);
    }
  });
});

describe('validateTenantOverlay: contrast (AC-ST-KERNEL-031-2)', () => {
  it('rejects a primary button whose text has about 3.2:1 and names the pair and the ratio', () => {
    const grey = greyWithRatio('#FFFFFF', 3.2, 'below');
    // Text colour on the primary background: make the text a mid grey on a white primary.
    const result = validateTenantOverlay(base, { primary: '#FFFFFF', primaryText: grey });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const finding = result.findings.find((candidate) => candidate.code === 'CONTRAST');
      expect(finding?.token).toBe('primaryText');
      expect(finding?.against).toBe('primary');
      expect(finding?.ratio).toBeLessThan(MIN_TEXT_CONTRAST);
    }
  });

  it('rejects 4.49:1 and accepts exactly 4.5:1 or more', () => {
    // #767676 on white is 4.54:1 (accepted); #777777 is 4.48:1 (rejected).
    expect(validateTenantOverlay(base, { primary: '#FFFFFF', primaryText: '#767676' }).ok).toBe(true);
    const rejected = validateTenantOverlay(base, { primary: '#FFFFFF', primaryText: '#777777' });
    expect(rejected.ok).toBe(false);
    expect(codes(rejected)).toEqual(['CONTRAST']);
  });

  it('checks all six pairs and reports every failing one together', () => {
    const result = validateTenantOverlay(base, {
      primary: '#FFFFFF',
      primaryText: '#FFFFFF',
      menu: '#FFFFFF',
      menuText: '#FFFFFF',
      headerBg: '#000000',
      headerText: '#000000',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.findings.filter((finding) => finding.code === 'CONTRAST').map((finding) => finding.token)).toEqual([
        'primaryText',
        'menuText',
        'headerText',
      ]);
    }
  });

  it('judges a changed background against the unchanged text colour of the base theme', () => {
    // Base footer text is #5B6E77; a dark footer background breaks it even though only the background was sent.
    const result = validateTenantOverlay(base, { footerBg: '#222222' });
    expect(codes(result)).toEqual(['CONTRAST']);
  });
});

describe('validateTenantOverlay: values that must never reach CSS', () => {
  it.each([
    ['url(', 'url(https://evil.example/x.png)'],
    ['expression(', 'expression(alert(1))'],
    ['@import', '@import "https://evil.example/x.css"'],
    ['a closing style tag', '#FFFFFF</style><script>alert(1)</script>'],
    ['a script URL', 'javascript:alert(1)'],
    ['a declaration break', '#FFFFFF; background: url(x)'],
    ['a rule break', '#FFFFFF} body{display:none'],
    ['a backslash escape', '#FFF\\000000'],
  ])('rejects %s whole and applies nothing', (_label, value) => {
    const result = validateTenantOverlay(base, { primary: '#244c78', menuText: value });
    expect(result.ok).toBe(false);
    expect(codes(result)).toContain('FORBIDDEN_VALUE');
    expect('tokens' in result).toBe(false);
    expect('css' in result).toBe(false);
  });

  it.each(['red', 'rgb(0,0,0)', 'hsl(0,0%,0%)', '#12', '#12345', '#GGGGGG', '123456', '', ' #FFFFFF', '#FFFFFF '])('rejects the non-hex colour %p', (value) => {
    expect(codes(validateTenantOverlay(base, { primary: value }))).toContain('BAD_COLOR');
  });

  it.each([42, null, true, ['#FFFFFF'], { value: '#FFFFFF' }])('rejects the non-string colour %p', (value) => {
    expect(codes(validateTenantOverlay(base, { primary: value }))).toContain('BAD_COLOR');
  });

  it('never partially applies: one bad token rejects an overlay that also holds good ones', () => {
    const result = validateTenantOverlay(base, { primary: '#244c78', selected: 'blue' });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(base)).toContain('#007D77');
  });
});

describe('validateTenantOverlay: structure', () => {
  it('rejects an unknown token by name', () => {
    const result = validateTenantOverlay(base, { primary: '#244c78', shadow: '#000000' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.findings).toEqual([{ code: 'UNKNOWN_TOKEN', token: 'shadow' }]);
  });

  it.each([null, undefined, 'primary', 42, ['primary'], true])('rejects an overlay that is not a plain object: %p', (overlay) => {
    expect(codes(validateTenantOverlay(base, overlay))).toEqual(['UNKNOWN_TOKEN']);
  });

  it.each(['https://evil.example/logo.png', 'logo.svg', 'not-a-uuid', '', 42, '00000000-0000-4000-8000-0000000000a1 '])('rejects the logo reference %p', (value) => {
    expect(codes(validateTenantOverlay(base, { logoAssetId: value }))).toEqual(['LOGO']);
  });

  it('does not read inherited properties of the overlay', () => {
    const overlay = Object.create({ primary: 'url(x)' }) as Record<string, unknown>;
    expect(validateTenantOverlay(base, overlay).ok).toBe(true);
  });
});
