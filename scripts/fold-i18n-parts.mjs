import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Folds the strings of work in progress (apps/web/src/i18n/parts/<name>.vi.json and .en.json) into the catalogues.
 * A key already in the catalogue keeps its text. The catalogues keep their layout (two-space JSON, one key a line).
 */
const DIR = join('apps', 'web', 'src', 'i18n');
const PARTS = join(DIR, 'parts');

export function fold(catalogue, parts) {
  const added = [];
  const merged = { ...catalogue };
  for (const part of parts) {
    for (const [key, text] of Object.entries(part)) {
      if (key in merged) continue;
      merged[key] = text;
      added.push(key);
    }
  }
  return { merged, added };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const locale of ['vi', 'en']) {
    const files = existsSync(PARTS) ? readdirSync(PARTS).filter((name) => name.endsWith(`.${locale}.json`) && !name.startsWith('_')) : [];
    const target = join(DIR, `${locale}.json`);
    const raw = readFileSync(target, 'utf8');
    const crlf = raw.includes('\r\n');
    const { merged, added } = fold(JSON.parse(raw), files.map((name) => JSON.parse(readFileSync(join(PARTS, name), 'utf8'))));
    const text = `${JSON.stringify(merged, null, 2)}\n`;
    writeFileSync(target, crlf ? text.replace(/\n/g, '\r\n') : text);
    for (const name of files) rmSync(join(PARTS, name), { force: true });
    console.log(`${locale}: ${added.length} keys folded from ${files.length} parts`);
  }
}
