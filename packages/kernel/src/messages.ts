import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, parse } from 'node:path';

/**
 * The words that a person reads in a file or on a screen made by the kernel (the titles of the columns of an export, the lines of a report that DOC prints): they are Vietnamese by nature and live in
 * `src/messages/vi.json`, one flat key (`area.thing.field`) to one text, so that the code stays in English and the text stays exactly what the readers of the files are used to.
 * A text may hold `{name}` places; `message` fills them in one pass (a value that holds braces is never filled in again).
 */
export type MessageParams = Readonly<Record<string, string | number>>;

const RESOURCE = join('src', 'messages', 'vi.json');
const PLACE = /\{([A-Za-z0-9_]+)\}/g;

/** The keys whose text a person reads on a screen (the work of HOME): a day in them is written as the reader writes it (`10/11/2026`), never as the `2026-11-10` of the books. The files of an export keep the ISO day. */
const SCREEN_PREFIX = 'home.source.';
const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const dayForReader = (value: string | number): string => {
  const match = typeof value === 'string' ? ISO_DAY.exec(value) : null;
  return match === null ? String(value) : `${match[3]}/${match[2]}/${match[1]}`;
};

let catalogue: Readonly<Record<string, string>> | undefined;

function locate(): string {
  // The package is run from its own directory, from the root of the repository or from an app of it: the resource is found by walking up from the working directory (and from the script that was started).
  const starts = [process.cwd(), process.argv[1] === undefined ? process.cwd() : dirname(process.argv[1])];
  for (const start of starts) {
    for (let directory = start; ; directory = dirname(directory)) {
      for (const candidate of [join(directory, RESOURCE), join(directory, 'packages', 'kernel', RESOURCE)]) {
        if (existsSync(candidate)) return candidate;
      }
      if (directory === parse(directory).root) break;
    }
  }
  throw new Error(`kernel messages: ${RESOURCE} not found from ${process.cwd()}`);
}

function load(): Readonly<Record<string, string>> {
  if (catalogue !== undefined) return catalogue;
  const parsed: unknown = JSON.parse(readFileSync(locate(), 'utf8'));
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('kernel messages: the resource must be an object');
  const entries = Object.entries(parsed as Record<string, unknown>);
  for (const [key, text] of entries) {
    if (typeof text !== 'string') throw new Error(`kernel messages: ${key} must be text`);
  }
  catalogue = Object.freeze(Object.fromEntries(entries) as Record<string, string>);
  return catalogue;
}

/** The text of a key, with its `{name}` places filled in; a key that is not in the resource, or a place without a value, is a mistake of the code and fails loudly. */
export function message(key: string, params?: MessageParams): string {
  const text = load()[key];
  if (text === undefined) throw new Error(`kernel messages: no text for ${key}`);
  const readable = key.startsWith(SCREEN_PREFIX);
  return text.replace(PLACE, (_place, name: string) => {
    const value = params?.[name];
    if (value === undefined) throw new Error(`kernel messages: ${key} needs ${name}`);
    return readable ? dayForReader(value) : String(value);
  });
}

/** The texts whose key is `<prefix>.<suffix>` as a map of suffix to text (the labels of a family, for example the columns of an export). */
export function messagesUnder(prefix: string): Readonly<Record<string, string>> {
  const head = `${prefix}.`;
  const found: Record<string, string> = {};
  for (const [key, text] of Object.entries(load())) {
    if (key.startsWith(head)) found[key.slice(head.length)] = text;
  }
  return found;
}
