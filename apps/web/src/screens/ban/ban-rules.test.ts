import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import en from '../../i18n/en.json';
import vi from '../../i18n/vi.json';
import { toChangeLines } from './model';

const here = __dirname;
const sources = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? sources(join(dir, entry.name)) : /\.(ts|tsx|css)$/.test(entry.name) ? [join(dir, entry.name)] : []));
const banKeys = (catalogue: Record<string, string>): string[] => Object.keys(catalogue).filter((key) => key.startsWith('ban.'));

// The words of a simulation marker, in both languages, as they would be written on a screen or in a file.
const SIMULATION = /m[oô] ph[oỏ]ng|simulat|giả lập|demo data|mock data|illustrative/i;

describe('the committee workspace is built on the real core and says nothing of a simulation', () => {
  it('holds no simulation word in any string of the committee, Vietnamese or English', () => {
    for (const catalogue of [vi, en] as Array<Record<string, string>>) {
      for (const key of banKeys(catalogue)) expect(`${key}: ${catalogue[key]}`).not.toMatch(SIMULATION);
    }
  });

  it('holds no simulation word in any source file of the screens or of the PWA card', () => {
    const files = [...sources(here), join(here, '..', '..', 'pwa', 'screens', 'CommitteeCard.tsx')].filter((file) => !file.endsWith('ban-rules.test.ts'));
    expect(files.length).toBeGreaterThan(10);
    for (const file of files) expect({ file, found: SIMULATION.exec(readFileSync(file, 'utf8'))?.[0] }).toEqual({ file, found: undefined });
  });
});

describe('the strings of the committee', () => {
  it('has the same keys in Vietnamese and in English, each with text', () => {
    expect(banKeys(en as Record<string, string>).sort()).toEqual(banKeys(vi as Record<string, string>).sort());
    for (const catalogue of [vi, en] as Array<Record<string, string>>) for (const key of banKeys(catalogue)) expect((catalogue[key] ?? '').trim()).not.toBe('');
  });

  it('keeps the placeholders of a sentence the same in both languages', () => {
    const holes = (text: string): string[] => (text.match(/\{\w+\}/g) ?? []).sort();
    const english = en as Record<string, string>;
    const vietnamese = vi as Record<string, string>;
    for (const key of banKeys(vietnamese)) expect({ key, holes: holes(english[key] ?? '') }).toEqual({ key, holes: holes(vietnamese[key] ?? '') });
  });
});

describe('the layout at 390 px', () => {
  const css = readFileSync(join(here, 'ban.css'), 'utf8');

  it('has no width in pixels that a phone cannot hold, and lets every grid fall to one column', () => {
    expect(css).not.toMatch(/(?<!max-)(?<!min-)width:\s*\d{3,}px/);
    expect(css).not.toMatch(/min-width:\s*(\d{3,})px/);
    expect(css).toMatch(/@media \(max-width: 640px\)/);
    expect(css).toMatch(/grid-template-columns: minmax\(0, 1fr\)/);
    expect(css).toMatch(/overflow-wrap: anywhere/);
  });
});

describe('the lines of the week', () => {
  const line = (over: Record<string, unknown>) => ({ kind: 'RATE_CHANGE', direction: 'UP', params: { from: '1', to: '2', delta: '1' }, link: 'DRILL', metric_code: null, ...over }) as never;

  it('keeps the lines it can write and drops the ones it cannot, at most five', () => {
    const lines = toChangeLines([line({}), line({ kind: 'UNKNOWN_KIND' }), line({ params: { from: '1' } }), line({ link: 'ELSEWHERE' }), ...Array.from({ length: 8 }, () => line({}))]);
    expect(lines).toHaveLength(5);
    expect(lines.every((one) => one.kind === 'RATE_CHANGE' && one.contextToken === null)).toBe(true);
    expect(toChangeLines(undefined)).toEqual([]);
  });
});
