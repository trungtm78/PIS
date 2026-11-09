import { TEXT } from './messages/edition-texts.ts';
/**
 * The product edition mechanism (ENT-0). One code line builds two products that a customer sees as different:
 *   - `public`: the public investment management system, the system of the public investment bodies;
 *   - `enterprise`: the construction investment software of a state enterprise (its name is in its own manifest).
 *
 * This file is pure and imports nothing, so the API, the web build tools and the tests read the same truth. It owns the SHAPE
 * of a manifest, the public manifest and the rules that read a manifest; the manifest of the enterprise edition lives in
 * `packages/edition-enterprise`, so that nothing that belongs to the enterprise product is part of the public sources
 * (`npm run edition:check` keeps it so). Where a switch is read: `MACHVON_EDITION` (API), `VITE_EDITION` (web build),
 * `--dart-define=MACHVON_EDITION` (phone). Nothing set means public; any other value than the two editions fails at start.
 */

export const EDITIONS = ['public', 'enterprise'] as const;
export type Edition = (typeof EDITIONS)[number];
export const DEFAULT_EDITION: Edition = 'public';

/** The variable each part of the product reads the edition from. */
export type EditionVariable = 'MACHVON_EDITION' | 'VITE_EDITION';

/** A refusal of the edition mechanism: an unknown edition, a malformed manifest or an enterprise start without its package. */
export class EditionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EditionError';
  }
}

/** The edition named by an environment; nothing (or blank) means public; a value that is not an edition fails loudly. */
export function resolveEdition(env: Readonly<Record<string, string | undefined>>, variable: EditionVariable = 'MACHVON_EDITION'): Edition {
  const raw = env[variable];
  if (raw === undefined || raw.trim() === '') return DEFAULT_EDITION;
  const value = raw.trim();
  const edition = EDITIONS.find((candidate) => candidate === value);
  if (edition === undefined) throw new EditionError(`${variable} must be one of ${EDITIONS.join(', ')}; got an unknown value`);
  return edition;
}

/** Whether a value is an edition. */
export function isEdition(value: unknown): value is Edition {
  return EDITIONS.some((candidate) => candidate === value);
}

/**
 * What an edition lets through: everything (`'*'`) or only the listed ids, less the ids denied. The deny list is applied last, so
 * an edition can say "everything but" without listing the rest.
 */
export interface AllowList {
  readonly allow: readonly string[] | '*';
  readonly deny: readonly string[];
}

export const ALLOW_ALL: AllowList = { allow: '*', deny: [] };

/** Whether the id passes the list. */
export function allows(list: AllowList, id: string): boolean {
  if (list.deny.includes(id)) return false;
  return list.allow === '*' || list.allow.includes(id);
}

/** The items whose id passes the list, in their own order. */
export function filterAllowed<T>(list: AllowList, items: readonly T[], idOf: (item: T) => string): T[] {
  return items.filter((item) => allows(list, idOf(item)));
}

export interface LocalisedText {
  readonly vi: string;
  readonly en: string;
}

/** What a person sees as the name of the product. */
export interface EditionBrand {
  /** The short mark in the corner of the shell (the letters of the logo) and on the home-screen icon. */
  readonly mark: LocalisedText;
  /** The colour of the browser chrome and of the install prompt (a 6-digit hex, no alpha). */
  readonly themeColor: string;
}

/**
 * The terminology overlay of an edition: the keys of the base catalogue the edition says in its own words. The overlay may only
 * replace keys that exist in the base catalogue (the catalogue stays the base); the manifest names them so that a test can hold
 * the overlay files to the list. Web keys are `module.screen.action.state`; phone keys are `mob.*`.
 */
export interface TerminologyOverlay {
  readonly web: readonly string[];
  readonly mobile: readonly string[];
}

export interface EditionManifest {
  readonly edition: Edition;
  /** The name of the product in the two languages: the shell, the browser tab, the phone's task switcher. */
  readonly productName: LocalisedText;
  readonly brand: EditionBrand;
  /** The business modules (ADM, CAP, ...) that exist in the edition: the API mounts only these and the web registers only their routes. */
  readonly modules: AllowList;
  /** The screens (CAP-01, ...) that exist in the edition, on top of the module list. */
  readonly screens: AllowList;
  /** The modules shown in the menu, the library and the directory; a module outside the menu is still reachable by a link. */
  readonly menu: AllowList;
  readonly terminology: TerminologyOverlay;
  /**
   * The rule packs the edition runs on (ids such as `public-investment`): what a threshold, a funding taxonomy or a form set is
   * read from. A pack is a name here; the content of a pack lives with the rule that reads it.
   */
  readonly rulePacks: readonly string[];
}

const MODULE_CODE = /^[A-Z]{2,6}$/;
const SCREEN_ID = /^[A-Z]{2,6}-\d{2,3}$/;
const TERM_KEY = /^[a-z][a-zA-Z0-9]*(\.[a-zA-Z][a-zA-Z0-9]*){2,4}$/;
const RULE_PACK_ID = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const HEX_COLOUR = /^#[0-9a-fA-F]{6}$/;

function assertUnique(label: string, values: readonly string[]): void {
  if (new Set(values).size !== values.length) throw new EditionError(`${label} lists an id twice`);
}

function assertList(label: string, list: AllowList, shape: RegExp): void {
  const ids = [...(list.allow === '*' ? [] : list.allow), ...list.deny];
  for (const id of ids) if (!shape.test(id)) throw new EditionError(`${label} holds a malformed id: ${id}`);
  if (list.allow !== '*') assertUnique(`${label} allow`, list.allow);
  assertUnique(`${label} deny`, list.deny);
}

/** Validates a manifest and returns it (frozen), so a malformed one fails when it is loaded rather than when a customer opens a screen. */
export function defineEditionManifest(manifest: EditionManifest): EditionManifest {
  if (!isEdition(manifest.edition)) throw new EditionError('the manifest names no known edition');
  for (const [label, text] of [
    ['productName', manifest.productName],
    ['brand.mark', manifest.brand.mark],
  ] as const) {
    if (text.vi.trim() === '' || text.en.trim() === '') throw new EditionError(`${label} needs a Vietnamese and an English text`);
  }
  if (!HEX_COLOUR.test(manifest.brand.themeColor)) throw new EditionError('brand.themeColor must be a 6-digit hex colour');
  assertList('modules', manifest.modules, MODULE_CODE);
  assertList('menu', manifest.menu, MODULE_CODE);
  assertList('screens', manifest.screens, SCREEN_ID);
  for (const key of [...manifest.terminology.web, ...manifest.terminology.mobile]) if (!TERM_KEY.test(key)) throw new EditionError(`terminology holds a malformed key: ${key}`);
  assertUnique('terminology.web', manifest.terminology.web);
  assertUnique('terminology.mobile', manifest.terminology.mobile);
  for (const key of manifest.terminology.mobile) if (!key.startsWith('mob.')) throw new EditionError(`a phone terminology key starts with mob.: ${key}`);
  for (const pack of manifest.rulePacks) if (!RULE_PACK_ID.test(pack)) throw new EditionError(`rulePacks holds a malformed id: ${pack}`);
  assertUnique('rulePacks', manifest.rulePacks);
  return Object.freeze({ ...manifest });
}

/** The public edition: everything the product has today, under the name it has today. */

/**
 * The business modules whose pages are part of the shared design (the screen catalogue and the route table list them) but whose code exists in the enterprise edition only (ENT-2: the connections to HPM and to Oracle EBS).
 * The public manifest denies them by code, so a public process mounts none of their controllers and the public web build opens none of their routes; their code lives in the enterprise homes (`npm run edition:check`).
 */
export const ENTERPRISE_ONLY_MODULES: readonly string[] = ['EBS', 'HPM', 'ORG'];

/** The public edition: everything the product has today, under the name it has today, but for the modules of the enterprise edition only. */
export const PUBLIC_EDITION_MANIFEST: EditionManifest = defineEditionManifest({
  edition: 'public',
  productName: { vi: TEXT.public_edition_manifest_product_name_vi, en: 'Public Investment Management System' },
  brand: { mark: { vi: TEXT.brand_mark_vi, en: 'PI' }, themeColor: '#102E3B' },
  modules: { allow: '*', deny: ENTERPRISE_ONLY_MODULES },
  screens: ALLOW_ALL,
  menu: ALLOW_ALL,
  terminology: { web: [], mobile: [] },
  rulePacks: ['public-investment'],
});

/**
 * The manifest of an edition. The enterprise manifest is handed in by whoever loads the enterprise package (the composition root
 * of the process), because this file must not import it; asking for the enterprise edition without it fails at start.
 */
export function resolveManifest(edition: Edition, enterprise?: EditionManifest): EditionManifest {
  if (edition === 'public') return PUBLIC_EDITION_MANIFEST;
  if (enterprise === undefined) throw new EditionError('the enterprise edition was selected but the enterprise package was not loaded');
  if (enterprise.edition !== 'enterprise') throw new EditionError('the manifest handed in as the enterprise one is not an enterprise manifest');
  return enterprise;
}

/** Whether a business module exists in the edition. */
export function moduleInEdition(manifest: EditionManifest, code: string): boolean {
  return allows(manifest.modules, code);
}

/** Whether a screen exists in the edition: its module exists and the screen is not turned off. */
export function screenInEdition(manifest: EditionManifest, screen: { id: string; module: string }): boolean {
  return allows(manifest.modules, screen.module) && allows(manifest.screens, screen.id);
}

/** Whether a module is offered in the menu: it exists in the edition and the menu lists it. */
export function moduleInMenu(manifest: EditionManifest, code: string): boolean {
  return allows(manifest.modules, code) && allows(manifest.menu, code);
}

/** The name of the product in a language (the language `vi` is the fallback of every other one). */
export function productNameOf(manifest: EditionManifest, language: string): string {
  return language === 'en' ? manifest.productName.en : manifest.productName.vi;
}

/**
 * What the edition and the base catalogue say about an overlay: the keys the overlay holds that the manifest does not list, the keys
 * the manifest lists that the overlay lacks, and the keys the base catalogue does not know (an overlay never adds a key). Empty lists
 * mean the overlay is sound; the checker of the web and of the phone use this one rule.
 */
export interface OverlayProblems {
  readonly unlisted: readonly string[];
  readonly missing: readonly string[];
  readonly unknownToBase: readonly string[];
}

export function overlayProblems(listed: readonly string[], overlay: Readonly<Record<string, string>>, base: Readonly<Record<string, string>>): OverlayProblems {
  const held = Object.keys(overlay);
  return {
    unlisted: held.filter((key) => !listed.includes(key)),
    missing: listed.filter((key) => overlay[key] === undefined),
    unknownToBase: held.filter((key) => base[key] === undefined),
  };
}
