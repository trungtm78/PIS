/**
 * The on-screen help (DOC-3, YCK.08). The texts are the generated file `help.<locale>.json` (scripts/help-index.mjs); this module only loads
 * the file for the locale (its own chunk, read the first time the help opens) and resolves the entry of one screen.
 */
export interface HelpChapter {
  id: string;
  title: string;
  step: string;
}

export interface HelpEntry {
  title: string;
  module: string;
  moduleName: string;
  kind: string;
  purpose: string;
  audience: string;
  fields: string[];
  req: string;
  rule?: string;
  chapter?: HelpChapter;
}

export interface HelpKind {
  noun: string;
  steps: string[];
}

export interface HelpIndex {
  schema: number;
  locale: string;
  tips: string[];
  kinds: Record<string, HelpKind>;
  screens: Record<string, HelpEntry>;
}

/**
 * How an edition says the guides its own way: per-screen replacements of whole fields (applied first), then ordered literal term substitutions over every text of the index.
 * The public edition has none; the enterprise bundle brings its own file, handed over through the edition bundle (`WebEditionBundle.help`).
 */
export interface HelpOverlay {
  terms?: readonly (readonly string[])[];
  screens?: Readonly<Record<string, Partial<Omit<HelpEntry, 'chapter'>>>>;
}

/** What the drawer shows for one screen: the entry joined with the steps of its kind. */
export interface ScreenHelp extends HelpEntry {
  id: string;
  steps: string[];
  tips: string[];
  locale: string;
}

const FALLBACK_LOCALE = 'vi';
// One lazy chunk for each language file; a language without a file reads the Vietnamese one.
const LOADERS = import.meta.glob<HelpIndex>('./help.*.json', { import: 'default' });
const cache = new Map<string, Promise<HelpIndex>>();

/** Reads the help of a locale (Vietnamese when the locale has no file); the answer is kept, a failed read is not. */
export function loadHelpIndex(locale: string): Promise<HelpIndex> {
  const key = `./help.${locale}.json` in LOADERS ? locale : FALLBACK_LOCALE;
  const kept = cache.get(key);
  if (kept !== undefined) return kept;
  const load = LOADERS[`./help.${key}.json`];
  if (load === undefined) return Promise.reject(new Error(`no help file for ${key}`));
  const reading = load().catch((error: unknown) => {
    cache.delete(key);
    throw error;
  });
  cache.set(key, reading);
  return reading;
}

/** The help of one screen, or undefined when the address is not a screen or the screen has no guide. */
export function helpFor(index: HelpIndex, screenId: string | undefined): ScreenHelp | undefined {
  if (screenId === undefined) return undefined;
  const entry = index.screens[screenId];
  if (entry === undefined) return undefined;
  return { ...entry, id: screenId, steps: index.kinds[entry.kind]?.steps ?? [], tips: index.tips, locale: index.locale };
}

/** Keeps the capital letter a text began with when the substitution turned its first word into a lower-case one. */
function mapText(text: string, terms: readonly (readonly string[])[]): string {
  let out = text;
  for (const [from = '', to = ''] of terms) if (from !== '') out = out.split(from).join(to);
  const first = text.charAt(0);
  return out !== text && first !== first.toLowerCase() && out.charAt(0) === out.charAt(0).toLowerCase() ? out.charAt(0).toUpperCase() + out.slice(1) : out;
}

function mapValue<T>(value: T, terms: readonly (readonly string[])[]): T {
  if (typeof value === 'string') return mapText(value, terms) as T;
  if (Array.isArray(value)) return value.map((one) => mapValue(one, terms)) as T;
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, one]) => [key, mapValue(one, terms)])) as T;
  return value;
}

/** The index as an edition says it: the per-screen replacements first, then the term substitutions over every text. A new index; the loaded one is never changed. */
export function applyHelpOverlay(index: HelpIndex, overlay: HelpOverlay | undefined): HelpIndex {
  if (overlay === undefined) return index;
  const terms = overlay.terms ?? [];
  const screens: Record<string, HelpEntry> = {};
  for (const [id, entry] of Object.entries(index.screens)) screens[id] = mapValue({ ...entry, ...overlay.screens?.[id] }, terms);
  return { ...index, tips: mapValue(index.tips, terms), kinds: mapValue(index.kinds, terms), screens };
}
