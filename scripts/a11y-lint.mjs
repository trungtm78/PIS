import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

/**
 * Accessibility and responsive rules for the screens of the web application, as a lint-like check that needs no browser: it reads the sources of `apps/web/src` (screens, kit, styles) and
 * `apps/web/index.html`, applies the rules below and compares the findings with the baseline `docs/qa/a11y-baseline.json`. A finding that is not in the baseline fails the run, so a new screen has to
 * be clean from its first commit while older code can be cleaned up over time (the baseline only ever shrinks: `--update-baseline` rewrites it, and a finding that was fixed is reported). The rules are
 * a smoke test of what is visible in source (the real measurement is the axe run of `apps/web/e2e/a11y.spec.ts` and the route walk at 390 px); they are exact about what they check and silent about the rest.
 *
 *   node scripts/a11y-lint.mjs [--list] [--update-baseline] [--root <dir>] [--baseline <file>]
 *
 * Exit codes: 0 no finding beyond the baseline; 1 there is one; 2 wrong usage.
 */

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..');
export const BASELINE_PATH = join(REPO_ROOT, 'docs', 'qa', 'a11y-baseline.json');

export const RULES = {
  'A11Y-IMG-ALT': 'an image has an alt attribute (an empty one marks it as decoration)',
  'A11Y-BUTTON-TYPE': 'a native button says its type, so it never submits a form by accident',
  'A11Y-CONTROL-NAME': 'a native input, select or textarea has a name: a label around it, a FormField around it, an id, aria-label, aria-labelledby or title',
  'A11Y-STATIC-CLICK': 'an element that is not interactive and has a click handler also has a role and a key handler',
  'A11Y-TABINDEX': 'tabIndex is never positive (it breaks the order of the page)',
  'A11Y-BLANK-REL': 'a link that opens a new tab says rel="noopener" (noreferrer implies it)',
  'A11Y-SVG-NAME': 'an inline svg is hidden from assistive technology or has a name',
  'A11Y-ANCHOR-HREF': 'an anchor has an href (otherwise it is a button)',
  'A11Y-OUTLINE-NONE': 'a stylesheet does not remove the focus outline without a visible replacement',
  'RSP-FIXED-WIDTH': 'an inline style does not fix a width of 600 px or more (a phone is 390 px wide)',
  'RSP-VIEWPORT-WIDTH': 'nothing is sized with 100vw (it ignores the scrollbar and overflows)',
  'RSP-VIEWPORT-META': 'the page has a device-width viewport that allows zoom, and a language',
};

// An opening tag: names the tags the rules look at and reads its attributes, braces nested up to three deep (a JSX expression may hold an arrow function or an object).
const TAG = /<(label|\/label|FormField|\/FormField|input|select|textarea|button|img|a|svg|div|span|li|tr|td|p|section|article)\b((?:[^<>{}]|\{[^{}]*(?:\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}[^{}]*)*\})*)>/g;
const STATIC = new Set(['div', 'span', 'li', 'tr', 'td', 'p', 'section', 'article']);
const CONTROLS = new Set(['input', 'select', 'textarea']);
const WIDTH = /\b(?:width|minWidth|min-width)\s*[:=]\s*\{?\s*['"]?(\d+)(?:px)?['"]?/g;

const lineOf = (text, index) => text.slice(0, index).split('\n').length;
const snippet = (text) => text.replace(/\s+/g, ' ').slice(0, 100);

/** The findings of one TSX source: `{ rule, line, snippet }` in the order of the source. */
export function lintTsx(text) {
  const found = [];
  const add = (rule, index, matched) => found.push({ rule, line: lineOf(text, index), snippet: snippet(matched) });
  let labelled = 0;
  for (const match of text.matchAll(TAG)) {
    const [whole, tag, attrs] = match;
    const spread = /\{\s*\.\.\./.test(attrs);
    if (tag === 'label' || tag === 'FormField') {
      labelled += 1;
      continue;
    }
    if (tag === '/label' || tag === '/FormField') {
      labelled = Math.max(0, labelled - 1);
      continue;
    }
    if (tag === 'img' && !/\balt=/.test(attrs) && !spread) add('A11Y-IMG-ALT', match.index, whole);
    if (tag === 'button' && !/\btype=/.test(attrs) && !spread) add('A11Y-BUTTON-TYPE', match.index, whole);
    if (CONTROLS.has(tag) && labelled === 0 && !spread && !/\b(aria-label|aria-labelledby|title|id)=/.test(attrs) && !/\btype="(hidden|submit|button|reset|image)"/.test(attrs)) add('A11Y-CONTROL-NAME', match.index, whole);
    if (STATIC.has(tag) && /\bonClick=/.test(attrs) && !(/\brole=/.test(attrs) && /\bonKey(Down|Up|Press)=/.test(attrs))) add('A11Y-STATIC-CLICK', match.index, whole);
    if (/\btabIndex=\{?\s*[1-9]/.test(attrs)) add('A11Y-TABINDEX', match.index, whole);
    if (/\btarget=["']_blank["']/.test(attrs) && !/\brel=["'][^"']*(noopener|noreferrer)/.test(attrs) && !spread) add('A11Y-BLANK-REL', match.index, whole);
    if (tag === 'svg' && !/\b(aria-hidden|aria-label|aria-labelledby|role)=/.test(attrs) && !spread) add('A11Y-SVG-NAME', match.index, whole);
    if (tag === 'a' && !/\bhref=/.test(attrs) && !spread) add('A11Y-ANCHOR-HREF', match.index, whole);
    if (/\bstyle=\{\{/.test(attrs)) {
      for (const width of attrs.matchAll(WIDTH)) if (Number(width[1]) >= 600) add('RSP-FIXED-WIDTH', match.index, whole);
    }
  }
  for (const match of text.matchAll(/\b100vw\b/g)) if (!boundedViewport(text, match.index)) add('RSP-VIEWPORT-WIDTH', match.index, match[0]);
  return found.sort((a, b) => a.line - b.line);
}

/** A 100vw that is only an upper bound (inside min(), or the value of max-width) cannot make the page wider than the screen. */
function boundedViewport(text, index) {
  const before = text.slice(text.lastIndexOf('\n', index) + 1, index);
  return /\bmin\([^)]*$/.test(before) || /\bmax-width\s*:\s*$/.test(before) || /\bmaxWidth\s*[:=]\s*\{?['"]?$/.test(before);
}

/** The findings of one stylesheet. */
export function lintCss(text) {
  const found = [];
  const rules = [...text.matchAll(/([^{}]*)\{([^{}]*)\}/g)];
  const focusRules = rules.map((rule) => rule[1].trim()).filter((selector) => /:focus(-visible|-within)?\b/.test(selector));
  for (const match of rules) {
    const [, selector, body] = match;
    const removes = /\boutline\s*:\s*(none|0)\b/.test(body);
    // A replacement is a box-shadow or a border in the same rule, or another rule for the same element in its focus state.
    const subject = selector.trim().split(',').map((part) => part.trim());
    const replaces = /\b(box-shadow|border)\b/.test(body) || subject.every((part) => focusRules.some((focus) => focus.startsWith(part)));
    if (removes && !replaces) found.push({ rule: 'A11Y-OUTLINE-NONE', line: lineOf(text, match.index + selector.length), snippet: snippet(`${selector.trim()} { ${body.trim()} }`) });
  }
  for (const match of text.matchAll(/\b100vw\b/g)) if (!boundedViewport(text, match.index)) found.push({ rule: 'RSP-VIEWPORT-WIDTH', line: lineOf(text, match.index), snippet: '100vw' });
  return found.sort((a, b) => a.line - b.line);
}

/** The findings of the HTML shell of the application. */
export function lintHtml(text) {
  const found = [];
  const viewport = /<meta\s+name=["']viewport["']\s+content=["']([^"']*)["']/i.exec(text);
  if (viewport === null) found.push({ rule: 'RSP-VIEWPORT-META', line: 1, snippet: 'no viewport meta' });
  else {
    const content = viewport[1];
    if (!/width=device-width/.test(content)) found.push({ rule: 'RSP-VIEWPORT-META', line: lineOf(text, viewport.index), snippet: 'the viewport is not device-width' });
    if (/user-scalable\s*=\s*(no|0)|maximum-scale\s*=\s*1(\.0)?\b/.test(content)) found.push({ rule: 'RSP-VIEWPORT-META', line: lineOf(text, viewport.index), snippet: 'the viewport forbids zoom' });
  }
  if (!/<html\b[^>]*\blang=/i.test(text)) found.push({ rule: 'RSP-VIEWPORT-META', line: 1, snippet: 'the html element has no lang' });
  return found;
}

const SKIP_DIRECTORIES = new Set(['node_modules', 'dist', 'coverage', 'test', '__snapshots__']);

/** The files the rules read, as root-relative posix paths: the tsx and css sources of `apps/web/src` (not tests) and `apps/web/index.html`. */
export function sourceFiles(root) {
  const files = [];
  const walk = (directory) => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      if (statSync(path).isDirectory()) {
        if (!SKIP_DIRECTORIES.has(name)) walk(path);
      } else if (/\.(tsx|css)$/.test(name) && !/\.test\./.test(name)) {
        files.push(relative(root, path).split('\\').join('/'));
      }
    }
  };
  const source = join(root, 'apps', 'web', 'src');
  if (existsSync(source)) walk(source);
  if (existsSync(join(root, 'apps', 'web', 'index.html'))) files.push('apps/web/index.html');
  return files;
}

/** All findings of the repository: `{ file, rule, line, snippet }`. */
export function lintRepository(root = REPO_ROOT) {
  const out = [];
  for (const file of sourceFiles(root)) {
    const text = readFileSync(join(root, file), 'utf8');
    const found = file.endsWith('.tsx') ? lintTsx(text) : file.endsWith('.css') ? lintCss(text) : lintHtml(text);
    for (const item of found) out.push({ file, ...item });
  }
  return out;
}

/** The findings as counts by rule and file: the shape of the baseline. */
export function countsOf(findings) {
  const counts = {};
  for (const item of findings) {
    counts[item.rule] ??= {};
    counts[item.rule][item.file] = (counts[item.rule][item.file] ?? 0) + 1;
  }
  const sorted = {};
  for (const rule of Object.keys(counts).sort()) {
    sorted[rule] = {};
    for (const file of Object.keys(counts[rule]).sort()) sorted[rule][file] = counts[rule][file];
  }
  return sorted;
}

/** What is new against the baseline (a finding in a file beyond its allowance) and what was fixed (an allowance that is no longer used). */
export function compareToBaseline(findings, baseline) {
  const allowed = baseline.violations ?? {};
  const now = countsOf(findings);
  const added = [];
  const fixed = [];
  for (const [rule, files] of Object.entries(now)) {
    for (const [file, count] of Object.entries(files)) {
      const allowance = allowed[rule]?.[file] ?? 0;
      if (count > allowance) added.push(...findings.filter((item) => item.rule === rule && item.file === file).slice(allowance));
    }
  }
  for (const [rule, files] of Object.entries(allowed)) {
    for (const [file, allowance] of Object.entries(files)) {
      const count = now[rule]?.[file] ?? 0;
      if (count < allowance) fixed.push({ rule, file, was: allowance, now: count });
    }
  }
  return { added, fixed };
}

const USAGE = 'usage: node scripts/a11y-lint.mjs [--list] [--update-baseline] [--root <dir>] [--baseline <file>]';

export function main(argv, { log = console.log, root = REPO_ROOT } = {}) {
  let values;
  try {
    ({ values } = parseArgs({ args: argv, options: { list: { type: 'boolean', default: false }, 'update-baseline': { type: 'boolean', default: false }, root: { type: 'string' }, baseline: { type: 'string' } } }));
  } catch {
    log(USAGE);
    return 2;
  }
  const base = values.root === undefined ? root : resolve(values.root);
  const baselinePath = values.baseline === undefined ? join(base, 'docs', 'qa', 'a11y-baseline.json') : resolve(values.baseline);
  const findings = lintRepository(base);
  if (values['update-baseline']) {
    writeFileSync(baselinePath, `${JSON.stringify({ version: 1, rules: RULES, violations: countsOf(findings) }, null, 2)}\n`);
    log(`baseline written: ${findings.length} findings in ${new Set(findings.map((item) => item.file)).size} files`);
    return 0;
  }
  let baseline = { violations: {} };
  if (existsSync(baselinePath)) baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
  if (values.list) for (const item of findings) log(`${item.rule}  ${item.file}:${item.line}  ${item.snippet}`);
  const { added, fixed } = compareToBaseline(findings, baseline);
  for (const item of added) log(`${item.rule}  ${item.file}:${item.line}  ${RULES[item.rule]}\n    ${item.snippet}`);
  for (const item of fixed) log(`fixed: ${item.rule} in ${item.file} (${item.was} allowed, ${item.now} left): run --update-baseline to keep the gain`);
  log(`${findings.length} findings, ${added.length} beyond the baseline`);
  return added.length === 0 ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exitCode = main(process.argv.slice(2));
}
