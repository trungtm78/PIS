import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * The words of the demo report forms are Vietnamese by nature (column headers, notes, the Word narrative skeletons, the indicator texts, the invented sample data). They are kept in JSON files in
 * `src/report-forms/messages/<topic>.vi.json`, keyed in English, so that no source file holds them and the bytes of every template and golden file stay what the readers are used to.
 * The package runs as CommonJS under the test runner and as an ES module under Node itself and the loader of the API, where neither `__dirname` nor `import.meta` is common to both: the folder is found
 * from the working directory (or the started script) and its parents, the way the kernel finds its own messages. Only server code loads these files; the manifest, which the web bundle also reads,
 * keeps its words in `src/messages/manifest-texts.ts`.
 */
const FOLDERS: readonly (readonly string[])[] = [
  ['packages', 'edition-enterprise', 'src', 'report-forms', 'messages'],
  ['src', 'report-forms', 'messages'],
  ['packages', 'edition-enterprise', 'src', 'integration', 'messages'],
  ['src', 'integration', 'messages'],
  ['packages', 'edition-enterprise', 'src', 'org-pack', 'messages'],
  ['src', 'org-pack', 'messages'],
];

const CACHE = new Map<string, unknown>();

/** The path of `messages/<topic>.vi.json`, found from the working directory and the started script and their parents by the presence of the file. */
export function textsFile(topic: string, starts: readonly string[] = [process.cwd(), process.argv[1] === undefined ? process.cwd() : dirname(process.argv[1])]): string {
  const name = `${topic}.vi.json`;
  for (const start of starts) {
    for (let directory = start; ; directory = dirname(directory)) {
      const found = FOLDERS.map((parts) => join(directory, ...parts, name)).find((path) => existsSync(path));
      if (found !== undefined) return found;
      if (dirname(directory) === directory) break;
    }
  }
  throw new Error(`demo forms: the text file ${name} was not found from ${starts.join(', ')}`);
}

/** The content of `messages/<topic>.vi.json`, read once. The caller names the shape it expects (the files are held to it by the tests that compare the outputs byte for byte). */
export function textsOf<T>(topic: string): T {
  const cached = CACHE.get(topic);
  if (cached !== undefined) return cached as T;
  const loaded: unknown = JSON.parse(readFileSync(textsFile(topic), 'utf8'));
  CACHE.set(topic, loaded);
  return loaded as T;
}

/** A text with its `{name}` places filled in from `values`; a place without a value is a mistake of the code and fails loudly. */
export function fillText(template: string, values: Readonly<Record<string, string | number>>): string {
  return template.replace(/\{([A-Za-z0-9_]+)\}/g, (_place, name: string) => {
    const value = values[name];
    if (value === undefined) throw new Error(`demo forms: the text "${template}" needs ${name}`);
    return String(value);
  });
}
