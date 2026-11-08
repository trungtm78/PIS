import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CLIPS_DIR = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(CLIPS_DIR, '..', '..');

/** Reads a JSON file; a relative path is relative to scripts/clips. */
export function readJson(path) {
  const full = isAbsolute(path) ? path : join(CLIPS_DIR, path);
  try {
    return JSON.parse(readFileSync(full, 'utf8'));
  } catch (error) {
    throw new Error(`cannot read JSON ${full}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export const loadSpec = () => readJson('clip-spec.json');
export const loadNumerals = () => readJson('numerals.json');
export const loadVoices = () => readJson('voices.json');
export const loadPhonetics = () => readJson('phonetics.json');

export function sha256(...parts) {
  const hash = createHash('sha256');
  for (const part of parts) hash.update(String(part)).update('\n');
  return hash.digest('hex');
}

/** Runs `work` on every item with at most `limit` in flight; the answers keep the order of the items. */
export async function mapLimit(items, limit, work) {
  const answers = new Array(items.length);
  let next = 0;
  const lane = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      answers[index] = await work(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, lane));
  return answers;
}

/** Seconds as `m:ss`. */
export function clock(sec) {
  const total = Math.max(0, Math.round(sec));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** The value after `--name` on a command line, or `fallback`. */
export function argument(argv, name, fallback) {
  const index = argv.indexOf(`--${name}`);
  return index === -1 || index + 1 >= argv.length ? fallback : argv[index + 1];
}

export const flag = (argv, name) => argv.includes(`--${name}`);

/** The arguments that are not flags and not the value of a flag in `valued`. */
export function positionals(argv, valued = []) {
  const out = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index].startsWith('--')) {
      if (valued.includes(argv[index].slice(2))) index += 1;
    } else out.push(argv[index]);
  }
  return out;
}
