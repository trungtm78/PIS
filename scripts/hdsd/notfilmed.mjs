import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './lib.mjs';

const FILE = join('scripts', 'hdsd', 'not-filmed.json');
const POLICY = join('apps', 'mobile', 'lib', 'core', 'navigation', 'route_policy.dart');

/** The screens that cannot be filmed, each with the reason and the evidence: an array of `{ screen, reason, evidence }` in scripts/hdsd/not-filmed.json. */
export function loadNotFilmed(root = REPO_ROOT) {
  const file = join(root, FILE);
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [];
}

/** The problems of a list of not-filmed screens: its shape, the screens it names, and a screen named twice. An empty list is a good list. */
export function notFilmedProblems(entries, catalogue) {
  if (!Array.isArray(entries)) return ['not-filmed.json must be an array of { screen, reason, evidence }'];
  const known = new Map(catalogue.map((screen) => [screen.id, screen]));
  const problems = [];
  const seen = new Set();
  for (const [index, entry] of entries.entries()) {
    const where = `entry ${index}`;
    for (const key of ['screen', 'reason', 'evidence']) if (typeof entry?.[key] !== 'string' || entry[key].trim() === '') problems.push(`${where}: ${key} is missing`);
    if (typeof entry?.screen !== 'string') continue;
    if (!known.has(entry.screen)) problems.push(`${where}: ${entry.screen} is not a screen of the catalogue`);
    if (seen.has(entry.screen)) problems.push(`${where}: ${entry.screen} is listed twice`);
    seen.add(entry.screen);
  }
  return problems;
}

/** What the table of screens says about a screen that is not filmed: the reason, which is written for the reader of the guide (the evidence stays in the file). */
export function reasonsOf(entries) {
  return new Map(entries.map((entry) => [entry.screen, entry.reason]));
}

/** The screens the application protects against screenshots and recordings: `kSecureScreenIds` of the phone application, read from its source. */
export function secureScreensOf(root = REPO_ROOT) {
  const source = readFileSync(join(root, POLICY), 'utf8');
  const block = /const Set<String> kSecureScreenIds = <String>\{([^}]*)\}/u.exec(source);
  if (block === null) throw new Error('kSecureScreenIds is not in route_policy.dart');
  return [...block[1].matchAll(/'([A-Z]+-\d+)'/gu)].map((found) => found[1]);
}

/**
 * The gaps of the phone part of the guide: a phone screen is accounted for when a recorded step shows it or when it is listed as not filmed, and
 * nothing else is accepted as not filmed: a listed screen must be one the application protects (it cannot be filmed), and a screen that was filmed
 * is not listed. `phoneIds` are the screens of the phone (the catalogue marks them with the platform `mobile`).
 */
export function coverageGaps({ phoneIds, shown, entries, secure }) {
  const listed = new Set(entries.map((entry) => entry.screen));
  const protectedScreens = new Set(secure);
  const phone = new Set(phoneIds);
  return {
    missing: phoneIds.filter((id) => !shown.has(id) && !listed.has(id)),
    listedButNotProtected: [...listed].filter((id) => !protectedScreens.has(id)),
    listedNotOnPhone: [...listed].filter((id) => !phone.has(id)),
    protectedButFilmed: [...protectedScreens].filter((id) => phone.has(id) && shown.has(id)),
  };
}

export const gapsFound = (gaps) => Object.values(gaps).some((ids) => ids.length > 0);

/** The gaps of the phone screens of a catalogue, given the coverage of the recorded chapters. */
export function phoneGaps(catalogue, coverage, root = REPO_ROOT) {
  return coverageGaps({
    phoneIds: catalogue.filter((screen) => screen.platform === 'mobile').map((screen) => screen.id),
    shown: coverage.shown,
    entries: loadNotFilmed(root),
    secure: secureScreensOf(root),
  });
}
