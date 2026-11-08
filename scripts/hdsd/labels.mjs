import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The fixed words of the guide pages (headings, column names, captions) live in labels.json; the page builders only place them. */
export const LABELS = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'labels.json'), 'utf8'));

/** A label with its `{name}` placeholders replaced. */
export const fill = (template, params) => template.replace(/\{(\w+)\}/gu, (_, key) => String(params[key]));
