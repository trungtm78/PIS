import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Text that is Vietnamese by nature (names of categories, legal citations, descriptions of seeds) is kept in JSON files under `src/data`
 * (`<topic>.vi.json`), keyed in English, so that no source file holds it. The package runs as CommonJS under the compiler and as an ES module
 * under the loader of the API, where neither `__dirname` nor `import.meta` is common to both: the folder is found from the working directory
 * of the process or one of its parents (the repository root, `packages/db`, `apps/api`), the way the document renderer finds its resources.
 */
const FOLDER_CANDIDATES: readonly (readonly string[])[] = [
  ['packages', 'db', 'src', 'data'],
  ['src', 'data'],
];

const CACHE = new Map<string, unknown>();

/** The path of `src/data/<topic>.vi.json`, found from `cwd` and its parents by the presence of the file. */
export function dataFile(topic: string, cwd: string = process.cwd()): string {
  const name = `${topic}.vi.json`;
  for (let directory = cwd; ; directory = dirname(directory)) {
    const found = FOLDER_CANDIDATES.map((parts) => join(directory, ...parts, name)).find((path) => existsSync(path));
    if (found !== undefined) return found;
    if (dirname(directory) === directory) throw new Error(`data file ${name} not found from ${cwd}`);
  }
}

/** The content of `src/data/<topic>.vi.json`, read once. The caller names the shape it expects. */
export function vietnameseData<T>(topic: string): T {
  const cached = CACHE.get(topic);
  if (cached !== undefined) return cached as T;
  const loaded: unknown = JSON.parse(readFileSync(dataFile(topic), 'utf8'));
  CACHE.set(topic, loaded);
  return loaded as T;
}

/** A text with `{name}` places filled in from `values`; a place without a value stays as it is. */
export function fillText(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(/\{(\w+)\}/g, (place, name: string) => values[name] ?? place);
}
