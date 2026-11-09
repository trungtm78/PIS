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
