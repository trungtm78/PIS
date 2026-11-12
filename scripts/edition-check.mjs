// Checks that the public edition holds nothing of the enterprise edition (ENT-0, structure B of the plan): enterprise-only code lives in `packages/edition-enterprise`,
// `apps/web/src/editions/enterprise`, `apps/mobile/lib/editions/enterprise` and `apps/api/src/editions/enterprise` (the controllers of the enterprise connections, loaded by `load-enterprise.ts`) only. Static rules, run on the sources:
//   - no file outside those homes imports them, except one loader per process (the seams below) and the tests named *.enterprise.test.* / *enterprise_test.dart;
//   - no source outside the homes carries a word that only the enterprise edition says (its product name, its rule packs), read from its own manifest;
//   - no module of the API registry exists in the enterprise edition only (the registry of the public edition mounts no enterprise controller);
//   - the terminology overlays of the web and the phone hold exactly the keys the manifest lists, and only keys the base catalogue knows;
//   - the public edition shows no code name: no source a person of the public edition reads (the web shell and its catalogues, the phone strings and manifests, the API texts, the open API document, the guides, the public logos) carries
//     "MACHVON" or "Mạch Vốn" as a name, outside the enterprise files (internal identifiers such as package names, environment variables and the database schema are not names and are not matched);
//   - the names of the product every surface carries are the ones the edition manifests say (`scripts/edition-brand.mjs`: the generated phone files and the static web names).
// And on a build: `--public-dist <dir>` must carry no enterprise word and no path of the enterprise homes; `--enterprise-dist <dir>` must carry the enterprise name
// (so a blind scan cannot pass for a clean one). The same list of importers is kept in `.dependency-cruiser.cjs` (rule enterprise-edition-code-only-from-its-homes).
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { brandDrift } from './edition-brand.mjs';

const require = createRequire(import.meta.url);
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(SCRIPT_DIR, '..');

export const FINDING_CODES = [
  'ENT_IMPORTS_ENTERPRISE',
  'ENT_ENTERPRISE_WORD_IN_PUBLIC_SOURCE',
  'ENT_ENTERPRISE_ONLY_MODULE',
  'ENT_MANIFEST_UNREADABLE',
  'ENT_OVERLAY_MISMATCH',
  'ENT_DIST_HOLDS_ENTERPRISE',
  'ENT_DIST_LACKS_ENTERPRISE',
  'ENT_DIST_MISSING',
  'ENT_CODE_NAME_IN_PUBLIC_SURFACE',
  'ENT_BRAND_DRIFT',
];

/** The folders that hold the enterprise edition only. */
export const ENTERPRISE_HOMES = ['packages/edition-enterprise/', 'apps/web/src/editions/enterprise/', 'apps/mobile/lib/editions/enterprise/', 'apps/api/src/editions/enterprise/'];
/** The files that may import a home besides the homes themselves: one loader per process. */
export const ENTERPRISE_SEAMS = ['apps/web/src/editions/load.ts', 'apps/api/src/editions/load-enterprise.ts', 'apps/mobile/lib/app/edition_seam.dart', 'apps/web/e2e/support/edition-terms.ts'];
const IMPORTER_TESTS = /\.enterprise\.test\.tsx?$|enterprise_test\.dart$/;

const WEB_OVERLAY_DIR = 'apps/web/src/editions/enterprise';
const WEB_CATALOGUE_DIR = 'apps/web/src/i18n';
const MOBILE_OVERLAY = 'apps/mobile/lib/editions/enterprise/enterprise_strings.dart';
const MOBILE_STRINGS_DIR = 'apps/mobile/lib';
const MANIFEST = 'packages/edition-enterprise/src/manifest.ts';
const API_MODULES = 'apps/api/src/modules';

const SCAN_ROOTS = ['apps', 'packages'];
const SKIPPED = new Set(['node_modules', 'dist', 'coverage', 'build', '.dart_tool', 'test-results', 'lint-fixtures', '.git', 'ios', 'android', 'qa']);
const SOURCE_FILE = /\.(?:tsx?|mts|cts|dart)$/;
const WORD_FILE = /\.(?:tsx?|mts|cts|dart|json|html)$/;
const TEST_FILE = /(?:\.(?:test|spec)\.[cm]?tsx?|_test\.dart)$/;
const TEST_DIRECTORY = /(?:^|\/)(?:test|tests|e2e|__tests__)\//;
const DIST_FILE = /\.(?:js|mjs|cjs|css|html|json|webmanifest|map|txt)$/;

/**
 * The code name as a NAME a person reads: the word MACHVON (or Machvon, Mach Von) standing alone, and the Vietnamese "Mạch Vốn" in any case and with or without marks. An identifier is not a name and is not matched:
 * `@machvon/kernel`, `MACHVON_EDITION`, `machvon_tokens`, `vn.machvon.app`, `machvon.audit_event`, `MACHVON-PVFCCO`, `MachvonApp`, a lower-case `machvon`.
 */
export const CODE_NAME_WORD = /(?<![\w.@/:-])(?:MACHVON|Machvon|MachVon|Mach Von|MACH VON)(?![\w:./-])/;
export const CODE_NAME_VIETNAMESE = /m[ạa]ch\s+v[ốo]n/i;

/** Whether a line of text says the code name as a name. */
export function namesCodeName(line) {
  const text = line.normalize('NFC');
  return CODE_NAME_WORD.test(text) || CODE_NAME_VIETNAMESE.test(text);
}

/**
 * The folders and files a person of the public edition reads, besides what the rules above scan: `{ root, only? }`, paths relative to the repository root, `only` narrowing a folder to the files that are a surface.
 * The sources of the web, the phone (strings, Android and iOS resources, permission texts), the API (texts of the exports, the open API document), the kernel (messages), the public logos, the open API document of the readers and the admin guide.
 */
export const PUBLIC_SURFACES = [
  { root: 'apps/web', only: /^apps\/web\/(?:index\.html$|public\/|src\/)/ },
  { root: 'apps/mobile', only: /^apps\/mobile\/(?:lib\/|ios\/Runner\/|android\/app\/src\/(?:main|debug|profile)\/)/ },
  { root: 'apps/api', only: /^apps\/api\/src\// },
  { root: 'packages/kernel', only: /^packages\/kernel\/src\// },
  { root: 'brand', only: /^brand\/logo\/logo-public-[^/]*\.svg$/ },
  { root: 'docs/open-api' },
  { root: 'docs', only: /^docs\/admin-guide\.md$/ },
  { root: 'scripts/hdsd', only: /\.json$/ },
  { root: 'scripts/help', only: /\.json$/ },
];
const SURFACE_SKIPPED = new Set(['node_modules', 'dist', 'coverage', 'build', '.dart_tool', 'test-results', 'lint-fixtures', '.git', 'Pods', '.gradle', 'qa']);
/** Files that are not a surface of the product: the ones that only carry names for tests, and the files of the enterprise edition by name. */
const NOT_A_SURFACE = /(?:^|\/)(?:test-support|test-fixtures?)\.[cm]?tsx?$|\/src\/enterprise\/|\.enterprise\./;
const SURFACE_TEXT = /\.(?:tsx?|mts|cts|dart|json|html|xml|plist|md|svg|webmanifest|strings)$/;
const CODE_LINE = /\.(?:tsx?|mts|cts|dart)$/;
const MARKUP_FILE = /\.(?:xml|html|svg|plist)$/;

function* surfaceFiles(root, directory) {
  if (!existsSync(join(root, directory))) return;
  for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
    if (SURFACE_SKIPPED.has(entry.name)) continue;
    const path = posix.join(directory, entry.name);
    if (entry.isDirectory()) yield* surfaceFiles(root, path);
    else yield path;
  }
}

/** A line that is a comment of a source: a comment about the code name is not shown to anybody. */
function isCommentLine(path, line) {
  const trimmed = line.trim();
  if (CODE_LINE.test(path)) return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*');
  if (MARKUP_FILE.test(path)) return trimmed.startsWith('<!--') && trimmed.endsWith('-->');
  return false;
}

function codeNameFindings(root) {
  const found = [];
  const seen = new Set();
  for (const surface of PUBLIC_SURFACES) {
    for (const path of surfaceFiles(root, surface.root)) {
      if (seen.has(path) || (surface.only !== undefined && !surface.only.test(path))) continue;
      seen.add(path);
      if (!SURFACE_TEXT.test(path) || inEnterpriseHome(path) || isTestSource(path) || NOT_A_SURFACE.test(path)) continue;
      readFileSync(join(root, path), 'utf8')
        .split(/\r?\n/)
        .forEach((line, index) => {
          if (namesCodeName(line) && !isCommentLine(path, line)) found.push(finding('ENT_CODE_NAME_IN_PUBLIC_SURFACE', path, `line ${index + 1} says the code name as a name of the product; the public edition shows none (the names come from the edition manifest)`));
        });
    }
  }
  return found;
}

const toPosix = (path) => path.split(sep).join('/');
const finding = (code, file, message) => ({ code, file, message });

/** Whether a root-relative path (posix) is inside an enterprise home. */
export function inEnterpriseHome(path) {
  return ENTERPRISE_HOMES.some((home) => path.startsWith(home));
}

/** Whether a file may import the enterprise homes: it is in one, it is a loader, or it is a test named for the purpose. */
export function mayImportEnterprise(path) {
  return inEnterpriseHome(path) || ENTERPRISE_SEAMS.includes(path) || IMPORTER_TESTS.test(path);
}

function* files(root, directory) {
  for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
    if (SKIPPED.has(entry.name)) continue;
    const path = posix.join(directory, entry.name);
    if (entry.isDirectory()) yield* files(root, path);
    else yield path;
  }
}

function scanned(root) {
  return SCAN_ROOTS.filter((directory) => existsSync(join(root, directory))).flatMap((directory) => [...files(root, directory)]);
}

/** The literal specifiers a source file imports, re-exports or loads: TypeScript through the compiler's own scanner, Dart through its directive syntax. */
export function specifiersOf(path, text) {
  if (path.endsWith('.dart')) return [...text.matchAll(/^\s*(?:import|export|part)\s+(?:'([^']+)'|"([^"]+)")/gm)].map((match) => match[1] ?? match[2]);
  const ts = require('typescript');
  return ts.preProcessFile(text, true, true).importedFiles.map((entry) => entry.fileName);
}

/** Whether a specifier written in `path` names the enterprise edition: its package, one of its homes, by name, alias or relative path. */
export function namesEnterprise(path, specifier) {
  if (/edition-enterprise|editions\/enterprise|editions_enterprise/.test(specifier)) return true;
  if (!specifier.startsWith('.')) return false;
  const target = posix.normalize(posix.join(posix.dirname(path), specifier));
  return inEnterpriseHome(target.endsWith('/') ? target : `${target}/`) || inEnterpriseHome(target);
}

/** The words only the enterprise edition says, read from its own manifest: the product name in both languages and its rule packs. */
export async function enterpriseWords(root) {
  const manifestPath = join(root, MANIFEST);
  if (!existsSync(manifestPath)) return { manifest: undefined, words: [] };
  const { ENTERPRISE_EDITION_MANIFEST: manifest } = await import(pathToFileURL(manifestPath).href);
  return { manifest, words: [manifest.productName.vi, manifest.productName.en, ...manifest.rulePacks] };
}

function isTestSource(path) {
  return TEST_FILE.test(path) || TEST_DIRECTORY.test(path);
}

function importFindings(root, paths) {
  const found = [];
  for (const path of paths) {
    if (!SOURCE_FILE.test(path) || mayImportEnterprise(path)) continue;
    for (const specifier of specifiersOf(path, readFileSync(join(root, path), 'utf8'))) {
      if (namesEnterprise(path, specifier)) found.push(finding('ENT_IMPORTS_ENTERPRISE', path, `imports ${specifier}: only the enterprise homes, the loaders and the *.enterprise.test files may name the enterprise edition`));
    }
  }
  return found;
}

function wordFindings(root, paths, words) {
  const found = [];
  if (words.length === 0) return found;
  for (const path of paths) {
    if (!WORD_FILE.test(path) || inEnterpriseHome(path) || isTestSource(path)) continue;
    const text = readFileSync(join(root, path), 'utf8');
    for (const word of words) if (text.includes(word)) found.push(finding('ENT_ENTERPRISE_WORD_IN_PUBLIC_SOURCE', path, `carries a word of the enterprise edition ("${word}") outside its homes`));
  }
  return found;
}

function moduleFindings(root, paths) {
  const found = [];
  for (const path of paths.filter((entry) => entry.startsWith(`${API_MODULES}/`) && entry.endsWith('.ts') && !isTestSource(entry))) {
    const text = readFileSync(join(root, path), 'utf8');
    for (const match of text.matchAll(/\beditions\s*:\s*\[([^\]]*)\]/g)) {
      const editions = [...(match[1] ?? '').matchAll(/'([^']+)'|"([^"]+)"/g)].map((entry) => entry[1] ?? entry[2]);
      if (editions.length > 0 && !editions.includes('public')) found.push(finding('ENT_ENTERPRISE_ONLY_MODULE', path, 'a module of the enterprise edition only belongs in packages/edition-enterprise, not in the registry of the public API'));
    }
  }
  return found;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** The keys of a flat catalogue of the web: the base file and the parts the lanes add. */
function webCatalogue(root, locale) {
  const keys = new Set(Object.keys(readJson(join(root, WEB_CATALOGUE_DIR, `${locale}.json`))));
  const parts = join(root, WEB_CATALOGUE_DIR, 'parts');
  if (existsSync(parts)) for (const name of readdirSync(parts)) if (name.endsWith(`.${locale}.json`)) for (const key of Object.keys(readJson(join(parts, name)))) keys.add(key);
  return keys;
}

function sameKeys(label, held, listed, problems) {
  const extra = held.filter((key) => !listed.includes(key));
  const missing = listed.filter((key) => !held.includes(key));
  if (extra.length > 0) problems.push(`${label} holds keys the manifest does not list: ${extra.join(', ')}`);
  if (missing.length > 0) problems.push(`${label} lacks keys the manifest lists: ${missing.join(', ')}`);
}

function webOverlayFindings(root, manifest) {
  const problems = [];
  for (const locale of ['vi', 'en']) {
    const path = join(root, WEB_OVERLAY_DIR, `overlay.${locale}.json`);
    if (!existsSync(path)) {
      problems.push(`overlay.${locale}.json is missing`);
      continue;
    }
    const keys = Object.keys(readJson(path));
    sameKeys(`overlay.${locale}.json`, keys, manifest.terminology.web, problems);
    const base = existsSync(join(root, WEB_CATALOGUE_DIR, `${locale}.json`)) ? webCatalogue(root, locale) : undefined;
    if (base !== undefined) {
      const unknown = keys.filter((key) => !base.has(key));
      if (unknown.length > 0) problems.push(`overlay.${locale}.json holds keys the base catalogue does not know (an overlay replaces, it never adds): ${unknown.join(', ')}`);
    }
  }
  return problems.map((message) => finding('ENT_OVERLAY_MISMATCH', WEB_OVERLAY_DIR, message));
}

/** The keys a Dart string table declares for one language: `'mob.x.y.z': '...'` entries between the `vi:` and `en:` markers. */
export function dartOverlayKeys(text) {
  const enAt = text.indexOf('en:');
  const viAt = text.indexOf('vi:');
  if (viAt < 0 || enAt < 0 || enAt < viAt) return undefined;
  const keysIn = (part) => [...part.matchAll(/'(mob\.[A-Za-z0-9.]+)'\s*:/g)].map((match) => match[1]);
  return { vi: keysIn(text.slice(viAt, enAt)), en: keysIn(text.slice(enAt)) };
}

function mobileFindings(root, manifest) {
  const path = join(root, MOBILE_OVERLAY);
  if (!existsSync(path)) return manifest.terminology.mobile.length === 0 ? [] : [finding('ENT_OVERLAY_MISMATCH', MOBILE_OVERLAY, 'the manifest lists phone keys but the phone overlay file is missing')];
  const problems = [];
  const text = readFileSync(path, 'utf8');
  const name = /kEnterpriseProductNameVi\s*=\s*'([^']*)'/.exec(text)?.[1];
  if (name !== manifest.productName.vi) problems.push(`kEnterpriseProductNameVi (${name ?? 'missing'}) must equal the Vietnamese product name of the manifest`);
  const keys = dartOverlayKeys(text);
  if (keys === undefined) return [...problems.map((message) => finding('ENT_OVERLAY_MISMATCH', MOBILE_OVERLAY, message)), finding('ENT_OVERLAY_MISMATCH', MOBILE_OVERLAY, 'the phone overlay must declare a vi: map and then an en: map')];
  const base = { vi: new Set(), en: new Set() };
  const stringsRoot = join(root, MOBILE_STRINGS_DIR);
  if (existsSync(stringsRoot)) {
    for (const file of files(root, MOBILE_STRINGS_DIR)) {
      if (!file.endsWith('.dart') || inEnterpriseHome(file)) continue;
      const parsed = dartOverlayKeys(readFileSync(join(root, file), 'utf8'));
      if (parsed === undefined) continue;
      for (const locale of ['vi', 'en']) for (const key of parsed[locale]) base[locale].add(key);
    }
  }
  for (const locale of ['vi', 'en']) {
    sameKeys(`the phone overlay (${locale})`, keys[locale], manifest.terminology.mobile, problems);
    const unknown = keys[locale].filter((key) => !base[locale].has(key));
    if (base[locale].size > 0 && unknown.length > 0) problems.push(`the phone overlay (${locale}) holds keys the base strings do not know: ${unknown.join(', ')}`);
  }
  return problems.map((message) => finding('ENT_OVERLAY_MISMATCH', MOBILE_OVERLAY, message));
}

function distFiles(directory) {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (DIST_FILE.test(entry.name) && statSync(path).size < 64 * 1024 * 1024) out.push(path);
    }
  };
  walk(directory);
  return out;
}

const PATH_MARKERS = ['edition-enterprise', 'editions/enterprise'];

/** The enterprise words and paths a build carries; for a public build the answer must be empty. */
export function distHits(directory, words) {
  const hits = new Set();
  for (const path of distFiles(directory)) {
    const text = readFileSync(path, 'utf8');
    for (const marker of [...words, ...PATH_MARKERS]) if (text.includes(marker)) hits.add(marker);
  }
  return [...hits];
}

/** The lines of a build that say the code name as a name (a public build shows none): `{ file, line }`, at most one hit per file and a line cut to a readable length. */
export function distCodeNameHits(directory) {
  const hits = [];
  for (const path of distFiles(directory)) {
    if (path.endsWith('.map')) continue;
    const line = readFileSync(path, 'utf8')
      .split(/\r?\n/)
      .find((entry) => namesCodeName(entry));
    if (line !== undefined) hits.push({ file: path, line: line.trim().slice(0, 80) });
  }
  return hits;
}

/**
 * Runs every rule on the sources under `root` and on the builds named. The result lists findings (each with a code, a file and a message) and a summary of what
 * was looked at.
 */
export async function checkEdition({ root = DEFAULT_ROOT, publicDist = [], enterpriseDist = [] } = {}) {
  const findings = [];
  const paths = scanned(root).map(toPosix);
  const { manifest, words } = await enterpriseWords(root).catch((error) => {
    findings.push(finding('ENT_MANIFEST_UNREADABLE', MANIFEST, `the enterprise manifest cannot be loaded: ${error instanceof Error ? error.message : String(error)}`));
    return { manifest: undefined, words: [] };
  });
  findings.push(...importFindings(root, paths), ...wordFindings(root, paths, words), ...moduleFindings(root, paths), ...codeNameFindings(root));
  for (const entry of await brandDrift(root)) findings.push(finding('ENT_BRAND_DRIFT', entry.file, entry.message));
  if (manifest !== undefined) findings.push(...webOverlayFindings(root, manifest), ...mobileFindings(root, manifest));
  for (const directory of publicDist) {
    if (!existsSync(directory)) findings.push(finding('ENT_DIST_MISSING', directory, 'the public build to scan does not exist'));
    else {
      for (const hit of distHits(directory, words)) findings.push(finding('ENT_DIST_HOLDS_ENTERPRISE', directory, `the public build carries "${hit}"`));
      for (const hit of distCodeNameHits(directory)) findings.push(finding('ENT_CODE_NAME_IN_PUBLIC_SURFACE', hit.file, `the public build says the code name as a name: ${hit.line}`));
    }
  }
  for (const directory of enterpriseDist) {
    if (!existsSync(directory)) findings.push(finding('ENT_DIST_MISSING', directory, 'the enterprise build to scan does not exist'));
    else if (words.length > 0 && !distHits(directory, words.slice(0, 1)).includes(words[0])) findings.push(finding('ENT_DIST_LACKS_ENTERPRISE', directory, 'the enterprise build does not carry the enterprise product name: the scan would not tell an enterprise build from a public one'));
  }
  return { findings, summary: { files: paths.length, words: words.length, manifest: manifest !== undefined } };
}

export async function main(argv = process.argv.slice(2), write = (line) => process.stdout.write(`${line}\n`)) {
  const { values } = parseArgs({
    args: argv,
    options: { root: { type: 'string' }, 'public-dist': { type: 'string', multiple: true }, 'enterprise-dist': { type: 'string', multiple: true } },
  });
  const root = values.root === undefined ? DEFAULT_ROOT : resolve(values.root);
  const { findings, summary } = await checkEdition({ root, publicDist: (values['public-dist'] ?? []).map((path) => resolve(path)), enterpriseDist: (values['enterprise-dist'] ?? []).map((path) => resolve(path)) });
  for (const entry of findings) write(`${entry.code}: ${entry.file}: ${entry.message}`);
  if (findings.length > 0) {
    write(`${findings.length} edition finding(s); the public edition must hold nothing of the enterprise edition (plan ENT-0)`);
    return 1;
  }
  write(`The public edition holds nothing of the enterprise edition (${summary.files} files scanned, ${summary.words} enterprise words)`);
  return 0;
}

if (process.argv[1] !== undefined && relative(process.argv[1], fileURLToPath(import.meta.url)) === '') process.exit(await main());
