import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { BASELINE_PATH, RULES, compareToBaseline, countsOf, lintCss, lintHtml, lintRepository, lintTsx, main, sourceFiles } from './a11y-lint.mjs';

const rulesOf = (found) => found.map((item) => item.rule);

test('an image needs alt, and an empty alt is a decoration', () => {
  assert.deepEqual(rulesOf(lintTsx('<img src="a.png" />')), ['A11Y-IMG-ALT']);
  assert.deepEqual(lintTsx('<img src="a.png" alt="" />'), []);
  assert.deepEqual(lintTsx('<img {...props} />'), []);
});

test('a native button needs a type', () => {
  assert.deepEqual(rulesOf(lintTsx('<button onClick={go}>Go</button>')), ['A11Y-BUTTON-TYPE']);
  assert.deepEqual(lintTsx('<button type="button" onClick={go}>Go</button>'), []);
  assert.deepEqual(lintTsx('<button {...rest}>Go</button>'), []);
});

test('a native control needs a name: a label or FormField around it, an id, aria-label, aria-labelledby or title', () => {
  assert.deepEqual(rulesOf(lintTsx('<input type="text" value={v} />')), ['A11Y-CONTROL-NAME']);
  assert.deepEqual(rulesOf(lintTsx('<div><select onChange={f}><option /></select><textarea /></div>')), ['A11Y-CONTROL-NAME', 'A11Y-CONTROL-NAME']);
  for (const named of ['<input id="a" />', '<input aria-label="x" />', '<input aria-labelledby="x" />', '<input title="x" />', '<input type="hidden" />', '<input type="submit" />', '<input {...register} />']) assert.deepEqual(lintTsx(named), [], named);
  assert.deepEqual(lintTsx('<label>Name <input type="text" /></label>'), []);
  assert.deepEqual(lintTsx('<FormField id="a" label="x"><input type="text" /></FormField>'), []);
  assert.deepEqual(rulesOf(lintTsx('<label>Name</label><input type="text" />')), ['A11Y-CONTROL-NAME'], 'the label is closed before the input');
});

test('a click handler on a static element needs a role and a key handler', () => {
  assert.deepEqual(rulesOf(lintTsx('<div onClick={go}>x</div>')), ['A11Y-STATIC-CLICK']);
  assert.deepEqual(rulesOf(lintTsx('<li role="button" onClick={go}>x</li>')), ['A11Y-STATIC-CLICK'], 'a role without a key handler is not enough');
  assert.deepEqual(lintTsx('<li role="button" tabIndex={0} onClick={go} onKeyDown={key}>x</li>'), []);
  assert.deepEqual(lintTsx('<div className="a">x</div>'), []);
});

test('tabIndex is never positive', () => {
  assert.deepEqual(rulesOf(lintTsx('<div tabIndex={2}>x</div>')), ['A11Y-TABINDEX']);
  assert.deepEqual(lintTsx('<div tabIndex={0}>x</div>'), []);
  assert.deepEqual(lintTsx('<div tabIndex={-1}>x</div>'), []);
});

test('a link to a new tab says noopener or noreferrer; an anchor has an href; an svg is hidden or named', () => {
  assert.deepEqual(rulesOf(lintTsx('<a href="x" target="_blank">x</a>')), ['A11Y-BLANK-REL']);
  assert.deepEqual(lintTsx('<a href="x" target="_blank" rel="noopener noreferrer">x</a>'), []);
  assert.deepEqual(lintTsx('<a href="x" target="_blank" rel="noreferrer">x</a>'), []);
  assert.deepEqual(rulesOf(lintTsx('<a onClick={go}>x</a>')), ['A11Y-ANCHOR-HREF']);
  assert.deepEqual(rulesOf(lintTsx('<svg viewBox="0 0 1 1"><path /></svg>')), ['A11Y-SVG-NAME']);
  assert.deepEqual(lintTsx('<svg aria-hidden="true"><path /></svg>'), []);
  assert.deepEqual(lintTsx('<svg role="img" aria-label="x"><path /></svg>'), []);
});

test('an inline style does not fix a width of 600 px or more, and 100vw is only allowed as an upper bound', () => {
  assert.deepEqual(rulesOf(lintTsx('<div style={{ width: 640 }}>x</div>')), ['RSP-FIXED-WIDTH']);
  assert.deepEqual(rulesOf(lintTsx("<div style={{ minWidth: '800px' }}>x</div>")), ['RSP-FIXED-WIDTH']);
  assert.deepEqual(lintTsx('<div style={{ width: 320 }}>x</div>'), []);
  assert.deepEqual(lintTsx('<div style={{ width: `${percent}%` }}>x</div>'), []);
  assert.deepEqual(rulesOf(lintTsx("<div style={{ width: '100vw' }}>x</div>")), ['RSP-VIEWPORT-WIDTH']);
  assert.deepEqual(lintTsx("<div style={{ width: 'min(440px, 100vw)' }}>x</div>"), []);
});

test('the source of a tag with a nested expression is read to its end and the line is right', () => {
  const found = lintTsx(['const a = 1;', '<img', '  src={pick((x) => x > 1 ? { a: 1 } : { b: 2 })}', '/>'].join('\n'));
  assert.deepEqual(found.map((item) => [item.rule, item.line]), [['A11Y-IMG-ALT', 2]]);
});

test('a stylesheet may not remove the focus outline without a replacement', () => {
  assert.deepEqual(rulesOf(lintCss('.a { outline: none; }')), ['A11Y-OUTLINE-NONE']);
  assert.deepEqual(rulesOf(lintCss('.a { outline: 0; }')), ['A11Y-OUTLINE-NONE']);
  assert.deepEqual(lintCss('.a { outline: none; box-shadow: 0 0 0 2px red; }'), []);
  assert.deepEqual(lintCss(".t [role='x'] { outline: none; }\n.t [role='x']:focus-visible { outline: 2px solid red; }"), []);
  assert.deepEqual(rulesOf(lintCss(".t [role='x'] { outline: none; }\n.other:focus-visible { outline: 2px solid red; }")), ['A11Y-OUTLINE-NONE']);
  assert.deepEqual(lintCss('.a { width: min(440px, 100vw); max-width: 100vw; }'), []);
  assert.deepEqual(rulesOf(lintCss('.a { width: 100vw; }')), ['RSP-VIEWPORT-WIDTH']);
});

test('the html shell needs a device-width viewport that allows zoom and a language', () => {
  const good = '<html lang="vi"><head><meta name="viewport" content="width=device-width, initial-scale=1" /></head></html>';
  assert.deepEqual(lintHtml(good), []);
  assert.equal(lintHtml('<html lang="vi"><head></head></html>')[0].snippet, 'no viewport meta');
  assert.equal(lintHtml(good.replace('width=device-width, ', 'width=1024, '))[0].snippet, 'the viewport is not device-width');
  assert.equal(lintHtml(good.replace('initial-scale=1', 'user-scalable=no'))[0].snippet, 'the viewport forbids zoom');
  assert.equal(lintHtml(good.replace('initial-scale=1', 'maximum-scale=1'))[0].snippet, 'the viewport forbids zoom');
  assert.equal(lintHtml(good.replace(' lang="vi"', ''))[0].snippet, 'the html element has no lang');
});

test('counts and the baseline: a finding beyond the allowance is added, an allowance no longer used is fixed', () => {
  const findings = [
    { file: 'a.tsx', rule: 'A11Y-IMG-ALT', line: 1, snippet: 's1' },
    { file: 'a.tsx', rule: 'A11Y-IMG-ALT', line: 9, snippet: 's2' },
    { file: 'b.tsx', rule: 'A11Y-TABINDEX', line: 3, snippet: 's3' },
  ];
  assert.deepEqual(countsOf(findings), { 'A11Y-IMG-ALT': { 'a.tsx': 2 }, 'A11Y-TABINDEX': { 'b.tsx': 1 } });
  assert.deepEqual(compareToBaseline(findings, { violations: { 'A11Y-IMG-ALT': { 'a.tsx': 2 }, 'A11Y-TABINDEX': { 'b.tsx': 1 } } }), { added: [], fixed: [] });
  const strict = compareToBaseline(findings, { violations: { 'A11Y-IMG-ALT': { 'a.tsx': 1, 'gone.tsx': 2 } } });
  assert.deepEqual(strict.added.map((item) => item.snippet), ['s2', 's3'], 'the first of the allowed ones is skipped, the rest are new');
  assert.deepEqual(strict.fixed, [{ rule: 'A11Y-IMG-ALT', file: 'gone.tsx', was: 2, now: 0 }]);
  assert.deepEqual(compareToBaseline([], {}), { added: [], fixed: [] });
});

function makeRoot(files) {
  const root = mkdtempSync(join(tmpdir(), 'a11y-lint-'));
  for (const [path, text] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, text);
  }
  return root;
}

test('sourceFiles reads tsx and css of apps/web/src without tests and without test folders, plus index.html', () => {
  const root = makeRoot({
    'apps/web/src/screens/A.tsx': '<div />',
    'apps/web/src/screens/A.test.tsx': '<img />',
    'apps/web/src/test/helper.tsx': '<img />',
    'apps/web/src/styles/app.css': '.a {}',
    'apps/web/src/node_modules/x.tsx': '<img />',
    'apps/web/src/readme.md': 'x',
    'apps/web/index.html': '<html lang="vi"><meta name="viewport" content="width=device-width"></html>',
  });
  try {
    assert.deepEqual(sourceFiles(root), ['apps/web/src/screens/A.tsx', 'apps/web/src/styles/app.css', 'apps/web/index.html']);
    assert.deepEqual(lintRepository(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('main: a clean tree passes, a new finding fails and says where, --update-baseline accepts it, a fixed one is reported', () => {
  const root = makeRoot({ 'apps/web/src/screens/A.tsx': '<img src="x" />\n', 'apps/web/index.html': '<html lang="vi"><meta name="viewport" content="width=device-width"></html>' });
  try {
    mkdirSync(join(root, 'docs', 'qa'), { recursive: true });
    const lines = [];
    const log = (line) => lines.push(line);
    assert.equal(main([], { log, root }), 1);
    assert.ok(lines.some((line) => line.startsWith('A11Y-IMG-ALT  apps/web/src/screens/A.tsx:1')));
    assert.equal(lines.at(-1), '1 findings, 1 beyond the baseline');
    assert.equal(main(['--update-baseline'], { log, root }), 0);
    assert.equal(main([], { log, root }), 0);
    writeFileSync(join(root, 'apps/web/src/screens/A.tsx'), '<img src="x" alt="" />\n');
    lines.length = 0;
    assert.equal(main(['--list'], { log, root }), 0);
    assert.ok(lines.some((line) => line.startsWith('fixed: A11Y-IMG-ALT in apps/web/src/screens/A.tsx (1 allowed, 0 left)')));
    assert.equal(main(['--nonsense'], { log, root }), 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the committed baseline holds only known rules, and the repository has nothing beyond it', () => {
  const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
  for (const rule of Object.keys(baseline.violations)) assert.ok(rule in RULES, `${rule} is not a rule`);
  assert.deepEqual(Object.keys(baseline.rules), Object.keys(RULES));
  const { added } = compareToBaseline(lintRepository(), baseline);
  assert.deepEqual(added.map((item) => `${item.rule} ${item.file}:${item.line}`), []);
});
