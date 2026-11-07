import { unzipSync, zipSync } from 'fflate';
import type { Zippable } from 'fflate';
import { DomainError } from '@machvon/kernel';

/** The time every entry of a normalised archive is stamped with: midnight of 1 January 2000 as a local time, so the zip date fields are the same on every machine (zip keeps no time zone). */
export const ZIP_EPOCH = new Date(2000, 0, 1, 0, 0, 0);

/** Entries that Office wants first, in this order; the rest follow sorted by name. */
const LEADING = ['[Content_Types].xml', '_rels/.rels'];

const entryRank = (name: string): number => {
  const index = LEADING.indexOf(name);
  return index === -1 ? LEADING.length : index;
};

/** The names of the entries of an archive, or TEMPLATE_INVALID when the bytes are not a zip. */
export function zipEntryNames(bytes: Uint8Array): string[] {
  try {
    const names: string[] = [];
    unzipSync(bytes, {
      filter: (file) => {
        names.push(file.name);
        return false;
      },
    });
    return names;
  } catch {
    throw new DomainError('TEMPLATE_INVALID', 422, 'zip');
  }
}

/** The text of one entry of an archive, or undefined when it is not there. */
export function zipEntryText(bytes: Uint8Array, name: string): string | undefined {
  const files = unzipSync(bytes, { filter: (file) => file.name === name });
  const entry = files[name];
  return entry === undefined ? undefined : new TextDecoder().decode(entry);
}

/**
 * The same files in a fixed order with fixed times and one compression level, so that the same content always gives the same bytes and therefore the same sha256 (the writers of xlsx and docx stamp each entry with
 * the time of writing). `replace` may rewrite the text of an entry on the way (the dates of the document properties).
 */
export function normalizeZip(bytes: Uint8Array, options: { mtime?: Date; replace?: Readonly<Record<string, (text: string) => string>> } = {}): Uint8Array {
  const mtime = options.mtime ?? ZIP_EPOCH;
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes);
  } catch {
    throw new DomainError('TEMPLATE_INVALID', 422, 'zip');
  }
  const names = Object.keys(files).sort((a, b) => entryRank(a) - entryRank(b) || (a < b ? -1 : a > b ? 1 : 0));
  const out: Zippable = {};
  for (const name of names) {
    let data = files[name] as Uint8Array;
    const replace = options.replace?.[name];
    if (replace !== undefined) data = new TextEncoder().encode(replace(new TextDecoder().decode(data)));
    out[name] = [data, { level: 6, mtime }];
  }
  return zipSync(out);
}
