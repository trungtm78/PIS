import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { iconRgba, iconSvg } from './icon-art.ts';
import type { IconColors } from './icon-art.ts';

// Resolved when the command runs, so that importing the list of files (a test in a DOM) needs no file URL.
const webRoot = (): string => fileURLToPath(new URL('../..', import.meta.url));
const tokensJson = (): string => join(webRoot(), '..', '..', 'Design', 'MACHVON_Design', '04_Design_Assets', 'design_tokens.json');

/** The files of `public/icons`: name, size in pixels, maskable or not. */
export const ICON_FILES = [
  { name: 'icon-192.png', size: 192, maskable: false },
  { name: 'icon-512.png', size: 512, maskable: false },
  { name: 'icon-maskable-512.png', size: 512, maskable: true },
  { name: 'apple-touch-icon-180.png', size: 180, maskable: true },
] as const;

export function colorsFromTokens(tokensJson: string): IconColors {
  const { color } = JSON.parse(tokensJson) as { color: Record<string, string> };
  const pick = (key: string): string => {
    const value = color[key];
    if (value === undefined) throw new Error(`design_tokens.json has no color.${key}`);
    return value;
  };
  return { background: pick('sidebar'), barLow: pick('menuMuted'), barMid: pick('selectedBar'), barHigh: pick('menuText') };
}

function png(rgba: Uint8Array, size: number): Buffer {
  const image = new PNG({ width: size, height: size });
  image.data = Buffer.from(rgba);
  return PNG.sync.write(image);
}

/** Writes the icons under `public/icons` from the tokens of the design. `check` writes nothing and fails when a file differs from what the tokens give. */
export function main(argv: readonly string[]): number {
  const check = argv.includes('check');
  const colors = colorsFromTokens(readFileSync(tokensJson(), 'utf8'));
  const directory = join(webRoot(), 'public', 'icons');
  const files: Array<{ path: string; data: Buffer | string }> = [
    { path: join(directory, 'icon.svg'), data: iconSvg(colors) },
    { path: join(directory, 'icon-maskable.svg'), data: iconSvg(colors, { maskable: true }) },
    ...ICON_FILES.map((file) => ({ path: join(directory, file.name), data: png(iconRgba(colors, file.size, { maskable: file.maskable }), file.size) })),
  ];
  let stale = 0;
  for (const file of files) {
    if (check) {
      let current: Buffer | undefined;
      try {
        current = readFileSync(file.path);
      } catch {
        current = undefined;
      }
      if (current === undefined || !current.equals(Buffer.from(file.data))) {
        stale += 1;
        process.stdout.write(`stale: ${file.path}
`);
      }
    } else {
      mkdirSync(dirname(file.path), { recursive: true });
      writeFileSync(file.path, file.data);
      process.stdout.write(`wrote ${file.path}
`);
    }
  }
  return stale === 0 ? 0 : 1;
}
