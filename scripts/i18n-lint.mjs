import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const require = createRequire(import.meta.url);
const ts = require('typescript');

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..');
const DEFAULT_LOCALE = 'vi';
const WEB_SOURCE = join('apps', 'web', 'src');
const LOCALES = ['vi', 'en'];
const SKIPPED_DIRECTORIES = new Set(['node_modules', 'dist', 'coverage', 'test']);
// module.screen.action.state: three to five lower-camel segments separated by dots.
const KEY_PATTERN = /^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*){2,4}$/;
// Props whose value is read by people (screen readers, tooltips, empty fields).
const COPY_ATTRIBUTES = new Set(['aria-label', 'aria-description', 'aria-roledescription', 'title', 'placeholder', 'alt']);
const HAS_LETTER = /\p{L}/u;

function loadMessages(locale) {
  return JSON.parse(readFileSync(join(SCRIPT_DIR, 'messages', `${locale}.json`), 'utf8'));
}

function format(template, params) {
  return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match));
}

function loadCatalogue(webSource, locale) {
  const path = join(webSource, 'i18n', `${locale}.json`);
  const value = JSON.parse(readFileSync(path, 'utf8'));
  const flat = typeof value === 'object' && value !== null && !Array.isArray(value) && Object.values(value).every((entry) => typeof entry === 'string');
  if (!flat) throw new Error(`${locale}.json must be a flat object of strings keyed by module.screen.action.state`);
  return value;
}

function* sourceFiles(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) yield* sourceFiles(path);
    else if (/\.tsx?$/.test(entry.name) && !/\.(test|spec|d)\.tsx?$/.test(entry.name)) yield path;
  }
}

const isStringLike = (node) => ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node);
const isTranslateCall = (node) =>
  ts.isCallExpression(node) &&
  ((ts.isIdentifier(node.expression) && node.expression.text === 't') ||
    (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 't'));

const LOGICAL_BOTH = new Set([ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken]);

/**
 * The string expressions whose value a person reads, found through the shapes that pass a value on unchanged:
 * conditional branches, the result side of && and both sides of || and ??, parentheses and type assertions.
 * Calls (t(), map(), filter()), comparisons and property access are not followed: what they hold is not copy.
 */
function copyExpressions(node) {
  if (isStringLike(node)) return HAS_LETTER.test(node.text) ? [node] : [];
  if (ts.isTemplateExpression(node)) {
    const parts = [node.head.text, ...node.templateSpans.map((span) => span.literal.text)];
    return parts.some((part) => HAS_LETTER.test(part)) ? [node] : [];
  }
  if (ts.isConditionalExpression(node)) return [...copyExpressions(node.whenTrue), ...copyExpressions(node.whenFalse)];
  if (ts.isBinaryExpression(node)) {
    const kind = node.operatorToken.kind;
    if (kind === ts.SyntaxKind.AmpersandAmpersandToken) return copyExpressions(node.right);
    if (LOGICAL_BOTH.has(kind)) return [...copyExpressions(node.left), ...copyExpressions(node.right)];
    return [];
  }
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node) || ts.isSatisfiesExpression(node)) {
    return copyExpressions(node.expression);
  }
  return [];
}

// Collects the translation keys a file looks up and the user-facing text it hard-codes.
function scanFile(file, text) {
  const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  const keys = [];
  const dynamic = [];
  const literals = [];
  const literal = (position, what) => literals.push({ position, line: source.getLineAndCharacterOfPosition(position).line + 1, what });

  const visit = (node) => {
    if (isTranslateCall(node) && node.arguments.length > 0) {
      const lookups = (expression) => {
        // t(cond ? 'a.b.c.d' : 'a.b.c.e'): both branches are keys the screen looks up.
        if (isStringLike(expression)) keys.push(expression.text);
        else if (ts.isTemplateExpression(expression)) dynamic.push({ head: expression.head.text, tail: expression.templateSpans[expression.templateSpans.length - 1].literal.text });
        else if (ts.isConditionalExpression(expression)) [expression.whenTrue, expression.whenFalse].forEach(lookups);
        else if (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression) || ts.isNonNullExpression(expression) || ts.isSatisfiesExpression(expression)) lookups(expression.expression);
      };
      lookups(node.arguments[0]);
    } else if (ts.isJsxText(node)) {
      if (HAS_LETTER.test(node.text)) literal(node.pos + (node.text.length - node.text.trimStart().length), 'text');
    } else if (ts.isJsxExpression(node) && node.expression && (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent))) {
      for (const found of copyExpressions(node.expression)) literal(found.getStart(source), 'text');
    } else if (ts.isJsxAttribute(node) && COPY_ATTRIBUTES.has(node.name.getText(source)) && node.initializer) {
      const value = ts.isJsxExpression(node.initializer) ? node.initializer.expression : node.initializer;
      if (value && copyExpressions(value).length > 0) literal(node.getStart(source), node.name.getText(source));
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { keys, dynamic, literals: literals.sort((a, b) => a.position - b.position) };
}

/**
 * Checks apps/web against the translation rules: every key looked up with t('module.screen.action.state')
 * exists in both catalogues (missing), every catalogue key is used (unused), every key has the shape
 * module.screen.action.state (badKeys) and no JSX text or copy attribute is a string literal (literals).
 * A template key such as t(`error.${code}.title.label`) marks the catalogue keys with that head and tail as used.
 */
export async function i18nCheck(root) {
  const webSource = join(root, WEB_SOURCE);
  const result = { missing: [], unused: [], badKeys: [], literals: [] };
  if (!existsSync(join(webSource, 'i18n'))) return result;

  const catalogues = Object.fromEntries(LOCALES.map((locale) => [locale, loadCatalogue(webSource, locale)]));
  const used = new Set();
  const dynamic = [];
  for (const file of sourceFiles(webSource)) {
    const scanned = scanFile(file, readFileSync(file, 'utf8'));
    scanned.keys.forEach((key) => used.add(key));
    dynamic.push(...scanned.dynamic);
    const name = relative(root, file).split(sep).join('/');
    for (const found of scanned.literals) result.literals.push(`${name}:${found.line} ${found.what}`);
  }

  const catalogueKeys = new Set(LOCALES.flatMap((locale) => Object.keys(catalogues[locale])));
  const everyKey = [...new Set([...used, ...catalogueKeys])].sort();
  for (const key of everyKey) {
    for (const locale of LOCALES) if (!(key in catalogues[locale])) result.missing.push(`${key} [${locale}]`);
    if (!KEY_PATTERN.test(key)) result.badKeys.push(key);
  }
  const matchesDynamic = (key) => dynamic.some(({ head, tail }) => key.length >= head.length + tail.length && key.startsWith(head) && key.endsWith(tail));
  result.unused = [...catalogueKeys].filter((key) => !used.has(key) && !matchesDynamic(key)).sort();
  return result;
}

export async function main(argv, { log = console.log } = {}) {
  const { values } = parseArgs({
    args: argv,
    options: { root: { type: 'string', default: REPO_ROOT }, locale: { type: 'string', default: DEFAULT_LOCALE } },
  });
  const messages = loadMessages(values.locale);
  const result = await i18nCheck(resolve(values.root));
  for (const key of result.missing) log(format(messages['i18n.missing'], { key }));
  for (const key of result.unused) log(format(messages['i18n.unused'], { key }));
  for (const key of result.badKeys) log(format(messages['i18n.badKey'], { key }));
  for (const where of result.literals) log(format(messages['i18n.literal'], { where }));
  const count = result.missing.length + result.unused.length + result.badKeys.length + result.literals.length;
  log(count === 0 ? messages['i18n.summary.pass'] : format(messages['i18n.summary.fail'], { count }));
  return count === 0 ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exitCode = await main(process.argv.slice(2));
}
