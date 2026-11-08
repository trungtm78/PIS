import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_LOCALE = 'vi';

/** The messages of the on-prem scripts (native dependencies, bundle, backup verification, infrastructure artefacts): `messages/onprem.<locale>.json`. */
export function loadOnpremMessages(locale = DEFAULT_LOCALE) {
  return JSON.parse(readFileSync(join(SCRIPT_DIR, 'messages', `onprem.${locale}.json`), 'utf8'));
}

export function format(template, params = {}) {
  return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match));
}
