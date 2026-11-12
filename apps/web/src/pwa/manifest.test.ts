import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TOKENS } from '@machvon/design-tokens';
import { PUBLIC_EDITION_MANIFEST, SHORT_NAME_LIMIT } from '@machvon/kernel/src/edition.ts';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import { resolveBrand } from './brand';
import { CANVAS, iconRgba, iconSvg, markReach } from './icon-art';
import { ICON_FILES, colorsFromTokens } from './icons-cli';
import { APP_ID, MANIFEST_ICONS, MANIFEST_PATH, START_URL, buildManifest, shortNameOf } from './manifest';
import { FALLBACK_SHORT_NAME, MANIFEST_DESCRIPTION, MANIFEST_SHORTCUTS } from './manifest-texts';

const WEB = join(__dirname, '..', '..');
const PUBLIC_DIR = join(WEB, 'public');
const COLORS = { themeColor: TOKENS.color.sidebar as string, backgroundColor: TOKENS.color.background as string };
const manifest = buildManifest({ name: 'Hệ thống quản lý đầu tư công', shortName: PUBLIC_EDITION_MANIFEST.brand.shortName.vi, description: MANIFEST_DESCRIPTION, shortcuts: MANIFEST_SHORTCUTS, colors: COLORS });

describe('the web app manifest: installability (YCK.01)', () => {
  it('meets the criteria of the browsers: a name, a start URL inside the scope, standalone display and icons of 192 and 512 px', () => {
    expect(manifest.name.length).toBeGreaterThan(0);
    expect(manifest.short_name.length).toBeLessThanOrEqual(12);
    expect(manifest.display).toBe('standalone');
    expect(manifest.scope).toBe('/');
    expect(manifest.start_url.startsWith('/m')).toBe(true);
    expect(manifest.start_url).toBe(START_URL);
    expect(manifest.id).toBe(APP_ID);
    const sizes = manifest.icons.filter((icon) => icon.type === 'image/png' && icon.purpose === 'any').map((icon) => icon.sizes);
    expect(sizes).toEqual(expect.arrayContaining(['192x192', '512x512']));
    expect(manifest.icons.some((icon) => icon.purpose === 'maskable' && icon.sizes === '512x512')).toBe(true);
    expect(manifest.lang).toBe('vi');
  });

  it('takes its colours from the tokens of the design, and its name from what it is given', () => {
    expect(manifest.theme_color).toBe(TOKENS.color.sidebar);
    expect(manifest.background_color).toBe(TOKENS.color.background);
    expect(manifest.name).toBe('Hệ thống quản lý đầu tư công');
  });

  it('opens each of the three manager screens from a shortcut', () => {
    expect(manifest.shortcuts.map((shortcut) => shortcut.url)).toEqual(['/m/approvals', '/m/dashboard', '/m/directives']);
  });

  it('cuts a long short name to a word boundary under the limit', () => {
    expect(shortNameOf('Đầu tư công')).toBe('Đầu tư công');
    expect(shortNameOf('Phần mềm quản lý đầu tư xây dựng')).toBe('Phần mềm');
    expect(shortNameOf('Supercalifragilistic')).toBe('Supercalifra');
    expect(PUBLIC_EDITION_MANIFEST.brand.shortName.vi.length).toBeLessThanOrEqual(SHORT_NAME_LIMIT);
    expect(FALLBACK_SHORT_NAME.length).toBeLessThanOrEqual(SHORT_NAME_LIMIT);
  });

  it('is linked from the page with the colour of the sidebar and the icon of the home screen', () => {
    const html = readFileSync(join(WEB, 'index.html'), 'utf8');
    expect(html).toContain(`<link rel="manifest" href="${MANIFEST_PATH}" />`);
    expect(html).toContain(`<meta name="theme-color" content="${TOKENS.color.sidebar}" />`);
    expect(html).toContain('/icons/apple-touch-icon-180.png');
    expect(existsSync(join(PUBLIC_DIR, 'icons', 'apple-touch-icon-180.png'))).toBe(true);
    expect(html).toContain('name="viewport" content="width=device-width, initial-scale=1.0"');
  });
});

describe('the icons', () => {
  it('exist for every file the manifest names, at the size it says', () => {
    for (const icon of MANIFEST_ICONS) {
      const path = join(PUBLIC_DIR, icon.src);
      expect(existsSync(path), icon.src).toBe(true);
      if (icon.type === 'image/png') {
        const image = PNG.sync.read(readFileSync(path));
        const [width] = icon.sizes.split('x').map(Number);
        expect(image.width).toBe(width);
        expect(image.height).toBe(width);
      }
    }
  });

  it('are four PNG files and two SVG files', () => {
    expect(ICON_FILES.map((file) => file.size)).toEqual([192, 512, 512, 180]);
  });

  it('are drawn in the colours of the tokens, rounded when alone and edge to edge when maskable', () => {
    const colors = colorsFromTokens(readFileSync(join(WEB, '..', '..', 'Design', 'MACHVON_Design', '04_Design_Assets', 'design_tokens.json'), 'utf8'));
    expect(colors.background).toBe(TOKENS.color.sidebar);
    const pixel = (size: number, x: number, y: number, maskable: boolean): number[] => Array.from(iconRgba(colors, size, { maskable }).slice((y * size + x) * 4, (y * size + x) * 4 + 4));
    expect(pixel(64, 20, 20, false)).toEqual([0x10, 0x2e, 0x3b, 255]);
    // The corner of the plain icon is transparent; the maskable one covers it, because the platform cuts the shape.
    expect(pixel(64, 0, 0, false)[3]).toBe(0);
    expect(pixel(64, 0, 0, true)).toEqual([0x10, 0x2e, 0x3b, 255]);
    expect(iconSvg(colors)).toContain(`fill="${TOKENS.color.sidebar}"`);
    expect(iconSvg(colors, { maskable: true })).toContain('rx="0"');
  });

  it('keep the mark inside the safe circle of a maskable icon (80% of the canvas)', () => {
    expect(markReach()).toBeLessThanOrEqual((CANVAS * 0.8) / 2);
  });
});

describe('the name of the product in the manifest', () => {
  it('is the name of the edition, or the shell brand key when no edition manifest could be loaded', () => {
    const edition = { edition: 'enterprise', productName: { vi: 'Phần mềm quản lý đầu tư xây dựng' }, brand: { themeColor: '#0F3B57', shortName: { vi: 'Đầu tư XD' } } };
    expect(resolveBrand(edition, 'Hệ thống quản lý đầu tư công', 'Đầu tư')).toEqual({ name: 'Phần mềm quản lý đầu tư xây dựng', shortName: 'Đầu tư XD', themeColor: '#0F3B57', from: 'enterprise' });
    expect(resolveBrand(undefined, 'Hệ thống quản lý đầu tư công', 'Đầu tư')).toEqual({ name: 'Hệ thống quản lý đầu tư công', shortName: 'Đầu tư', themeColor: undefined, from: 'shell' });
    expect(resolveBrand({ ...edition, productName: { vi: '  ' } }, 'Shell', 'Đầu tư').from).toBe('shell');
    expect(resolveBrand({ ...edition, brand: { ...edition.brand, shortName: { vi: ' ' } } }, 'Shell', 'Đầu tư').shortName).toBe('Đầu tư');
  });
});
