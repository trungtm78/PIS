/**
 * The words of a demo dataset that stands on the seed groups of the guide. The groups were written for one province (their tables of texts, the keys of its wards, the codes of
 * its units); a dataset of another province gives `localize.pairs`: ordered pairs `[from, to]` of the words of the guide and the words of the dataset. The seed process keeps
 * living in the words of the guide: every string it sends to the product is rewritten `forward`, every answer it reads is rewritten `backward`, and the plan file it is given was
 * rewritten `backward` by the caller (scripts/clip-seed.mjs). The product only ever holds the words of the dataset.
 *
 * A rewrite is ONE pass over the text (the longest pair wins at a position, and what a pair wrote is never rewritten again), so a pair may write a word another pair reads.
 * Pure: nothing here reads a file or the network. This file is also imported by scripts/clip-seed-lib.mjs (Node strips the types).
 */

export type LocalizePair = readonly [from: string, to: string];

export interface Localizer {
  /** The words of the guide into the words of the dataset. */
  forward: (text: string) => string;
  /** The words of the dataset into the words of the guide. */
  backward: (text: string) => string;
  /** False when there is no pair: both rewrites give the text back. */
  active: boolean;
}

const IDENTITY: Localizer = { forward: (text) => text, backward: (text) => text, active: false };

function rewriter(pairs: ReadonlyArray<readonly [string, string]>): (text: string) => string {
  // The first pair that reads a word wins (a dataset may send two words of the guide to one word of its own; the way back takes the first).
  const table = new Map<string, string>();
  for (const [from, to] of pairs) if (!table.has(from)) table.set(from, to);
  const words = [...table.keys()].sort((a, b) => b.length - a.length);
  if (words.length === 0) return (text) => text;
  const pattern = new RegExp(words.map((word) => word.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('|'), 'gu');
  return (text) => text.replace(pattern, (word) => table.get(word) ?? word);
}

/** The two rewrites of a list of pairs. A pair with an empty side, or one that reads what it writes, is refused by name. */
export function localizer(pairs: ReadonlyArray<LocalizePair> | undefined): Localizer {
  if (pairs === undefined || pairs.length === 0) return IDENTITY;
  for (const [from, to] of pairs) {
    if (typeof from !== 'string' || typeof to !== 'string' || from === '' || to === '') throw new Error(`a pair of the localization has an empty side: ${JSON.stringify([from, to])}`);
    if (/["\\\n]/u.test(from) || /["\\\n]/u.test(to)) throw new Error(`a pair of the localization holds a quote, a backslash or a line break: ${JSON.stringify([from, to])}`);
  }
  return { forward: rewriter(pairs), backward: rewriter(pairs.map(([from, to]) => [to, from] as const)), active: true };
}

/** Every string of a JSON value rewritten (keys of objects are left alone). */
export function rewriteDeep<T>(value: T, rewrite: (text: string) => string): T {
  if (typeof value === 'string') return rewrite(value) as unknown as T;
  if (Array.isArray(value)) return value.map((item) => rewriteDeep(item, rewrite)) as unknown as T;
  if (typeof value === 'object' && value !== null) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rewriteDeep(item, rewrite)])) as unknown as T;
  return value;
}

/** The strings of a JSON value that do not come back from `forward(backward(text))`: a dataset whose own words would be changed on their way through the seed process. */
export function roundTripFaults(value: unknown, words: Localizer): string[] {
  const faults: string[] = [];
  const walk = (item: unknown): void => {
    if (typeof item === 'string') {
      if (words.forward(words.backward(item)) !== item) faults.push(item);
    } else if (Array.isArray(item)) item.forEach(walk);
    else if (typeof item === 'object' && item !== null) Object.values(item).forEach(walk);
  };
  walk(value);
  return faults;
}
