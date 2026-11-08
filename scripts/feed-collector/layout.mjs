import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// The layouts the platform reads (the file `layouts.json` is kept equal to the kernel by a test of the kernel). The collector checks an export against them before it sends anything, so a file the platform would
// refuse as a whole never leaves the machine.

const LAYOUTS = JSON.parse(readFileSync(fileURLToPath(new URL('./layouts.json', import.meta.url)), 'utf8'));

export const LAYOUT_VERSION = LAYOUTS.layoutVersion;
export const LAYOUT_VERSIONS = [LAYOUTS.layoutVersion];
export const MAX_ROWS = LAYOUTS.maxRows;
export const KINDS = Object.keys(LAYOUTS.kinds);

/** A header as the platform compares it: trimmed, lower case, spaces and hyphens as underscores. */
export const headerOf = (header) => header.trim().toLowerCase().replace(/[\s-]+/g, '_');

export const columnsOf = (kind) => (LAYOUTS.kinds[kind] ?? []).map((column) => column.name);

/**
 * The kind an export is for: named by the start of the file name (`project`, `plan`, `disbursement`, `milestone`, any case), else the only kind whose required columns the header has.
 * Returns undefined when it cannot be told.
 */
export function kindOfFile(fileName, headers) {
  const lower = fileName.toLowerCase();
  const named = KINDS.find((kind) => lower.startsWith(kind.toLowerCase()));
  if (named !== undefined) return named;
  const present = new Set(headers.map(headerOf));
  const fitting = KINDS.filter((kind) => LAYOUTS.kinds[kind].every((column) => !column.required || present.has(column.name)));
  return fitting.length === 1 ? fitting[0] : undefined;
}

/**
 * Judges the header of an export against the layout of a version: a version the platform does not read is `LAYOUT_VERSION_UNKNOWN`; a missing required column is `IMPORT_SCHEMA_INVALID` naming the columns; a
 * column named twice is `DUPLICATE_COLUMNS`. Returns `{ ok: true }` or `{ ok: false, code, detail }`.
 */
export function checkLayout(kind, headers, layoutVersion = LAYOUT_VERSION) {
  if (!LAYOUT_VERSIONS.includes(layoutVersion)) return { ok: false, code: 'LAYOUT_VERSION_UNKNOWN', detail: { layout_version: layoutVersion, supported: LAYOUT_VERSIONS } };
  if (LAYOUTS.kinds[kind] === undefined) return { ok: false, code: 'KIND_UNKNOWN', detail: { kind } };
  const names = headers.map(headerOf).filter((name) => name !== '');
  if (new Set(names).size !== names.length) return { ok: false, code: 'DUPLICATE_COLUMNS', detail: {} };
  const missing = LAYOUTS.kinds[kind].filter((column) => column.required && !names.includes(column.name)).map((column) => column.name);
  return missing.length > 0 ? { ok: false, code: 'IMPORT_SCHEMA_INVALID', detail: { missing_columns: missing } } : { ok: true };
}

/** The rows of a table as objects keyed by the names of the layout (a column the layout does not know is left out, so nothing but the layout is sent). */
export function rowsAsObjects(kind, headers, rows) {
  const known = new Set(columnsOf(kind));
  const wanted = headers.map((header, index) => ({ name: headerOf(header), index })).filter((column) => known.has(column.name));
  return rows.map((row) => Object.fromEntries(wanted.map((column) => [column.name, row[column.index] ?? ''])));
}
